/**
 * GoalService —— "Goal 决定何时停" 的 Definition + Consumer 层（ctx.goals）。
 *
 * 对齐 deepseek-harness 的 packages/goal/goal（Goal service） + goal-round-driver（轮次 driver）：
 * 把"停止审查"从 worker 里抽出来，做成一个独立的、可替换的闸门。
 *
 * 三角色：
 *  - Definition：GoalDefinition（目标文本 + 验收标准），数据对象；
 *  - Provider：GoalEvaluator —— 独立停止审查者，每次 worker 自然停止后给出
 *             complete / continue / impossible / failed 的结构化决策；
 *             WorkerProvider —— 执行一轮动作、返回自然停止文本（本课用模拟实现）；
 *  - Consumer：GoalService —— 跑 GoalLoop：worker 轮次 → 宿主观测证据 → evaluator 审查 →
 *             按决策推进 / 续跑 / 交接。宿主只观测字节，绝不冒充 evaluator 决策。
 *
 * 一切皆为插件落点：evaluator 与 worker 都是可替换插件，通过 registerEvaluator/registerWorker
 * 注入；换"停止审查策略"或"执行引擎"都不改 GoalService 与 Loop 主逻辑。
 */
import { Context, Service } from '@deepseek-ai/cordis'

// ── 三角色契约类型 ──────────────────────────────────────────────────

export type GoalDecisionKind = 'complete' | 'continue' | 'impossible' | 'failed'
export type HandoffReason = GoalDecisionKind | 'limit'

/** 一个目标定义。 */
export interface GoalDefinition {
  readonly goalId: string
  /** 完整目标文本（evaluator 看得到，worker 未必看全）。 */
  readonly objective: string
  /** 验收标准（人类可读）。 */
  readonly criteria: string[]
}

/** 宿主观测到的客观证据（不替 evaluator 做决定）。 */
export interface GoalObservation {
  readonly exists: boolean
  readonly content: string
  readonly exactMatch: boolean
  readonly readAfterFinalWrite: boolean
}

/** 独立停止审查者的结构化决策。 */
export interface GoalDecision {
  readonly decision: GoalDecisionKind
  readonly reason: string
  readonly missing: string[]
}

/** 可替换的停止审查提供者（一切皆为插件）。 */
export interface GoalEvaluator {
  readonly name: string
  /** 给出结构化决策；接收完整目标、轮次、worker 自然停止文本、宿主观测。 */
  review(ctx: EvaluatorInput): GoalDecision
}

export interface EvaluatorInput {
  readonly goal: GoalDefinition
  readonly round: number
  readonly naturalStop: string
  readonly observation: GoalObservation
}

/** 可替换的执行引擎（一切皆为插件）。 */
export interface WorkerProvider {
  readonly name: string
  /** 跑一轮，返回自然停止文本（不调 LLM，用确定性动作模拟）。 */
  runRound(round: number, goal: GoalDefinition, continuation: string | null): string
}

// ── 只追加事件日志 ──────────────────────────────────────────────────
export type GoalEventType =
  | 'goal/started'
  | 'goal/round_started'
  | 'goal/natural_stop'
  | 'goal/observation'
  | 'goal/decision'
  | 'goal/continuation_injected'
  | 'goal/completed'
  | 'goal/handed_back'

export interface GoalEvent {
  seq: number
  time: number
  type: GoalEventType
  data: Record<string, unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    goals: GoalService
  }
  interface Events {
    'goal/event': (event: GoalEvent) => void
    'goal/evaluator-added': (e: GoalEvaluator) => void
    'goal/evaluator-removed': (name: string) => void
    'goal/worker-added': (w: WorkerProvider) => void
    'goal/worker-removed': (name: string) => void
  }
}

export interface GoalResult {
  readonly decision: GoalDecision
  readonly rounds: number
  readonly events: GoalEvent[]
}

// ── GoalService（Definition + Consumer）─────────────────────────────
export class GoalService extends Service {
  private readonly evaluators = new Map<string, GoalEvaluator>()
  private readonly workers = new Map<string, WorkerProvider>()
  /** goalId -> 事件日志（只追加） */
  private readonly logs = new Map<string, GoalEvent[]>()

  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  // —— 插件注册（一切皆为插件落点）——
  registerEvaluator(e: GoalEvaluator): () => void {
    if (this.evaluators.has(e.name)) throw new Error(`[goals] 已存在 evaluator="${e.name}"`)
    this.evaluators.set(e.name, e)
    this.ctx.emit('goal/evaluator-added', e)
    return () => {
      this.evaluators.delete(e.name)
      this.ctx.emit('goal/evaluator-removed', e.name)
    }
  }

  registerWorker(w: WorkerProvider): () => void {
    if (this.workers.has(w.name)) throw new Error(`[goals] 已存在 worker="${w.name}"`)
    this.workers.set(w.name, w)
    this.ctx.emit('goal/worker-added', w)
    return () => {
      this.workers.delete(w.name)
      this.ctx.emit('goal/worker-removed', w.name)
    }
  }

  listEvaluators(): string[] {
    return [...this.evaluators.keys()]
  }

  listWorkers(): string[] {
    return [...this.workers.keys()]
  }

  inspectLog(goalId: string): GoalEvent[] {
    return this.logs.get(goalId) ?? []
  }

  private append(goalId: string, type: GoalEventType, data: Record<string, unknown>): GoalEvent {
    const log = this.logs.get(goalId) ?? []
    const event: GoalEvent = { seq: log.length, time: Date.now(), type, data }
    log.push(event)
    this.logs.set(goalId, log)
    this.ctx.emit('goal/event', event)
    return event
  }

  /**
   * 跑 GoalLoop（带 round cap）。
   * - worker 自然停止只是提案，交给独立 evaluator 审查；
   * - complete → 成功；continue → 注入续跑（到上限转 handed_back limit）；
   * - impossible / failed → handed_back 交还控制权。
   * 宿主只提供观测证据，绝不自行判定完成。
   */
  run(opts: {
    def: GoalDefinition
    evaluatorName: string
    workerName: string
    maxRounds?: number
    /** 受控的 worker 行为钩子（测试用）：给定轮次返回自然停止文本。 */
    workerBehavior?: (round: number, continuation: string | null) => string
  }): GoalResult {
    const { def, evaluatorName, workerName, maxRounds = 4 } = opts
    const evaluator = this.evaluators.get(evaluatorName)
    if (!evaluator) throw new Error(`[goals] 未知 evaluator="${evaluatorName}"（未注册）`)
    const worker = this.workers.get(workerName)
    if (!worker) throw new Error(`[goals] 未知 worker="${workerName}"（未注册）`)

    this.logs.set(def.goalId, []) // 全新状态
    this.append(def.goalId, 'goal/started', { objective: def.objective, maxRounds })

    let continuation: string | null = null
    let finalDecision: GoalDecision | null = null

    for (let round = 1; round <= maxRounds; round++) {
      this.append(def.goalId, 'goal/round_started', { round })
      const naturalStop =
        opts.workerBehavior?.(round, continuation) ?? worker.runRound(round, def, continuation)
      this.append(def.goalId, 'goal/natural_stop', { round, text: naturalStop })

      // 宿主观测证据（字节级），不替 evaluator 决定
      const observation: GoalObservation = {
        exists: naturalStop.length > 0,
        content: naturalStop,
        exactMatch: naturalStop.includes(def.objective), // 简化观测：文本是否包含目标
        readAfterFinalWrite: true,
      }
      this.append(def.goalId, 'goal/observation', { round, ...observation })

      // 独立审查
      const decision = evaluator.review({ goal: def, round, naturalStop, observation })
      this.append(def.goalId, 'goal/decision', { round, ...decision })

      if (decision.decision === 'complete') {
        this.append(def.goalId, 'goal/completed', { round })
        finalDecision = decision
        break
      }
      if (decision.decision === 'continue') {
        if (round === maxRounds) {
          // 到达上限：continue 变为 handed_back(limit)，不无限循环
          this.append(def.goalId, 'goal/handed_back', { round, reason: 'limit', detail: 'round cap reached' })
          finalDecision = { decision: 'failed', reason: `round limit ${maxRounds} reached`, missing: ['host handoff'] }
          break
        }
        // 注入续跑事实（追加到同一 worker session，不修改旧历史）
        const feedback = `Independent goal review chose CONTINUE. Full goal:\n${def.objective}\nReason: ${decision.reason} Missing: ${decision.missing.join('; ')}`
        this.append(def.goalId, 'goal/continuation_injected', { round, content: feedback })
        continuation = feedback
        continue
      }
      // impossible / failed → 显式交接
      this.append(def.goalId, 'goal/handed_back', { round, reason: decision.decision, detail: decision.reason })
      finalDecision = decision
      break
    }

    return {
      decision: finalDecision ?? { decision: 'failed', reason: 'no decision', missing: [] },
      rounds: this.inspectLog(def.goalId).filter((e) => e.type === 'goal/round_started').length,
      events: this.inspectLog(def.goalId),
    }
  }
}

export default GoalService
