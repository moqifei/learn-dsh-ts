/**
 * WorkflowService —— 可恢复固定编排的 Definition + Consumer 层（ctx.workflows）。
 *
 * 对齐 deepseek-harness 的 workflow/workflow（服务类型）：把"编排"与"执行"分离。
 *  - Definition：固定的阶段顺序 + 检查点边界（本课用 WorkflowDefinition 数据对象）；
 *  - Provider：StageProvider —— 可替换的"阶段执行驱动"，只执行单个阶段，不决定顺序；
 *  - Consumer：WorkflowService —— 解释 Definition，向只追加 journal 追加事实，
 *              并在恢复时验证日志、折叠已完成输出、跳过已完成的阶段。
 *
 * 可恢复的核心是**只追加 journal + 完整前缀校验**：
 *  恢复不是"找最后一行继续"，而是验证整个前缀（workflow_id/version 匹配、
 *  序列连续、阶段顺序、request_id 关联、无未结算阶段、有 checkpoint、无 completed）
 *  之后才信任日志、跳过重跑。权威跳过决策来自 stage_completed 事件，而非某条汇总行。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── 三角色契约类型 ──────────────────────────────────────────────────

/** 一个固定阶段。 */
export interface Stage {
  readonly id: string
  readonly kind: string
  readonly prompt: string
}

/** 固定编排定义（数据，不是模型生成代码）。 */
export interface WorkflowDefinition {
  readonly workflowId: string
  readonly version: number
  readonly description: string
  /** 有序阶段；顺序本身即权威。 */
  readonly stages: Stage[]
  /** 该阶段完成后由主机刻意停机（必须是倒数第二阶段之前）。 */
  readonly hostCheckpointAfter: string
}

/** 一个可替换的"阶段执行驱动"。只执行单个阶段，不决定下一阶段。 */
export interface StageProvider {
  readonly name: string
  /** 执行一个阶段，返回输出文本。requestId 由主机生成并持久关联。 */
  run(stage: Stage, renderedPrompt: string, requestId: string): Promise<string>
}

// ── 只追加 journal 事件 ──────────────────────────────────────────────
export type JournalEventType =
  | 'workflow_started'
  | 'stage_started'
  | 'stage_completed'
  | 'stage_failed'
  | 'host_checkpoint'
  | 'workflow_resumed'
  | 'workflow_completed'

export interface JournalEvent {
  seq: number
  time: number
  workflowId: string
  version: number
  type: JournalEventType
  data: Record<string, unknown>
}

// ── 事件合并（observer 视角）────────────────────────────────────────
declare module '@deepseek-ai/cordis' {
  interface Context {
    workflows: WorkflowService
  }
  interface Events {
    'workflow/event': (event: JournalEvent) => void
    'workflow/provider-added': (provider: StageProvider) => void
    'workflow/provider-removed': (name: string) => void
  }
}

// ── journal 校验器（恢复边界）──────────────────────────────────────
/**
 * 在信任日志前验证完整前缀。任何不匹配都抛错——恢复不是"找最后一行继续"。
 * 这与 s21 的 Journal._validate 同语义；本课集中为独立纯函数，便于单测与替换存储。
 */
export function validateJournal(events: JournalEvent[], def: WorkflowDefinition): void {
  if (events.length === 0) throw new Error('[journal] 空日志')
  if (events[0].type !== 'workflow_started') throw new Error('[journal] 首事件必须是 workflow_started')

  const stageIds = def.stages.map((s) => s.id)
  const started: string[] = []
  const completed: string[] = []
  const requestIds: Record<string, string> = {}

  events.forEach((event, idx) => {
    if (event.seq !== idx) throw new Error(`[journal] 序列不连续 @${idx}`)
    if (event.workflowId !== def.workflowId) throw new Error('[journal] workflowId 不匹配')
    if (event.version !== def.version) throw new Error('[journal] version 不匹配（definition 已变更）')
    if (event.type === 'stage_started') {
      const stageId = event.data.stageId as string
      const expected = stageIds[started.length]
      if (stageId !== expected || started.includes(stageId)) {
        throw new Error(`[journal] 阶段开始顺序违规: ${stageId}`)
      }
      started.push(stageId)
      requestIds[stageId] = event.data.requestId as string
    } else if (event.type === 'stage_completed') {
      const stageId = event.data.stageId as string
      const expected = stageIds[completed.length]
      if (stageId !== expected || !started.includes(stageId)) {
        throw new Error(`[journal] 阶段完成顺序违规: ${stageId}`)
      }
      if (event.data.requestId !== requestIds[stageId]) {
        throw new Error(`[journal] 阶段 requestId 关联被篡改: ${stageId}`)
      }
      completed.push(stageId)
    }
  })

  if (started.length !== completed.length) {
    throw new Error('[journal] 尾部存在未结算阶段（start 无对应 completed）')
  }
  if (!events.some((e) => e.type === 'host_checkpoint')) {
    throw new Error('[journal] 缺少可恢复主机检查点')
  }
  if (events.some((e) => e.type === 'workflow_completed')) {
    throw new Error('[journal] workflow 已完成，不可重复恢复')
  }
}

/** 从 journal 折叠已完成阶段的输出（冷重建）。 */
export function foldOutputs(events: JournalEvent[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of events) {
    if (e.type === 'stage_completed') {
      out[e.data.stageId as string] = e.data.output as string
    }
  }
  return out
}

/** 统计每个阶段的"被调度次数"（来自 stage_started），用于证明未重跑。 */
export function invocationCounts(events: JournalEvent[], def: WorkflowDefinition): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of def.stages) counts[s.id] = 0
  for (const e of events) if (e.type === 'stage_started') counts[e.data.stageId as string]++
  return counts
}

// ── WorkflowService（Definition + Consumer）─────────────────────────
export class WorkflowService extends Service {
  private readonly providers = new Map<string, StageProvider>()
  /** workflowId -> 日志文件路径（落盘，模拟进程间持久化）。 */
  private readonly journalPaths = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'workflows')
  }

  // —— Provider 插件注册（一切皆为插件落点）——
  registerProvider(provider: StageProvider): () => void {
    if (this.providers.has(provider.name)) throw new Error(`[workflows] 已存在 provider="${provider.name}"`)
    this.providers.set(provider.name, provider)
    this.ctx.emit('workflow/provider-added', provider)
    return () => {
      this.providers.delete(provider.name)
      this.ctx.emit('workflow/provider-removed', provider.name)
    }
  }

  listProviders(): string[] {
    return [...this.providers.keys()]
  }

  /** 清空某 workflow 的日志（模拟"全新状态目录"；runner 每次运行前调用）。 */
  clear(workflowId: string): void {
    const p = this.journalFile(workflowId) // 解析并登记路径
    if (existsSync(p)) writeFileSync(p, '')
  }

  /** 为某个 workflow 准备一个落盘日志路径（复用课程临时目录即可）。 */
  private journalFile(workflowId: string): string {
    let p = this.journalPaths.get(workflowId)
    if (!p) {
      p = join(tmpdir(), `m20-workflow-${workflowId}.jsonl`)
      this.journalPaths.set(workflowId, p)
    }
    return p
  }

  private readJournal(workflowId: string): JournalEvent[] {
    const p = this.journalFile(workflowId)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as JournalEvent)
  }

  private append(def: WorkflowDefinition, type: JournalEventType, data: Record<string, unknown>): JournalEvent {
    const events = this.readJournal(def.workflowId)
    const event: JournalEvent = {
      seq: events.length,
      time: Date.now(),
      workflowId: def.workflowId,
      version: def.version,
      type,
      data,
    }
    appendFileSync(this.journalFile(def.workflowId), JSON.stringify(event) + '\n')
    this.ctx.emit('workflow/event', event)
    return event
  }

  private render(stage: Stage, outputs: Record<string, string>): string {
    // 把已完成输出注入后续阶段的 prompt（模板用 {stageId} 占位）
    let prompt = stage.prompt
    for (const [k, v] of Object.entries(outputs)) {
      prompt = prompt.replaceAll(`{${k}}`, v)
    }
    return prompt
  }

  private async runStage(
    def: WorkflowDefinition,
    stage: Stage,
    providerName: string,
    outputs: Record<string, string>,
  ): Promise<string> {
    const provider = this.providers.get(providerName)
    if (!provider) throw new Error(`[workflows] 未知 provider="${providerName}"（未注册）`)
    const requestId = `request-${randomUUID().slice(0, 12)}`
    const rendered = this.render(stage, outputs)
    this.append(def, 'stage_started', { stageId: stage.id, requestId, provider: providerName, prompt: rendered })
    try {
      const output = await provider.run(stage, rendered, requestId)
      this.append(def, 'stage_completed', { stageId: stage.id, requestId, provider: providerName, output })
      return output
    } catch (e) {
      this.append(def, 'stage_failed', { stageId: stage.id, error: String(e) })
      throw e
    }
  }

  /**
   * 启动：要求状态为空。执行阶段直到（含）hostCheckpointAfter，然后刻意停机。
   */
  async start(def: WorkflowDefinition, providerName: string): Promise<Record<string, string>> {
    if (this.readJournal(def.workflowId).length > 0) {
      throw new Error('[workflows] --start 要求状态目录为空')
    }
    this.append(def, 'workflow_started', { description: def.description })
    const outputs: Record<string, string> = {}
    for (const stage of def.stages) {
      outputs[stage.id] = await this.runStage(def, stage, providerName, outputs)
      if (stage.id === def.hostCheckpointAfter) {
        const completedIds = Object.keys(outputs)
        const nextStage = def.stages[completedIds.length].id
        this.append(def, 'host_checkpoint', { completed: completedIds, nextStage })
        return outputs // 刻意停机，不跑 synthesis
      }
    }
    throw new Error('[workflows] 未到达配置的主机检查点')
  }

  /**
   * 恢复：构造新实例、加载日志、完整校验，只跑缺失阶段，不重跑已完成。
   */
  async resume(def: WorkflowDefinition, providerName: string): Promise<Record<string, string>> {
    const events = this.readJournal(def.workflowId)
    validateJournal(events, def) // 不信任日志，先验证完整前缀
    const outputs = foldOutputs(events) // 冷重建已完成输出
    this.append(def, 'workflow_resumed', { completed: Object.keys(outputs) })
    for (const stage of def.stages) {
      if (stage.id in outputs) continue // 跳过已完成阶段（关键：不重跑）
      outputs[stage.id] = await this.runStage(def, stage, providerName, outputs)
    }
    this.append(def, 'workflow_completed', { completed: Object.keys(outputs) })
    return outputs
  }

  /** 供实验读取原始日志做断言。 */
  inspectJournal(workflowId: string): JournalEvent[] {
    return this.readJournal(workflowId)
  }

  /** 篡改日志（仅用于"破坏校验"实验）：替换某一行文本后写回。 */
  tamperJournal(workflowId: string, mutate: (lines: string[]) => string[]): void {
    const p = this.journalFile(workflowId)
    const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
    writeFileSync(p, mutate(lines).join('\n') + '\n')
  }
}

export default WorkflowService
