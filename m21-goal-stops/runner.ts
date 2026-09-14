/**
 * m21 runner：验证 "Goal 决定何时停" 的所有主张。
 *
 * 实验清单（全部应 OK）：
 *   1. 基础 Loop：worker 第一轮只给部分内容 → evaluator 判 continue → 注入续跑 → 第二轮齐全 → complete；
 *   2. 一切皆为插件（换停止审查策略）：换 strict evaluator，对"空产物"判 impossible（决策改变，Loop 逻辑不变）；
 *   3. 轮次上限：maxRounds=1 时 continue 变成 handed_back(limit)，不无限循环；
 *   4. impossible 显式交接：worker 直接给空产物 → strict 判 impossible → handed_back；
 *   5. 插件即能力：卸载 lenient evaluator 插件后，run 用该 evaluator 即被拒（"一切皆为插件"落点）。
 */
import { Context } from '@deepseek-ai/cordis'
import { GoalDefinition, GoalService } from './goal.ts'
import { lenientEvaluatorPlugin, strictEvaluatorPlugin } from './evaluators.ts'
import { simWorkerPlugin } from './workers.ts'

const DEF: GoalDefinition = {
  goalId: 'fact-report',
  objective: 'FACT_ONE=...\nFACT_TWO=...\nVERIFIED=YES',
  criteria: ['FACT_ONE', 'FACT_TWO', 'VERIFIED=YES'],
}

const goalRunner = {
  name: 'goal-runner',
  inject: ['goals'],
  async apply(ctx: Context): Promise<void> {
    const goals = ctx.goals as GoalService

    // 加载 evaluator + worker 插件（全部对等插件，演示一切皆为插件）
    const lenientFiber = await ctx.plugin(lenientEvaluatorPlugin)
    const strictFiber = await ctx.plugin(strictEvaluatorPlugin)
    await ctx.plugin(simWorkerPlugin)
    console.log('[注册 evaluator]', goals.listEvaluators().join(', '))
    console.log('[注册 worker]', goals.listWorkers().join(', '))

    // 观测日志事件
    const seen: string[] = []
    ctx.on('goal/event', (e) => seen.push(e.type))

    // ── 实验 1：基础 Loop（第一轮部分 → continue → 续跑 → complete）──
    console.log('\n[实验 1] 基础 Loop：部分内容→continue→补齐→complete：')
    const r1 = goals.run({
      def: DEF,
      evaluatorName: 'lenient',
      workerName: 'sim-worker',
      maxRounds: 4,
      // 受控 worker 轨迹：第一轮缺 VERIFIED，第二轮补齐
      workerBehavior: (round) => (round === 1 ? 'FACT_ONE=...\nFACT_TWO=...' : 'FACT_ONE=...\nFACT_TWO=...\nVERIFIED=YES'),
    })
    const decisions1 = r1.events.filter((e) => e.type === 'goal/decision').map((e) => e.data.decision)
    console.log('  决策序列：', decisions1.join(' -> '))
    console.log('  最终决策：', r1.decision.decision)
    console.log('  有续跑注入：', r1.events.some((e) => e.type === 'goal/continuation_injected') ? 'OK' : 'FAIL')
    const ok1 = decisions1[0] === 'continue' && r1.decision.decision === 'complete'
    console.log('  部分→续跑→完成：', ok1 ? 'OK' : 'FAIL')

    // ── 实验 2：换 evaluator（strict）改变停止审查决策 ───────────
    console.log('\n[实验 2] 一切皆为插件：换 strict evaluator 改变决策：')
    const r2 = goals.run({
      def: DEF,
      evaluatorName: 'strict',
      workerName: 'sim-worker',
      maxRounds: 4,
      // 同一 worker 轨迹：第一轮给空产物
      workerBehavior: (round) => (round === 1 ? '' : 'FACT_ONE=...\nFACT_TWO=...\nVERIFIED=YES'),
    })
    const decisions2 = r2.events.filter((e) => e.type === 'goal/decision').map((e) => e.data.decision)
    console.log('  strict 下决策序列：', decisions2.join(' -> '))
    console.log('  strict 对空产物判：', r2.decision.decision)
    const ok2 = r2.decision.decision === 'impossible'
    console.log('  换策略后决策改变（impossible）：', ok2 ? 'OK' : 'FAIL')

    // ── 实验 3：轮次上限 → handed_back(limit) ──────────────────
    console.log('\n[实验 3] 轮次上限：maxRounds=1 时 continue 变 handed_back(limit)：')
    const r3 = goals.run({
      def: DEF,
      evaluatorName: 'lenient',
      workerName: 'sim-worker',
      maxRounds: 1,
      workerBehavior: () => 'FACT_ONE=...\nFACT_TWO=...', // 永远缺 VERIFIED → continue
    })
    const handedBack = r3.events.find((e) => e.type === 'goal/handed_back')
    console.log('  handed_back 原因：', handedBack?.data.reason)
    const ok3 = handedBack?.data.reason === 'limit'
    console.log('  上限交接（不无限循环）：', ok3 ? 'OK' : 'FAIL')

    // ── 实验 4：impossible 显式交接 ──────────────────────────
    console.log('\n[实验 4] impossible 显式交接：')
    // 复用实验2的 r2：其 decision 已是 impossible，且日志有 handed_back
    const handedBack4 = r2.events.find((e) => e.type === 'goal/handed_back')
    console.log('  impossible → handed_back：', handedBack4 ? 'OK' : 'FAIL')

    // ── 实验 5：一切皆为插件——卸载 evaluator 后 Loop 拒绝 ───────
    console.log('\n[实验 5] 一切皆为插件：卸载 lenient evaluator 插件后 run 用其即被拒：')
    await lenientFiber.dispose() // 触发 disposer → evaluators.delete('lenient')
    console.log('  剩余 evaluator：', goals.listEvaluators().join(', '))
    let rejected = false
    try {
      goals.run({ def: DEF, evaluatorName: 'lenient', workerName: 'sim-worker', workerBehavior: () => 'x' })
      console.log('  FAIL: 卸载后仍可用')
    } catch (e) {
      rejected = (e as Error).message.includes('未注册')
      console.log('  OK 已消失：', (e as Error).message)
    }
    // strict 仍在，证明是"按 evaluator 粒度"生灭
    console.log('  strict 不受影响仍在：', goals.listEvaluators().includes('strict') ? 'OK' : 'FAIL')
    void strictFiber

    console.log('\n==== 结束 ====')
    process.exit(0)
  },
}

export default goalRunner
