/** 插件配置：轮询间隔 + 配置文件/DB 路径。 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** 轮询间隔（毫秒），默认 10s。 */
  pollIntervalMs: z.number().min(1000).default(10000),
  /** watches.json 的绝对路径；空 = <workspace>/.dsh/watch/watches.json */
  configFile: z.string().default(''),
  /** SQLite 文件绝对路径；空 = <workspace>/.dsh/watch/watch.db */
  dbFile: z.string().default(''),
})
