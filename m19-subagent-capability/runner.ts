/**
 * m19 runner：验证 Subagent 作为 capability 的 README 里所有主张。
 *
 * 实验清单（全部应 OK）：
 *   1. 按名启动：spawn-in-process 跑通，返回 output；
 *   2. 多 provider 共存：fork 也能按名启动并各自返回结果；
 *   3. capability 校验：对 fork 请求 outputSchema → 被拒绝（响亮失败）；
 *   4. 生命周期事件：监听 subagent/start 与 subagent/end，两个 run 都被观测到；
 *   5. 一切皆为插件（落点实证）：fork 是后加的 provider，卸载其插件后，
 *      start('fork') 报"未注册"——证明 Runtime 零硬编码、能力随插件生灭。
 */
import { Context } from '@deepseek-ai/cordis'
import {
  SubagentRuntime,
  SubagentStartRequest,
} from './subagents.ts'
import { spawnInProcessProviderPlugin, forkProviderPlugin } from './providers.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const subagentRunner = {
  name: 'subagent-runner',
  inject: ['subagents'],
  async apply(ctx: Context): Promise<void> {
    const jobs = ctx.subagents as SubagentRuntime

    // 加载 Provider 插件（与 m18 一致：用 await ctx.plugin 保证注册顺序）
    const spawnFiber = await ctx.plugin(spawnInProcessProviderPlugin)
    const forkFiber = await ctx.plugin(forkProviderPlugin)

    console.log('[注册表]', jobs.list().join(', '))

    // 观测生命周期事件
    const starts: string[] = []
    const ends: string[] = []
    ctx.on('subagent/start', (info) => starts.push(`${info.provider}`))
    ctx.on('subagent/end', (info) => ends.push(`${info.provider}:${info.stopReason}`))

    // ── 实验 1：按名启动 spawn-in-process ───────────────────────
    console.log('\n[实验 1] 按名启动 spawn-in-process：')
    const r1 = await jobs.start('spawn-in-process', {
      parent: 'main',
      prompt: '总结一下 cordis 的插件模型',
    } as SubagentStartRequest)
    const out1 = await r1.result
    console.log('  输出：', out1.output.slice(0, 60))
    console.log('  完成：', out1.stopReason === 'completed' ? 'OK' : 'FAIL')
    await r1.dispose()

    // ── 实验 2：多 provider 共存，按名分别启动 ─────────────────
    console.log('\n[实验 2] 多 provider 共存，fork 也能启动：')
    const r2 = await jobs.start('fork', { parent: 'main', prompt: '并行跑个检查' } as SubagentStartRequest)
    const out2 = await r2.result
    console.log('  fork 输出：', out2.output.slice(0, 50))
    console.log('  spawn 与 fork 结果不同源：', out1.output !== out2.output ? 'OK' : 'FAIL')
    await r2.dispose()

    // ── 实验 3：capability 校验（fork 不支持 outputSchema）──────
    console.log('\n[实验 3] capability 校验：')
    let capOK = false
    try {
      await jobs.start('fork', {
        parent: 'main',
        prompt: '结构化输出',
        outputSchema: true,
      } as SubagentStartRequest)
      console.log('  FAIL: 缺能力却被接受')
    } catch (e) {
      capOK = (e as Error).message.includes('outputSchema')
      console.log('  OK 拒绝（响亮失败）：', (e as Error).message)
    }

    // ── 实验 4：生命周期事件观测 ──────────────────────────────
    await sleep(120)
    console.log('\n[实验 4] 生命周期事件：')
    console.log('  subagent/start 触发：', starts.join(', '))
    console.log('  subagent/end   触发：', ends.join(', '))
    const ok4 = starts.length >= 2 && ends.length >= 2
    console.log('  两个 run 均被观测：', ok4 ? 'OK' : 'FAIL')

    // ── 实验 5：一切皆为插件（落点实证）────────────────────────
    console.log('\n[实验 5] 一切皆为插件：fork 是后加 provider，卸载即消失：')
    console.log('  5.1 卸载 fork 插件前，start("fork") 仍可跑：',
      (await jobs.getProvider('fork')) ? 'OK' : 'FAIL')
    await forkFiber.dispose() // 触发其 effect disposer → providers.delete('fork')
    console.log('  5.2 已卸载 fork 插件')
    console.log('  5.3 注册表剩余：', jobs.list().join(', '))
    let removedOK = false
    try {
      await jobs.start('fork', { parent: 'main', prompt: 'x' } as SubagentStartRequest)
      console.log('  FAIL: fork 仍可启动')
    } catch (e) {
      removedOK = (e as Error).message.includes('未注册')
      console.log('  OK fork 已消失：', (e as Error).message)
    }
    // 注意：spawn 仍在（未卸载），证明是"按 provider 粒度"生灭，不是整库清空
    console.log('  5.4 spawn 不受影响仍在：', jobs.getProvider('spawn-in-process') ? 'OK' : 'FAIL')

    // 结束（forkFiber 已 dispose；spawnFiber 随进程退出自然清理）
    void spawnFiber
    console.log('\n==== 结束 ====')
    process.exit(0)
  },
}

export default subagentRunner
