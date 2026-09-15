/**
 * m23 · 集成快照 · 插件 `agent-loop`（m12 Loop 即插件）
 * 注册 ctx.agent 服务（其 static inject 声明硬依赖 llm/session/prompt/tools/subagents/external，
 * cordis 等这些就绪再激活）。headless 消费端调用它。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { AgentLoop } from './services.ts'

const agentLoopPlugin: Plugin<Context> = {
  name: 'agent-loop',
  apply(ctx: Context) {
    ctx.plugin(AgentLoop)
  },
}

export default agentLoopPlugin
