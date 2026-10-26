/** 插件层配置（profile 的 cordis.patch.yml 覆盖）。 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** watch 根目录列表（绝对路径）；为空时插件不轮询。 */
  specDirs: z.array(z.string()).default([]),
  /** 主时钟周期（只做时间比较，不执行检查）。 */
  tickMs: z.number().step(1).min(100).default(1000),
  /** 同一目标会话的触发合并窗口。 */
  batchWindowMs: z.number().step(1).min(0).default(2000),
  /** 同时运行的检测程序上限。 */
  maxConcurrentChecks: z.number().step(1).min(1).max(16).default(4),
  /** 帧内证据上限（同时作为 stdout 收集上限）。 */
  maxEvidenceBytes: z.number().step(1).min(512).default(8192),
  /** 失败帧附带的 stderr 行数。 */
  maxStderrLines: z.number().step(1).min(0).default(20),
  /** 日志保留天数。 */
  logRetentionDays: z.number().step(1).min(1).default(14),
  /** 单个 watch 的日志总量上限。 */
  logMaxBytesPerWatch: z.number().step(1).min(1048576).default(20971520),
  /** 投递失败后的重试间隔。 */
  deliveryRetryMs: z.number().step(1).min(100).default(30000),
  /** 检测到脚本变化后，等待多久再通知 agent（给"编辑后立即 watch_validate"留出窗口）。 */
  integrityNotifyDelayMs: z.number().step(1).min(0).default(5000),
})
