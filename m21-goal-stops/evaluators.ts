/**
 * GoalEvaluator 插件实现层 —— "一切皆为插件"的可替换停止审查边界。
 *
 * 两个对等插件：
 *  - lenient：宽松审查（默认），内容缺最后一行时判 continue；
 *  - strict：严格审查，对"明显不可能满足"的目标直接判 impossible（演示换策略改行为，不改 Loop）。
 *
 * 两者都通过 registerEvaluator 注入 GoalService，并被 ctx.effect 的 disposer 管理生命周期。
 * 真实工程里 evaluator 可能调用独立 LLM 请求（与 worker 分离），本课用确定性逻辑模拟审查语义。
 */
import { Context } from '@deepseek-ai/cordis'
import { GoalEvaluator, GoalService } from './goal.ts'

// ── Evaluator 1：lenient（默认，宽松）──────────────────────────────
class LenientEvaluator implements GoalEvaluator {
  readonly name = 'lenient'
  review(input: { goal: { criteria: string[] }; naturalStop: string; observation: { exactMatch: boolean } }): {
    decision: 'complete' | 'continue' | 'impossible' | 'failed'
    reason: string
    missing: string[]
  } {
    const { goal, naturalStop, observation } = input
    // 全部验收标准都出现在产物里 → complete
    const missing = goal.criteria.filter((c) => !naturalStop.includes(c))
    if (missing.length === 0 && observation.exactMatch) {
      return { decision: 'complete', reason: '所有验收标准均已满足', missing: [] }
    }
    if (missing.length > 0) {
      return { decision: 'continue', reason: '仍有未满足的验收标准', missing }
    }
    return { decision: 'continue', reason: '内容存在但需进一步确认', missing: [] }
  }
}

// ── Evaluator 2：strict（严格，可替换策略）─────────────────────────
// 与 lenient 接口完全一致，仅审查逻辑更"决断"：当产物完全为空或含不可能标记时直接判 impossible。
class StrictEvaluator implements GoalEvaluator {
  readonly name = 'strict'
  review(input: { goal: { criteria: string[] }; naturalStop: string; observation: { exists: boolean } }): {
    decision: 'complete' | 'continue' | 'impossible' | 'failed'
    reason: string
    missing: string[]
  } {
    const { goal, naturalStop, observation } = input
    if (!observation.exists || naturalStop.trim().length === 0) {
      return { decision: 'impossible', reason: '产物为空，目标在当前约束下无法实现', missing: goal.criteria }
    }
    const missing = goal.criteria.filter((c) => !naturalStop.includes(c))
    if (missing.length === 0) {
      return { decision: 'complete', reason: '严格审查：全部标准满足', missing: [] }
    }
    return { decision: 'continue', reason: '严格审查：仍有缺失', missing }
  }
}

// ── 插件对象（与 m18-m20 完全对等）─────────────────────────────────
export const lenientEvaluatorPlugin = {
  name: 'goal-evaluator-lenient',
  inject: ['goals'],
  apply(ctx: Context): void {
    const disposer = (ctx.goals as GoalService).registerEvaluator(new LenientEvaluator())
    console.log('  [插件] 注册 evaluator="lenient"（默认宽松审查）')
    ctx.effect(() => disposer)
  },
}

export const strictEvaluatorPlugin = {
  name: 'goal-evaluator-strict',
  inject: ['goals'],
  apply(ctx: Context): void {
    const disposer = (ctx.goals as GoalService).registerEvaluator(new StrictEvaluator())
    console.log('  [插件] 注册 evaluator="strict"（严格审查，演示一切皆为插件）')
    ctx.effect(() => disposer)
  },
}
