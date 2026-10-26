import assert from 'node:assert/strict'
import test from 'node:test'
import { registerAuthoringSkill } from '../lib/index.js'

test('watch-authoring skill 注册携带 source/content（宿主加载 skill 时强制校验）', () => {
  let spec
  let disposed = false
  const ctx = {
    skills: {
      register(skill) {
        spec = skill
        return () => {
          disposed = true
        }
      },
    },
  }
  const dispose = registerAuthoringSkill(ctx)
  assert.equal(spec.name, 'watch-authoring')
  assert.equal(typeof spec.description, 'string')
  assert.ok(spec.description.length > 0)
  assert.equal(typeof spec.whenToUse, 'string')
  assert.equal(typeof spec.source, 'string', 'source 必须是字符串（否则宿主加载 skill 报错）')
  assert.ok(spec.source.endsWith('skills/watch-authoring/SKILL.md'), spec.source)
  assert.equal(typeof spec.content, 'string')
  assert.match(spec.content, /watch-authoring/)
  dispose()
  assert.equal(disposed, true, 'disposer 必须传递给宿主 effect')
})
