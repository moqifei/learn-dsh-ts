/**
 * m16 · 上下文压缩 — 事件溯源的 Session
 *
 * 对应真实工程 `dsh-session-basic` 的 Session，以及 Python s17 的 `Session`：
 *   - events: Event[]   只追加（append-only）的对话事件流（工具调用、结果、消息…），
 *                       是唯一的"真相源"，压缩永远不动它；
 *   - surface: string   当前要喂给模型的"最小上下文窗口"，是 events 的一个可替换投影；
 *                       压缩 = 用 summary 事件替换 surface 里"过期但被保留"的那一段。
 *
 * 这样设计让"压缩"变成一次局部替换，而不是"丢失历史"。
 */

export type Event =
  | { seq: number; type: 'message'; role: string; content: string }
  | { seq: number; type: 'tool'; name: string; call: string }
  | { seq: number; type: 'result'; tool: string; payload: string }
  | { seq: number; type: 'summary'; summary: string }

export class Session {
  /** 只追加事件流（真相源） */
  readonly events: Event[] = []
  /** 当前上下文窗口投影（可替换） */
  surface: string = ''
  private seq = 0

  private push(ev: any): Event {
    const full = { ...ev, seq: this.seq++ } as Event
    this.events.push(full)
    return full
  }

  message(role: string, content: string): Event {
    const ev = this.push({ type: 'message', role, content })
    this.surface += `msg(${role}): ${content}\n`
    return ev
  }

  tool(name: string, call: string): Event {
    const ev = this.push({ type: 'tool', name, call })
    this.surface += `tool(${name}): ${call}\n`
    return ev
  }

  result(tool: string, payload: string): Event {
    const ev = this.push({ type: 'result', tool, payload })
    this.surface += `result(${tool}): ${payload}\n`
    return ev
  }

  /**
   * 追加一条 summary 事件（压缩产物），并把 surface 替换为压缩后的窗口。
   * 注意：events 数组里前面的事件仍保留（真相不丢），只是 surface 变了。
   */
  applySummary(summary: string, compressedSurface: string): Event {
    const ev = this.push({ type: 'summary', summary })
    this.surface = compressedSurface
    return ev
  }

  /** events 追加字节数（粗略 UTF-8 估算，对应真实工程的 pressure 估算） */
  pressureBytes(): number {
    return this.events
      .map((e) => JSON.stringify(e).length)
      .reduce((a, b) => a + b, 0)
  }
}
