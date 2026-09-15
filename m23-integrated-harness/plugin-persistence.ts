/**
 * m23 · 集成快照 · 插件 `persistence`（m17 追加落盘 + 冷投影）
 * 注册 ctx.persistence 服务，订阅 session 广播立即落盘；headless 在 teardown 后做冷投影。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { PersistenceService } from './services.ts'

const persistencePlugin: Plugin<Context> = {
  name: 'persistence',
  apply(ctx: Context, config: any) {
    ctx.plugin(PersistenceService, config as { path?: string })
  },
}

export default persistencePlugin
