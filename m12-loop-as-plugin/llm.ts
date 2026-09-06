/**
 * m12 · Loop 也是插件 · 能力服务（一）：LLM
 * ---------------------------------------------------------------------------
 * 真实工程对照：deepseek-harness `packages/core/agent-default-model` /
 * `packages/core/llm` 的 provider 插件。
 *
 * 真实 Harness 里 LLM 是一个 provider 插件，Loop 通过 `ctx.require('llm')`
 * 拿到"与 provider 无关"的 LLM 服务，从不 import 具体适配器。
 *
 * 课程版用**确定性脚本模型**代替真实 Azure（无需网络即可演示 Loop 编排）：
 * 模型根据"当前 Session 里已有多少工具结果"决定下一步动作——
 *   - 第 1 步：返回一次 tool_call（让 Loop 去执行工具）
 *   - 第 2 步起：返回纯文本（模型自行停止，不再带 tool_calls）
 * 这正好演示了 s13 的核心："模型决定调用哪个工具、何时停止"。
 *
 * 把 `ScriptedLlm` 换成任意真实适配器，AgentLoop 一行都不用改。
 */

import { Context, Service } from '@deepseek-ai/cordis'

export interface ModelToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ModelResponse {
  text: string
  toolCalls: ModelToolCall[]
  finishReason: string
}

export class ScriptedLlm extends Service {
  static inject = [] as const
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'llm')
    void config
  }

  /** 被 AgentLoop 调用。stepIndex 从 0 开始；toolResultsSeen 用于决定行为。 */
  async complete(opts: {
    system: string
    messages: Array<Record<string, unknown>>
    tools: Array<Record<string, unknown>>
  }): Promise<ModelResponse> {
    void opts.system

    const toolNames = opts.tools.map((t) => (t.function as { name: string }).name)
    // 关键：如果会话里已经出现过 tool/result（工具已执行过），模型就自然停止。
    // 这模拟了真实模型"看到工具结果后不再发起调用"的行为——Loop 不硬编码停止。
    const hasToolResult = opts.messages.some((m) => m.role === 'tool')
    if (!hasToolResult && toolNames.includes('echo')) {
      console.log('    🤖 模型：发起工具调用 echo')
      return {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'echo', arguments: { text: 'loop plugin active' } },
        ],
        finishReason: 'tool_calls',
      }
    }

    // 工具结果已回来（或没有可用工具）：模型自行停止（natural stop）
    console.log('    🤖 模型：不再调用工具，给出最终回答')
    return {
      text: 'done: 已通过工具回声验证 loop 作为插件运转正常。',
      toolCalls: [],
      finishReason: 'stop',
    }
  }
}

// 类型增强：把 llm 服务注入上下文
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: ScriptedLlm
  }
}

export default ScriptedLlm
