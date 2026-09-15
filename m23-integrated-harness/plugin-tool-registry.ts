/**
 * m23 · 集成快照 · 插件 `tool-registry`（m10 工具树 + 守卫流水线）
 * 注册 ctx.tools 服务；policy/capability-tools 随后挂守卫与工具。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { ToolRegistry } from './services.ts'

const toolRegistryPlugin: Plugin<Context> = {
  name: 'tool-registry',
  apply(ctx: Context) {
    ctx.plugin(ToolRegistry)
  },
}

export default toolRegistryPlugin
