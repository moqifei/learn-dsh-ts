/**
 * m12 · Loop 也是插件 · 主角：AgentLoop
 * ---------------------------------------------------------------------------
 * 真实工程对照：deepseek-harness `packages/core/agent-loop` 的 AgentLoop 服务。
 *
 * 关键点（s13 的核心思想）：
 *   1. AgentLoop 是一个**普通的插件**（extends Service，通过插件生命周期进入）。
 *   2. 它声明硬依赖：llm / session / prompt / tools（static inject）。
 *      这些依赖通过 cordis 的"服务解析"注入——AgentLoop 绝不 import 任何
 *      具体 LLM 适配器、具体工具实现、具体持久化。
 *   3. 它只做**协调**：编排 turn 与 step 的时间顺序。
 *      - turn  = 从用户输入到"无剩余即时工作"的一次完整对话单元
 *      - step  = 一次模型请求 + 该请求返回的工具调用及其结果
 *   4. 模型自己决定调用哪个工具、何时停止（natural stop）；Loop 不硬编码。
 *
 * 要替换驱动器（workflow runner / goal loop / replay driver），只需提供另一个
 * `agent` 服务，其余能力插件完全不动。
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ScriptedLlm } from './llm.ts'
import type { SessionService } from './session.ts'
import type { PromptService } from './prompt.ts'
import type { ToolRegistry } from './tools.ts'

const MAX_STEPS = 10

export class AgentLoop extends Service {
  // 硬依赖：llm / session / prompt / tools。声明后由 cordis 注入到 ctx。
  static inject = ['llm', 'session', 'prompt', 'tools'] as const

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'agent')
    void config
  }

  /** 跑一个 turn。返回模型最终的自然语言回答。 */
  async run(userInput: string): Promise<string> {
    // 通过服务解析稳定能力（绝不 import 具体实现）
    const llm = this.ctx.llm as ScriptedLlm
    const session = this.ctx.session as SessionService
    const prompt = this.ctx.prompt as PromptService
    const tools = this.ctx.tools as ToolRegistry

    // —— turn 开始：把用户输入作为 Session 事实接收 ——
    session.append('turn/start', { turn: 1 })
    session.append('user/message', { content: userInput })

    let step = 0
    try {
      while (step < MAX_STEPS) {
        step += 1
        // —— step 开始 ——
        session.append('step/start', { turn: 1, step })

        // —— 组装实时请求：渲染 prompt + 投影 session + 取 tool schema ——
        const system = prompt.render()
        const messages = session.messages()
        const schemas = tools.schemas()
        session.append('request/header', {
          provider: 'scripted',
          system,
          tools: schemas.map((s) => (s.function as { name: string }).name),
        })

        // —— 调用与 provider 无关的 LLM 服务 ——
        const response = await llm.complete({ system, messages, tools: schemas })

        // —— 记录 assistant 消息（在工具执行前！模型产出是事实）——
        session.append('assistant/message', {
          content: response.text,
          toolCalls: response.toolCalls,
          finishReason: response.finishReason,
        })

        // —— 模型自行停止：没有 tool_calls 即结束 ——
        if (response.toolCalls.length === 0) {
          session.append('step/end', { turn: 1, step })
          session.append('turn/end', { turn: 1, reason: response.finishReason })
          return response.text
        }

        // —— 通过工具服务执行每个调用 ——
        for (const call of response.toolCalls) {
          session.append('tool/call', {
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
          })
          const result = await tools.execute({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })
          session.append('tool/result', {
            callId: result.callId,
            name: result.name,
            content: String(result.content),
            isError: result.isError,
          })
        }

        // —— step 结束 ——
        session.append('step/end', { turn: 1, step })
      }
      throw new Error(`agent exceeded ${MAX_STEPS} model steps`)
    } catch (err) {
      // 错误边界闭合：打开的 turn 必须收到 turn/end（reason=error）
      session.append('turn/end', {
        turn: 1,
        reason: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agent: AgentLoop
  }
}

export default AgentLoop
