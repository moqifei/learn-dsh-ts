/**
 * m08 · 事件溯源 Session —— 领域词汇（事件与派生物）
 *
 * 这里的事件词汇 **对齐** deepseek-harness 真实 `SessionEventMap`
 * （`packages/core/session/src/types.ts`）：用 `turn/` + `step/` 边界包裹
 * 消息与工具事件，外加 `request/header`（模型可见、但非消息的元数据）。
 *
 * 真实词汇是 plugin-merge 可扩展的（Provider 插件能往里加新事件类型）；
 * 本课把词汇收窄到能派生出"聊天消息 + 统计"的最小集合，但保留了事件溯源
 * 的全部结构特征：
 *   - 事件是 **整值（whole-value）**：`data` 携带"当时的事实"，不是增量补丁；
 *   - 每条事件带 `seq`（= 日志下标，连续不回退）与 `time`（挂钟毫秒，仅元数据）；
 *   - 消息只是其中一种投影，不是真相。
 *
 * 与 Python 学习材料 s09 同构：s09 用 `turn/start / user/message /
 * request/header / assistant/message / turn/end`，本课把 step 边界也显式化
 * （agent loop 里一个 turn 可含多个 step），更接近 TS 真实实现。
 */

/** 一条派生成交消息的角色（对齐 OpenAI roles 的投影）。 */
export type ChatRole = 'user' | 'assistant' | 'tool'

/** 聊天消息内容块（极简，足以演示派生）。 */
export interface ChatPart {
  readonly type: 'text'
  readonly text: string
}

/**
 * 从事件日志派生出来的"聊天消息"——纯值类型（POD），无方法、不持有日志，
 * 是日志的一个视图而非真相。仅 surface 事件（user/message、assistant/message、
 * tool/result）会进入这个视图。
 */
export interface ChatMessage {
  readonly role: ChatRole
  /** 该消息归属的 turn（用于 fork / 压缩按轮次边界切割）。 */
  readonly turn: number
  readonly parts: readonly ChatPart[]
  /** tool 消息对应的调用 id（用于 call/result 配对展示）。 */
  readonly callId?: string
}

/**
 * 会话事件联合类型（对齐真实 `SessionEventMap` 的判别联合，但 data 内联）。
 * 每条事件：`seq` 连续、`time` 挂钟、`data` 整值。
 */
export type SessionEvent =
  | { seq: number; time: number; type: 'turn/start'; data: { turn: number } }
  | { seq: number; time: number; type: 'turn/end'; data: { turn: number; reason: 'completed' | 'aborted' | 'error' } }
  | { seq: number; time: number; type: 'step/start'; data: { turn: number; step: number } }
  | { seq: number; time: number; type: 'user/message'; data: { turn: number; content: string } }
  | {
      seq: number
      time: number
      type: 'request/header'
      data: { turn: number; step: number; provider: string; model: string; system: string }
    }
  | {
      seq: number
      time: number
      type: 'assistant/chunk'
      data: { turn: number; step: number; delta: string }
    }
  | {
      seq: number
      time: number
      type: 'assistant/message'
      data: { turn: number; step: number; text: string; usage?: { outputTokens: number } }
    }
  | {
      seq: number
      time: number
      type: 'tool/call'
      data: { turn: number; step: number; callId: string; name: string; arguments: string }
    }
  | {
      seq: number
      time: number
      type: 'tool/result'
      data: { turn: number; step: number; callId: string; output: string }
    }

/** 事件类型字面量，供 fold 时做 switch 收窄。 */
export type SessionEventType = SessionEvent['type']

/** 从日志派生的"统计"视图（对齐 session-stats 的 turns/steps/ttftMs）。 */
export interface SessionStats {
  readonly turns: number
  readonly steps: number
  /** 首个 token 延迟合计（毫秒）—— streaming 质量指标。 */
  readonly ttftMs: number
  /** 工具调用→结果耗时合计（毫秒）。 */
  readonly toolMs: number
}
