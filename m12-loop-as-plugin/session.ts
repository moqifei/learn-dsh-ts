/**
 * m12 · Loop 也是插件 · 能力服务（三）：Session（事件溯源）
 * ---------------------------------------------------------------------------
 * 真实工程对照：deepseek-harness `packages/core/session` 的事件溯源 Session。
 *
 * s13 的关键点：Loop **绝不直接追加到 messages[]**。所有模型历史都由 Session
 * 的"事件"派生。每条 assistant 消息、每次 tool 调用/结果，都是一次 append。
 * 这样 UI / 持久化 / 恢复都能从同一份事件流重建。
 *
 * 课程版实现最小可用：append(kind, data) 记录事件；messages() 把事件投影成
 * OpenAI 兼容的 role 序列。
 */

import { Context, Service } from '@deepseek-ai/cordis'

export class SessionService extends Service {
  static inject = [] as const
  private events: Array<{ seq: number; type: string; data: Record<string, unknown> }> = []

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'session')
    void config
  }

  /** 追加一条 Session 事实（event-sourced）。 */
  append(type: string, data: Record<string, unknown>): void {
    this.events.push({ seq: this.events.length, type, data })
    console.log(`    📝 session.append(${type})`)
  }

  /** 把事件投影为 OpenAI 兼容消息（供 LLM 请求使用）。 */
  messages(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const ev of this.events) {
      const d = ev.data
      if (ev.type === 'user/message') {
        out.push({ role: 'user', content: d.content })
      } else if (ev.type === 'assistant/message') {
        const msg: Record<string, unknown> = { role: 'assistant', content: d.content || null }
        if (Array.isArray(d.toolCalls) && d.toolCalls.length) {
          msg.tool_calls = (d.toolCalls as Array<Record<string, unknown>>).map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }))
        }
        out.push(msg)
      } else if (ev.type === 'tool/result') {
        out.push({
          role: 'tool',
          tool_call_id: d.callId,
          content: d.content,
        })
      }
    }
    return out
  }

  /** 调试用：查看原始事件流。 */
  eventsLog(): Array<{ type: string; data: Record<string, unknown> }> {
    return this.events.map((e) => ({ type: e.type, data: e.data }))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    session: SessionService
  }
}

export default SessionService
