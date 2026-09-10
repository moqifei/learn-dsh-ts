/**
 * m18 · 后台 Job 与 Terminal —— Jobs 服务（Definition / Provider / Consumer 三角色）
 *
 * 设计对齐 deepseek-harness 的 packages/jobs：
 *   - Jobs 是"身份 + 生命周期"的拥有者：负责 mint id、归属鉴权、状态机；
 *   - Producer（subprocess / terminal）拥有"执行资源"：真正去 spawn / 读写终端；
 *   - Consumer（runner 里的实验）是"kind 无关的薄控制器"：只调用 start/list/poll/stop。
 *
 * 本文件只实现 Jobs 服务本身 + 类型契约，不内含任何具体 producer——
 * producer 由 producers.ts 以"插件"形式注入，体现"一切皆为插件"。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context, Events } from '@deepseek-ai/cordis'

// 类型合并：让其它文件能通过 ctx.jobs 访问本服务、能监听 jobs/event 事件。
declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: Jobs
  }
  interface Events {
    'jobs/event': (payload: { id: string; event: JobEvent }) => void
  }
}

// ── 生命周期状态机 ──────────────────────────────────────────────
// running → stopping → killed | completed | failed
export type JobStatus = 'running' | 'stopping' | 'killed' | 'completed' | 'failed'

/** terminal 这类"持久会话"producer 额外暴露的 send 能力。 */
export interface SendCapableHandle extends JobHandle {
  /** 向会话发送一条命令/输入（仅 terminal 这类持久会话有）。 */
  send(text: string): void
}

/** producer 向 Jobs 上报的"执行句柄"——Jobs 不关心内部，只调用 stop()。 */
export interface JobHandle {
  /** 停止执行资源（producer 自行决定 SIGTERM→SIGKILL 等）。 */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
  /** 持续产出输出增量；Consumer 用 poll() 拉取。 */
  next(): Promise<{ chunk: string; done: boolean }>
}

/** producer 注册时提供的"怎么跑这一类任务"的工厂。 */
export interface JobProducer {
  readonly kind: string
  /**
   * 启动一个任务实例。返回 JobHandle 供 Jobs 托管。
   * @param spec 调用方给的任务参数（命令行 / 终端命令等）
   * @param emit 用来向 Jobs 回报状态变化（producer 不直接改 status）
   */
  start(spec: JobSpec, emit: (ev: JobEvent) => void): Promise<JobHandle>
}

export interface JobSpec {
  /** 任务类型，决定使用哪个 producer（'subprocess' | 'terminal' ...）。 */
  kind: string
  /** 人类可读标签，便于 list/poll 时区分。 */
  label: string
  /** producer 特定参数（如命令行字符串 / 终端命令）。 */
  args: Record<string, unknown>
}

export interface JobEvent {
  type: 'output' | 'status' | 'done'
  chunk?: string
  status?: JobStatus
  /** 失败原因 / 退出码。 */
  detail?: string
}

// ── 任务记录（Jobs 拥有的身份 + 生命周期） ───────────────────────
export interface JobRecord {
  id: string
  kind: string
  label: string
  owner: string
  status: JobStatus
  createdAt: number
  finishedAt?: number
  /** 完成/失败/被杀的原因。 */
  result?: string
  handle: JobHandle
  /** 仅持久会话（terminal）有：向会话发送命令。 */
  send?: (text: string) => void
  /** 已完成但未取的增量输出缓存（Consumer 通过 poll 拉取）。 */
  outbox: string[]
}

// ── "一切皆为插件"的注册表：kind → producer ────────────────────
// 注意：producers 是空的。两个 producer 由 producers.ts 通过 ctx.effect
// 调用 jobs.registerProducer() 注入——Jobs 本身不知道有哪些 kind 能跑。
export class Jobs extends Service {
  private readonly producers = new Map<string, JobProducer>()
  private readonly jobs = new Map<string, JobRecord>()
  private seq = 0
  private readonly defaultOwner: string
  private readonly maxConcurrent: number

  constructor(ctx: Context, config: { defaultOwner?: string; maxConcurrent?: number } = {}) {
    super(ctx, 'jobs')
    // config 来自 cordis.yml 该 entry 的 `config` 字段（loader 注入）；缺省用合理默认。
    this.defaultOwner = config?.defaultOwner ?? 'harness'
    this.maxConcurrent = config?.maxConcurrent ?? 8
  }

  /** producer 插件用：把一个 kind 的执行能力注册进来。 */
  registerProducer(producer: JobProducer): () => void {
    this.producers.set(producer.kind, producer)
    return () => {
      // 卸载 producer 插件时，cordis 会调用此 disposer：移除 kind。
      this.producers.delete(producer.kind)
    }
  }

  /** 归属者当前在跑的任务数。 */
  private ownedRunning(owner: string): number {
    let n = 0
    for (const j of this.jobs.values()) if (j.owner === owner && j.status === 'running') n++
    return n
  }

  /**
   * Consumer 入口：启动一个后台任务。
   * @returns job id（Consumer 之后用 id 去 list/poll/stop）
   * @throws 当 kind 未注册、或超出归属者并发上限
   */
  async start(spec: JobSpec, owner: string = this.defaultOwner): Promise<string> {
    const producer = this.producers.get(spec.kind)
    if (!producer) throw new Error(`[jobs] 未知 kind="${spec.kind}"（producer 未注册）`)
    if (this.ownedRunning(owner) >= this.maxConcurrent) {
      throw new Error(`[jobs] 归属者 "${owner}" 并发超限（${this.maxConcurrent}）`)
    }

    const id = `job_${++this.seq}`
    // 先登记"running"身份，再让 producer 真正启动（身份先于执行）。
    const record: JobRecord = {
      id, kind: spec.kind, label: spec.label, owner,
      status: 'running', createdAt: Date.now(),
      handle: undefined as unknown as JobHandle, outbox: [],
    }
    this.jobs.set(id, record)

    const emit = (ev: JobEvent) => this.onProducerEvent(id, ev)
    try {
      const handle = await producer.start(spec, emit)
      record.handle = handle
      // terminal 这类持久会话会返回 SendCapableHandle，把 send 暴露给 Consumer。
      if ('send' in handle) record.send = (handle as unknown as SendCapableHandle).send.bind(handle)
    } catch (e) {
      // 启动即失败：直接置 failed，不让 Consumer 拿到一个没 handle 的 id。
      record.status = 'failed'
      record.result = (e as Error).message
      record.finishedAt = Date.now()
      emit({ type: 'done', status: 'failed', detail: record.result })
      return id
    }
    emit({ type: 'status', status: 'running' })
    return id
  }

  /** producer 回报状态变化：只允许 producer 推进状态机，Consumer 不能改。 */
  private onProducerEvent(id: string, ev: JobEvent): void {
    const rec = this.jobs.get(id)
    if (!rec) return
    if (ev.type === 'output' && ev.chunk) {
      rec.outbox.push(ev.chunk)
      this.ctx.emit('jobs/event', { id, event: ev })
    } else if (ev.type === 'status' && ev.status) {
      rec.status = ev.status
      this.ctx.emit('jobs/event', { id, event: ev })
    } else if (ev.type === 'done') {
      rec.status = ev.status ?? 'completed'
      rec.result = ev.detail
      rec.finishedAt = Date.now()
      this.ctx.emit('jobs/event', { id, event: ev })
    }
  }

  /** Consumer 入口：列出某归属者的任务（或所有）。 */
  list(owner?: string): JobRecord[] {
    const all = [...this.jobs.values()]
    return owner ? all.filter(j => j.owner === owner)
                 : all
  }

  /** Consumer 入口：拉取任务的增量输出（取走即清空 outbox）。 */
  poll(id: string, owner?: string): string[] {
    this.assertOwner(id, owner)
    const rec = this.jobs.get(id)!
    const out = rec.outbox
    rec.outbox = []
    return out
  }

  /** Consumer 入口：向持久会话（terminal）发送命令；非会话类任务调用会抛错。 */
  send(id: string, text: string, owner?: string): void {
    this.assertOwner(id, owner)
    const rec = this.jobs.get(id)!
    if (!rec.send) throw new Error(`[jobs] job "${id}" (kind=${rec.kind}) 不支持 send（仅 terminal 会话支持）`)
    rec.send(text)
  }

  /**
   * Consumer 入口：停止任务。
   * @param owner 必须 == 任务 owner，否则拒绝（精确归属鉴权）。
   */
  async stop(id: string, owner?: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    this.assertOwner(id, owner)
    const rec = this.jobs.get(id)!
    if (rec.status !== 'running') return // 已经终态，幂等
    rec.status = 'stopping' // 先置 stopping，等 producer 回报 killed
    this.ctx.emit('jobs/event', { id, event: { type: 'status', status: 'stopping' } })
    // 交由 producer 执行真正的停止；producer 内部 kill 并在进程退出时
    // 通过 emit 回报 killed（见 producers.ts 的 exit handler），故这里不再兜底，
    // 避免重复通知。
    await rec.handle.stop(signal)
  }

  /** 精确归属鉴权：非 owner 不能 poll/stop（真实工程里 teardown_owner 也依赖此约束）。 */
  private assertOwner(id: string, owner?: string): void {
    const rec = this.jobs.get(id)
    if (!rec) throw new Error(`[jobs] 未知 job id="${id}"`)
    if (owner !== undefined && rec.owner !== owner) {
      throw new Error(`[jobs] 归属鉴权失败：job "${id}" 属于 "${rec.owner}"，调用方是 "${owner}"`)
    }
  }
}

export default Jobs
