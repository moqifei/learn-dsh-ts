/**
 * m23 · 集成快照 · 插件 `subagent`（m19 子代理能力）
 * 仅注册 ctx.subagents 服务；默认 research Provider 已在 SubagentRuntime 构造内注册。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { SubagentRuntime } from './services.ts'

const subagentPlugin: Plugin<Context> = {
  name: 'subagent',
  apply(ctx: Context) {
    ctx.plugin(SubagentRuntime)
  },
}

export default subagentPlugin
