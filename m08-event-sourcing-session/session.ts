/**
 * m08 · 事件溯源 Session —— 会话"真相"
 *
 * `Session` 不持有可变的消息数组，也不持有可变的统计对象。它只持有
 * `events: SessionEvent[]`，并且这个数组是 append-only 的（日志）。
 * 任何可见状态（聊天消息、统计）都通过纯折叠得到。
 *
 * 对齐 deepseek-harness 真实 `Session`（`packages/core/session`）的核心不变量：
 *   1. **只追加**：`append` 强制 `seq === 当前日志长度`，下标即序号，绝不回退；
 *   2. **整值快照**：`append` 时深拷贝 `data`（JSON），调用方手里的可变对象
 *      后续怎么改都不影响日志——真相是发布那一刻的不可变快照；
 *   3. **派生纯函数**：`deriveMessages()` / `deriveStats()` 对日志做 fold，
 *      同日志 ⇒ 同结果；`restore` 只是把一份已有的日志灌进来再派生。
 *   4. **事件总线出口**：`onAppend` 订阅，projection / telemetry 都挂在这。
 *
 * 真实实现把"派生"抽象成 `ProjectionDefinition`（init/apply/view 三纯函数
 * + stateVersion），并把每个视图做成独立可插拔单元；本课直接把两个视图写成
 * 方法，结构同构、更直观。
 */

import type { ChatMessage, SessionEvent, SessionStats } from './events.ts'

export type { SessionEvent } from './events.ts'

/** 深拷贝事件 data，保证日志是不可变快照（对齐真实 append 的 JSON 校验/冻结）。 */
function snapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

export class Session {
  /** 会话唯一 id。 */
  readonly id: string
  /** 唯一真相：append-only 事件日志。下标即 seq。 */
  private readonly log: SessionEvent[] = []
  /** 订阅事件被追加的监听器（事件溯源的"事件总线"输出口）。 */
  private readonly subscribers = new Set<(e: SessionEvent) => void>()

  constructor(id: string, seed?: readonly SessionEvent[]) {
    this.id = id
    if (seed) for (const e of seed) this.append(e) // 恢复/分叉 = 灌入已有日志
  }

  /** 当前日志长度（= 下一条事件的 seq）。 */
  get seq(): number {
    return this.log.length
  }

  /** 只读快照日志（调用方据此做任意折叠，但不要改它）。 */
  get events(): readonly SessionEvent[] {
    return this.log
  }

  /**
   * 追加一条事件。调用方负责填好 `seq`（= 当前 `this.seq`）与时间戳；
   * 这里只做"只追加不修改"的强制约束 + 深拷贝快照，并通知订阅者。
   * @param event - 已带好 seq / time 的事件（data 会被拷贝）。
   */
  append(event: SessionEvent): void {
    if (event.seq !== this.log.length) {
      throw new Error(
        `Session.append: seq 必须严格等于当前日志长度 ${this.log.length}，收到 ${event.seq}`,
      )
    }
    const frozen: SessionEvent = { ...event, data: snapshot(event.data) } as SessionEvent
    this.log.push(frozen)
    for (const fn of this.subscribers) fn(frozen)
  }

  /** 订阅事件追加；返回取消订阅函数。 */
  onAppend(fn: (e: SessionEvent) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /**
   * 投影①：折叠整条日志，派生"聊天消息"视图。
   *
   * 折叠规则（纯函数、无副作用）：
   *   - `user/message`        → 一条 user 消息
   *   - `assistant/chunk`     → 按 (turn,step) 累积流式缓冲
   *   - `assistant/message`   → 定稿该 step 的缓冲为一条 assistant 消息（带 usage）
   *   - `tool/call` / `tool/result` → 各成一条 tool 消息（callId 配对）
   *   - `turn/start|end|step/start|request/header` → 仅元数据，不进消息视图
   *
   * 状态完全由日志决定：恢复会话 = 灌入同一份日志再派生，无需单独存消息数组。
   */
  deriveMessages(): ChatMessage[] {
    const out: ChatMessage[] = []
    const buffer = new Map<string, string>() // key = `${turn}:${step}`

    for (const e of this.log) {
      switch (e.type) {
        case 'user/message':
          out.push({ role: 'user', turn: e.data.turn, parts: [{ type: 'text', text: e.data.content }] })
          break
        case 'assistant/chunk':
          {
            const key = `${e.data.turn}:${e.data.step}`
            buffer.set(key, (buffer.get(key) ?? '') + e.data.delta)
          }
          break
        case 'assistant/message':
          {
            const key = `${e.data.turn}:${e.data.step}`
            const text = e.data.text || buffer.get(key) || ''
            out.push({ role: 'assistant', turn: e.data.turn, parts: [{ type: 'text', text }] })
            buffer.delete(key)
          }
          break
        case 'tool/call':
          out.push({
            role: 'tool',
            turn: e.data.turn,
            callId: e.data.callId,
            parts: [{ type: 'text', text: `call ${e.data.name}(${e.data.arguments})` }],
          })
          break
        case 'tool/result':
          out.push({
            role: 'tool',
            turn: e.data.turn,
            callId: e.data.callId,
            parts: [{ type: 'text', text: `→ ${e.data.output}` }],
          })
          break
        // 边界 / 元数据事件：不进入消息视图
        case 'turn/start':
        case 'turn/end':
        case 'step/start':
        case 'request/header':
          break
      }
    }
    return out
  }

  /**
   * 投影②：折叠日志，派生"统计"视图（对齐 session-stats）。
   *
   *   - `turns`  = turn/start 次数
   *   - `steps`  = step/start 次数
   *   - `ttftMs` = 每个 step 首个 assistant/chunk 相对其 step/start 的延迟之和
   *   - `toolMs` = 每个 tool/result 相对同名 tool/call 的耗时之和
   */
  deriveStats(): SessionStats {
    let turns = 0
    let steps = 0
    let ttftMs = 0
    let toolMs = 0

    const stepStart = new Map<string, number>() // `${turn}:${step}` → time
    const callStart = new Map<string, number>() // callId → time

    for (const e of this.log) {
      switch (e.type) {
        case 'turn/start':
          turns++
          break
        case 'step/start':
          steps++
          stepStart.set(`${e.data.turn}:${e.data.step}`, e.time)
          break
        case 'assistant/chunk':
          {
            const key = `${e.data.turn}:${e.data.step}`
            if (stepStart.has(key)) {
              ttftMs += e.time - (stepStart.get(key) as number) // 仅首个 chunk 计一次
              stepStart.delete(key)
            }
          }
          break
        case 'tool/call':
          callStart.set(e.data.callId, e.time)
          break
        case 'tool/result':
          {
            const t0 = callStart.get(e.data.callId)
            if (t0 !== undefined) {
              toolMs += e.time - t0
              callStart.delete(e.data.callId)
            }
          }
          break
        default:
          break
      }
    }
    return { turns, steps, ttftMs, toolMs }
  }
}
