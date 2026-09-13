/**
 * m20 runner：验证 Workflow 可恢复的所有主张。
 *
 * 实验清单（全部应 OK）：
 *   1. 启动两阶段后刻意检查点停机（不跑 synthesis）；
 *   2. journal 落盘为只追加 JSONL（start 后可在磁盘读取）；
 *   3. 恢复：仅跑 synthesis，前两段调用计数仍为 1（证明未重跑）；
 *   4. 一切皆为插件：换 provider（remote）后 resume 仍按 journal 语义跳过已完成阶段；
 *   5. 日志校验边界：篡改 version 后恢复被拒（而非猜测兼容）。
 */
import { Context } from '@deepseek-ai/cordis'
import {
  WorkflowDefinition,
  WorkflowService,
  invocationCounts,
  validateJournal,
} from './workflow.ts'
import { localEchoProviderPlugin, remoteProviderPlugin } from './providers.ts'

// 固定编排定义（数据，不是模型生成代码）
const DEF: WorkflowDefinition = {
  workflowId: 'resumable-design-review',
  version: 1,
  description: '两次独立分析 + 一次综合，主机可在分析后停机恢复',
  stages: [
    { id: 'failure-analysis', kind: 'agent', prompt: '分析失败与重复副作用风险' },
    { id: 'recovery-analysis', kind: 'agent', prompt: '分析重启/日志/恢复要求' },
    { id: 'synthesis', kind: 'agent', prompt: '综合两者：{failure-analysis} / {recovery-analysis}' },
  ],
  hostCheckpointAfter: 'recovery-analysis',
}

const workflowRunner = {
  name: 'workflow-runner',
  inject: ['workflows'],
  async apply(ctx: Context): Promise<void> {
    const wf = ctx.workflows as WorkflowService

    // 每次运行前清空日志，模拟"全新状态目录"（避免重复运行时的状态残留）
    wf.clear(DEF.workflowId)
    wf.clear('resumable-remote')

    // 加载 Provider 插件（两个对等插件，演示一切皆为插件）
    await ctx.plugin(localEchoProviderPlugin)
    await ctx.plugin(remoteProviderPlugin)
    console.log('[注册 provider]', wf.listProviders().join(', '))

    // 观测 journal 事件
    const seen: string[] = []
    ctx.on('workflow/event', (e) => seen.push(e.type))

    // ── 实验 1：启动后刻意停机 ─────────────────────────────────
    console.log('\n[实验 1] 启动：跑完 failure/recovery 后刻意检查点停机：')
    const started = await wf.start(DEF, 'local-echo')
    console.log('  启动后已完成阶段：', Object.keys(started).join(', '))
    console.log('  synthesis 未跑（停机前）：', !('synthesis' in started) ? 'OK' : 'FAIL')

    // ── 实验 2：journal 落盘 ──────────────────────────────────
    console.log('\n[实验 2] journal 落盘为只追加 JSONL：')
    const journal = wf.inspectJournal(DEF.workflowId)
    const hasCheckpoint = journal.some((e) => e.type === 'host_checkpoint')
    console.log('  行数：', journal.length, '含 host_checkpoint：', hasCheckpoint ? 'OK' : 'FAIL')

    // ── 实验 3：恢复只跑 synthesis，前两段不重跑 ─────────────────
    console.log('\n[实验 3] 恢复：仅跑 synthesis，前两段调用计数仍为 1：')
    const resumed = await wf.resume(DEF, 'local-echo')
    const counts = invocationCounts(wf.inspectJournal(DEF.workflowId), DEF)
    console.log('  恢复后所有阶段：', Object.keys(resumed).join(', '))
    console.log('  调用计数：', JSON.stringify(counts))
    const ok3 =
      counts['failure-analysis'] === 1 &&
      counts['recovery-analysis'] === 1 &&
      counts['synthesis'] === 1
    console.log('  前两段未重跑（计数=1）：', ok3 ? 'OK' : 'FAIL')
    // 输出逐字节复用：恢复后 failure/recovery 输出与启动时一致
    const same =
      resumed['failure-analysis'] === started['failure-analysis'] &&
      resumed['recovery-analysis'] === started['recovery-analysis']
    console.log('  已完成输出逐字节复用：', same ? 'OK' : 'FAIL')

    // ── 实验 4：一切皆为插件 —— 同一 workflow 热替换引擎（local-echo → remote）────
    // 最直观的"换 provider"：对同一份日志，start 用 local-echo 跑到检查点，
    // resume 时换成 remote 引擎跑 synthesis。日志里前半段 provider=local-echo、
    // 后半段 provider=remote，但 Runtime 与 journal 校验一行未改，且已完成阶段不重跑。
    console.log('\n[实验 4] 一切皆为插件：同一 workflow 热替换引擎 local-echo → remote：')
    const RID = 'resumable-remote'
    wf.clear(RID)
    // 4.1 用 local-echo 引擎启动，跑 failure+recovery 后刻意停机
    await wf.start({ ...DEF, workflowId: RID, version: 1 } as WorkflowDefinition, 'local-echo')
    console.log('  4.1 start 用 local-echo 跑到检查点停机：OK')
    // 4.2 换 remote 引擎 resume（只跑 synthesis），日志中 synthesis 的 provider 应为 remote
    await wf.resume({ ...DEF, workflowId: RID, version: 1 } as WorkflowDefinition, 'remote')
    // 4.3 从日志抽取每个阶段的执行引擎
    const provOf: Record<string, string> = {}
    for (const e of wf.inspectJournal(RID)) {
      if (e.type === 'stage_started') provOf[e.data.stageId as string] = e.data.provider as string
    }
    console.log('  各阶段执行引擎：', JSON.stringify(provOf))
    const countsR = invocationCounts(wf.inspectJournal(RID), {
      ...DEF,
      workflowId: RID,
    } as WorkflowDefinition)
    console.log('  调用计数：', JSON.stringify(countsR))
    const ok4a = provOf['failure-analysis'] === 'local-echo' && provOf['recovery-analysis'] === 'local-echo'
    const ok4b = provOf['synthesis'] === 'remote'
    const ok4c = countsR['failure-analysis'] === 1 && countsR['recovery-analysis'] === 1 && countsR['synthesis'] === 1
    console.log('  前半段由 local-echo 执行：', ok4a ? 'OK' : 'FAIL')
    console.log('  后半段由 remote 执行（热替换）：', ok4b ? 'OK' : 'FAIL')
    console.log('  换引擎后仍不重跑已完成阶段：', ok4c ? 'OK' : 'FAIL')
    const ok4 = ok4a && ok4b && ok4c

    // ── 实验 5：日志校验边界（篡改 version → 恢复被拒）──────────
    // 用独立的、未完成的工作流，避免与实验4耦合；篡改其 version 后 resume 必被拒。
    console.log('\n[实验 5] 日志校验边界：篡改 version 后恢复被拒：')
    const TID = 'resumable-tamper'
    wf.clear(TID)
    await wf.start({ ...DEF, workflowId: TID, version: 1 } as WorkflowDefinition, 'local-echo') // 跑到检查点停机（未完成）
    // 篡改首行 version → 2
    wf.tamperJournal(TID, (lines) => {
      if (!lines.length) return lines
      const first = JSON.parse(lines[0])
      first.version = 2
      lines[0] = JSON.stringify(first)
      return lines
    })
    let rejected = false
    try {
      await wf.resume({ ...DEF, workflowId: TID, version: 1 } as WorkflowDefinition, 'local-echo')
      console.log('  FAIL: 篡改版本后竟被接受')
    } catch (e) {
      rejected = (e as Error).message.includes('version')
      console.log('  OK 拒绝（不猜测兼容）：', (e as Error).message)
    }

    // 额外：纯函数校验器对"空日志"也应拒
    let emptyRejected = false
    try {
      validateJournal([], DEF)
    } catch {
      emptyRejected = true
    }
    console.log('  校验器拒绝空日志：', emptyRejected ? 'OK' : 'FAIL')

    console.log('\n==== 结束 ====')
    process.exit(0)
  },
}

export default workflowRunner
