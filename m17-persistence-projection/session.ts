/**
 * m17 · 持久化与投影 — 事件溯源 Session
 *
 * 对应 Python s18 的 `Session` 与 `ProjectionCache`，以及真实工程
 * `packages/session/session`（事件溯源）+ `session-projection-cache`（带 watermark 的增量 fold）。
 *
 * 核心原则（s18 的标题）：**一条流，所有视图**。
 *   - 事实（事件）只持久化一次，且只追加；
 *   - model history / transcript / dashboard 都是从这同一条流**推导**出来的投影；
 *   - 投影是可丢弃的加速层，删掉它重放事件流即可重建（不能依赖隐藏状态）。
 *   - 序列号属于 Session，不属于存储；冷恢复必须验证「字段齐全 + seq 连续无缺口」。
 */

export type EventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'session/title'
  | 'session/status'
  | 'request/header'

/** 一条已接受的事件（事实）。与真实工程 SessionEvent 同构：schema/seq/time/type/data。 */
export interface SessionEvent {
  schema: 1
  seq: number
  time: number
  type: EventType
  data: Record<string, any>
}

export type Observer = (event: SessionEvent) => void

export class Session {
  readonly events: SessionEvent[] = []
  private observers: Observer[] = []

  /** 当前下一个 seq（= 已接受事件数）。 */
  get nextSeq(): number {
    return this.events.length
  }

  /** 订阅已接受事件（持久化 consumer 就挂在这里）。返回取消订阅函数。 */
  observe(observer: Observer): () => void {
    this.observers.push(observer)
    return () => {
      const i = this.observers.indexOf(observer)
      if (i >= 0) this.observers.splice(i, 1)
    }
  }

  /**
   * 追加一条事实：分配 seq → 校验（字段/连续）→ 提交内存 → 通知 observers。
   * observers 拿到的是「运行时已接受」的快照。
   */
  append(type: EventType, data: Record<string, any>): SessionEvent {
    const event: SessionEvent = {
      schema: 1,
      seq: this.nextSeq,
      time: Date.now(),
      type,
      data: JSON.parse(JSON.stringify(data)),
    }
    this.validate(event, event.seq)
    this.events.push(event)
    const snapshot: SessionEvent = JSON.parse(JSON.stringify(event))
    for (const ob of [...this.observers]) ob(snapshot)
    return snapshot
  }

  /** 从持久化行重放水合（冷恢复）：与 append 走同一套校验，seq 必须连续。 */
  hydrate(rows: SessionEvent[]): void {
    for (const row of rows) {
      this.validate(row, this.nextSeq)
      this.events.push(JSON.parse(JSON.stringify(row)))
    }
  }

  /** 校验一条事件：字段齐全、schema=1、seq 等于期望（连续无缺口）。 */
  private validate(event: SessionEvent, expectedSeq: number): void {
    const fields = new Set(Object.keys(event))
    if (!['schema', 'seq', 'time', 'type', 'data'].every((f) => fields.has(f))) {
      throw new Error(`invalid event fields at seq ${expectedSeq}`)
    }
    if (event.schema !== 1) throw new Error(`unsupported schema at seq ${expectedSeq}`)
    if (event.seq !== expectedSeq) {
      throw new Error(`non-contiguous seq: expected ${expectedSeq}, got ${event.seq}`)
    }
    if (typeof event.time !== 'number') throw new Error(`invalid time at seq ${expectedSeq}`)
    if (typeof event.type !== 'string' || typeof event.data !== 'object') {
      throw new Error(`invalid event payload at seq ${expectedSeq}`)
    }
  }

  /** 推导 model history（只取 user/assistant 消息，其它事实不混入聊天）。 */
  deriveMessages(): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = []
    for (const e of this.events) {
      if (e.type === 'user/message') out.push({ role: 'user', content: String(e.data.content) })
      else if (e.type === 'assistant/message') out.push({ role: 'assistant', content: String(e.data.content) })
    }
    return out
  }
}

/**
 * 投影缓存（可丢弃的加速层，非真相）。
 * 一次 fold 出两个非 model 视图：transcript 与 dashboard。
 * watermark 保证增量 fold：只处理 seq > watermark 的事件，且要求严格连续（见 s18）。
 */
export class ProjectionCache {
  transcript: string[] = []
  latestTitle: string | null = null
  toolCount = 0
  status = 'new'
  watermark = -1

  static empty(): ProjectionCache {
    return new ProjectionCache()
  }

  /** 折叠一批事件：仅消费 watermark 之后的、且 seq 严格连续的事件。 */
  fold(events: SessionEvent[]): void {
    for (const e of events) {
      if (e.seq <= this.watermark) continue
      if (e.seq !== this.watermark + 1) {
        throw new Error(`projection fold received a sequence gap at seq ${e.seq}`)
      }
      switch (e.type) {
        case 'user/message':
          this.transcript.push('User: ' + e.data.content)
          break
        case 'assistant/message':
          this.transcript.push('Assistant: ' + e.data.content)
          break
        case 'session/title':
          this.latestTitle = e.data.title
          break
        case 'tool/result':
          this.toolCount += 1
          break
        case 'session/status':
          this.status = e.data.status
          break
        case 'request/header':
          break // header 事实不进入 transcript/dashboard，但属于真相流
      }
      this.watermark = e.seq
    }
  }
}
