/**
 * m12 · Loop 也是插件 · 能力插件装配
 * ---------------------------------------------------------------------------
 * 真实工程对照：s13 的"每个组件都通过挂载接入"。注意挂载顺序与依赖无关——
 * cordis 的 service 解析会等依赖就绪再激活（依赖图激活整张图）。
 *
 * 这里把 LLM / Prompt / Session / Tools / AgentLoop 都做成独立插件，外加一个
 * 工具插件（echo）。
 */

import { Context } from '@deepseek-ai/cordis'
import { ScriptedLlm } from './llm.ts'
import { PromptService } from './prompt.ts'
import { SessionService } from './session.ts'
import { ToolRegistry } from './tools.ts'
import { AgentLoop } from './loop.ts'

export const llmPlugin = {
  name: 'llm-scripted',
  inject: [] as const,
  apply(ctx: Context): void {
    ctx.plugin(ScriptedLlm)
  },
}

export const promptPlugin = {
  name: 'prompt-basic',
  inject: [] as const,
  apply(ctx: Context): void {
    ctx.plugin(PromptService)
  },
}

export const sessionPlugin = {
  name: 'session-memory',
  inject: [] as const,
  apply(ctx: Context): void {
    ctx.plugin(SessionService)
  },
}

export const toolsPlugin = {
  name: 'tools-basic',
  inject: [] as const,
  apply(ctx: Context): void {
    ctx.plugin(ToolRegistry)
  },
}

export const echoToolPlugin = {
  name: 'echo-tool',
  inject: ['tools'] as const,
  apply(ctx: Context): void {
    const tools = ctx.tools as ToolRegistry
    tools.register({
      name: 'echo',
      description: 'Echo back the given text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: (args) => ({ echoed: String(args.text) }),
    })
  },
}

export const agentLoopPlugin = {
  name: 'agent-loop',
  // 硬依赖：llm / session / prompt / tools（声明后由 cordis 注入）
  inject: ['llm', 'session', 'prompt', 'tools'] as const,
  apply(ctx: Context): void {
    ctx.plugin(AgentLoop)
  },
}
