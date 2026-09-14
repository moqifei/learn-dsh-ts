/**
 * WorkerProvider 插件实现层 —— 同样"一切皆为插件"：执行引擎也是插件贡献的。
 *
 * 本课用一个模拟 worker：runRound 返回一段"自然停止文本"，其演进由 runner 通过
 * workerBehavior 钩子控制（便于复现 s22 的"第一轮只写两行→续跑补齐"轨迹）。
 * 真实工程里 worker 会是真实 LLM 请求（packages/agent-loop 等），但 Loop 不关心实现。
 */
import { Context } from '@deepseek-ai/cordis'
import { WorkerProvider, GoalService } from './goal.ts'

class SimulatedWorker implements WorkerProvider {
  readonly name = 'sim-worker'
  runRound(round: number, goal: { objective: string }, continuation: string | null): string {
    // 默认行为：第一轮给部分内容，第二轮给完整内容（真实 worker 由 LLM 决定）。
    if (round === 1) return `FACT_ONE=...\nFACT_TWO=...` // 缺 VERIFIED=YES
    return `${goal.objective}` // 完整目标内容
  }
}

export const simWorkerPlugin = {
  name: 'goal-worker-sim',
  inject: ['goals'],
  apply(ctx: Context): void {
    const disposer = (ctx.goals as GoalService).registerWorker(new SimulatedWorker())
    console.log('  [插件] 注册 worker="sim-worker"（模拟执行引擎）')
    ctx.effect(() => disposer)
  },
}
