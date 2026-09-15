/**
 * m23 · 集成快照 · 插件 `session`（m08 事件溯源 Session）
 * 注册 ctx.session 服务；广播 session/event 供 persistence 订阅落盘。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { SessionService } from './services.ts'

const sessionPlugin: Plugin<Context> = {
  name: 'session',
  apply(ctx: Context) {
    ctx.plugin(SessionService)
  },
}

export default sessionPlugin
