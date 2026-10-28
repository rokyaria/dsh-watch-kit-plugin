/** 插件配置：轮询、文件路径，以及运行上限（checker/消息/调度）。 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** 轮询间隔（毫秒），默认 10s。 */
  pollIntervalMs: z.number().min(1000).default(10000),
  /** watches.json 的绝对路径；空 = <dshHome>/watch/watches.json（<dshHome> 默认 ~/.dsh） */
  configFile: z.string().default(''),
  /** SQLite 文件绝对路径；空 = <dshHome>/watch/watch.db */
  dbFile: z.string().default(''),
  /**
   * 运行上限。默认值就是原来写死的常量；留空时全部使用默认值。
   * 上限/下限是护栏，避免把 checker 或消息通道配成不可用的大小。
   */
  limits: z.object({
    checker: z.object({
      /** checker stdout 收集上限（字节）。 */
      maxStdoutBytes: z.number().min(4096).max(4 * 1024 * 1024).step(1).default(65536),
      /** checker stderr 收集上限（字节）。 */
      maxStderrBytes: z.number().min(512).max(1024 * 1024).step(1).default(8192),
      /** checker JSON message 字段上限（字节）。 */
      maxMessageBytes: z.number().min(256).max(4 * 1024 * 1024).step(1).default(8192),
      /** checker JSON error 字段上限（字节）。 */
      maxErrorBytes: z.number().min(64).max(1024 * 1024).step(1).default(2048),
    }),
    message: z.object({
      /** 合并消息最多列出多少个事件。 */
      maxItems: z.number().min(1).max(100).step(1).default(20),
      /** 用户配置的消息字节上限；渲染内部另加 4096B 自留预算（实际布局/消息上限 = 配置值 + 4096B），仍超时优先保事件（下限 8KiB）。 */
      maxBytes: z.number().min(8192).max(4 * 1024 * 1024).step(1).default(16 * 1024),
    }),
    scheduler: z.object({
      /** 单轮 checker 并发数。 */
      maxConcurrentChecks: z.number().min(1).max(16).step(1).default(4),
      /** runs 记录保留天数。 */
      runRetentionDays: z.number().min(1).max(365).step(1).default(7),
      /** 单个 target 投递超时（毫秒），防止 host 挂起卡死轮询。 */
      deliveryTimeoutMs: z.number().min(1000).max(600000).step(1000).default(30000),
    }),
  }),
})
