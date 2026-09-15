/**
 * m23 · 集成快照 · 插件 `policy`（m11 执行前守卫）
 * 仅注册 ctx.policy 服务；文件白名单守卫已在 PolicyService 构造内挂到 ctx.tools 流水线。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { PolicyService } from './services.ts'

const policyPlugin: Plugin<Context> = {
  name: 'policy',
  apply(ctx: Context) {
    ctx.plugin(PolicyService)
  },
}

export default policyPlugin
