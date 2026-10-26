/**
 * v0.2.1 test harness: temp workspaces, real node:sqlite DB helpers, fake host
 * ctx/services (timer/commands/tools/sessionController/subprocess/logger),
 * fake checker results and a fake session whose followup collects wakes.
 * All deterministic: fixed timestamps, no sleeps beyond a few ms.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WatchDB } from '../../lib/db.js'

export const makeTmp = (prefix = 'watch-v021-') => mkdtemp(join(tmpdir(), prefix))
export const cleanup = async (dir) => { if (dir) await rm(dir, { recursive: true, force: true }) }

export function makeLogger() {
  const lines = []
  const push = (level) => (message) => lines.push({ level, message: String(message) })
  return { lines, info: push('info'), warn: push('warn'), error: push('error') }
}

/** A valid watches-table row/entry (checker is the JSON argv string). */
export const watchEntry = (overrides = {}) => ({
  id: 'watch-a',
  checker: JSON.stringify(['bash', '/check.sh']),
  cwd: null,
  intervalMs: 60_000,
  timeoutMs: 30_000,
  target: 'session-1',
  enabled: true,
  ...overrides,
})

/** Open a real WatchDB (DB file path defaults to <dir>/watch.db). */
export function openDb(dir, name = 'watch.db') {
  const file = join(dir, name)
  return { db: new WatchDB(file), file }
}

/** Read rows from a DB file with a separate short-lived connection. */
export function rawQuery(file, sql, ...params) {
  const connection = new DatabaseSync(file)
  try { return connection.prepare(sql).all(...params) } finally { connection.close() }
}

export function rawGet(file, sql, ...params) {
  const connection = new DatabaseSync(file)
  try { return connection.prepare(sql).get(...params) } finally { connection.close() }
}

export function rawRun(file, sql, ...params) {
  const connection = new DatabaseSync(file)
  try { return connection.prepare(sql).run(...params) } finally { connection.close() }
}

export const tableNames = (file) => rawQuery(file, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name)
export const columnNames = (file, table) => rawQuery(file, `PRAGMA table_info(${table})`).map((row) => row.name)

export async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Config file shape from contract §2. */
export function configFile(watches) {
  return { watches }
}

/**
 * Fake subprocess. `script` is an array of results or function(spec, index).
 * Result: {stdout, stderr, exitCode, lossy, spawnError, hang}.
 */
export function makeFakeSubprocess(script = []) {
  const spawns = []
  const spawn = (spec) => {
    spawns.push(spec)
    const result = typeof script === 'function' ? script(spec, spawns.length - 1) : script[spawns.length - 1] ?? {}
    if (result.spawnError !== undefined) throw new Error(result.spawnError)
    let resolveDone
    let settled = false
    const done = new Promise((resolve) => { resolveDone = resolve })
    const finish = (outcome) => {
      if (settled) return
      settled = true
      resolveDone(outcome ?? { exitCode: result.exitCode ?? 0, signal: null })
    }
    const stdout = { text: result.stdout ?? '', lossy: result.lossy === true }
    const stderr = { text: result.stderr ?? '' }
    if (result.hang !== true) queueMicrotask(() => finish())
    return {
      done,
      terminate() { finish({ exitCode: null, signal: 'SIGTERM' }) },
      collected: {
        stdout: { readFrom: () => ({ text: stdout.text, nextOffset: stdout.text.length, lossy: stdout.lossy }) },
        stderr: { readFrom: () => ({ text: stderr.text, nextOffset: stderr.text.length, lossy: false }) },
      },
    }
  }
  return { spawns, spawn }
}

export function messageText(message) {
  if (typeof message === 'string') return message
  const content = message?.content
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n')
  return String(content ?? message?.text ?? '')
}

/**
 * Fake sessionController. resolveAgent returns a collecting agent unless the
 * plan says 'throw'/'error'; list() returns the provided sessions (or a
 * {sessions} wrapper — both are accepted shapes by the tests).
 */
export function makeSession({ sessions = [], failPlan = [] } = {}) {
  const wakes = []
  const resolutions = []
  const lists = []
  const sessionController = {
    async resolveAgent(target) {
      const attempt = resolutions.length + 1
      resolutions.push(target)
      const step = typeof failPlan === 'function' ? failPlan(attempt, target) : failPlan[attempt - 1]
      if (step === 'throw') throw new Error('resolve failed')
      if (step === 'error') return { error: new Error(`session ${target} unavailable`) }
      return { agent: { id: target, followup: (message) => wakes.push({ target, message, text: messageText(message) }) } }
    },
    async list(params, signal) {
      lists.push({ params, signal })
      return { items: sessions }
    },
  }
  return { sessionController, wakes, resolutions, lists }
}

/** Fake host ctx. Records commands/tools/intervals/effects for assertions. */
export function makeHostCtx({ workspace = '/workspace', session = makeSession(), subprocess = makeFakeSubprocess(), logger = makeLogger() } = {}) {
  const state = { commands: [], tools: [], intervals: [], effects: [] }
  const registerCommand = (definition) => { state.commands.push(definition); return () => { definition.disposed = true } }
  const registerTool = (tool) => { state.tools.push(tool); return () => { tool.disposed = true } }
  const interval = (callback, ms) => {
    const entry = { callback, ms, cleared: false }
    state.intervals.push(entry)
    return () => { entry.cleared = true }
  }
  const ctx = {
    logger,
    workingDirectory: { defaultDirectory: workspace },
    commands: { register: registerCommand },
    tools: { register: registerTool },
    sessionController: session.sessionController,
    subprocess,
    timer: { interval, setTimeout: (fn, ms) => setTimeout(fn, ms) },
    interval,
    effect(fn) {
      const dispose = fn()
      state.effects.push(typeof dispose === 'function' ? dispose : () => {})
      return dispose
    },
  }
  const disposeAll = () => {
    for (const effect of [...state.effects].reverse()) {
      try { effect() } catch { /* double dispose */ }
    }
    state.effects.length = 0
  }
  return { ctx, state, session, subprocess, logger, disposeAll }
}

export async function waitFor(predicate, { timeout = 4000, interval = 5 } = {}) {
  const startedAt = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}
