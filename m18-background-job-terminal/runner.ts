/**
 * m18 · 后台 Job 与 Terminal —— 主插件（Consumer 视角 + 装配）
 *
 * 本文件是 cordis.yml 里唯一的 entry（主插件）。它在 apply 里完成"插件式装配"：
 *   1. ctx.plugin(Jobs, config)                      → 注册 Jobs 服务（单例）
 *   2. ctx.plugin(subprocessProducerPlugin)          → 加载"一次性命令"能力插件
 *   3. ctx.plugin(terminalProducerPlugin)            → 加载"持久终端"能力插件
 *   4. 运行 5 个实验
 *
 * 关键：Jobs / 两个 producer 都是"插件"，由主插件用 ctx.plugin 在同一个 fiber 内
 * 装配起来——这正是"一切皆为插件"的落点：连"能跑什么后台任务"也是插件贡献的。
 *
 * runner 实验只调用 ctx.jobs 的 start/list/poll/stop/send，完全不知道
 * subprocess/terminal 内部怎么跑——kind 无关的薄控制器（对标真实 harness 的 jobs API）。
 *
 * 5 个实验：
 *   1. 启动 subprocess 任务，拿到 id，poll 增量输出；
 *   2. 启动 terminal 持久会话，连续 send 两条命令，状态跨命令保留；
 *   3. stop / kill：发 SIGTERM，producer 回报 killed；
 *   4. owner 隔离：用错误 owner 去 stop → 精确归属鉴权拒绝；
 *   5. 完成通知：监听 jobs/event，任务终态时收到 done 事件；
 *   6. 可扩展性（"一切皆为插件"落点）：新增 docker-runner kind 无需改 Jobs，
 *      且卸载该插件 → 该 kind 从 Jobs 消失。
 */

import { Context } from '@deepseek-ai/cordis'
import { Jobs, type JobEvent } from './jobs.ts'
import { subprocessProducerPlugin, terminalProducerPlugin, dockerRunnerProducerPlugin } from './producers.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const jobRunner = {
  name: 'job-runner',
  inject: ['jobs'],
  async apply(ctx: Context): Promise<void> {
    // Jobs 服务由 cordis.yml 的 `./jobs.ts` entry 注册（配置驱动、单例）；
    // 此处主插件只负责把"能跑什么类型任务"这两个能力以插件形式挂进来。
    // 配置说明见 cordis.yml 的 jobs entry（defaultOwner / maxConcurrent）。

    // ── 用 ctx.plugin 加载两个"producer 能力"插件（await 确保注册完成）──
    await ctx.plugin(subprocessProducerPlugin)
    await ctx.plugin(terminalProducerPlugin)
    console.log('[装配] subprocess/terminal 两个 producer 插件已挂载到 Jobs 服务\n')

    const jobs = ctx.jobs as Jobs
    console.log('==== m18 后台 Job 与 Terminal ====\n')

    // ── 实验 5 前置：监听完成通知（先挂监听，后面实验自然触发） ──
    const dones: string[] = []
    ctx.on('jobs/event', (payload: { id: string; event: JobEvent }) => {
      const { id, event } = payload
      if (event.type === 'done') {
        dones.push(`${id}->${event.status}(${event.detail ?? ''})`)
        console.log(`  [notify] jobs/event: ${id} 终态=${event.status} ${event.detail ?? ''}`)
      }
    })

    // ── 实验 1：subprocess 任务 + 增量 poll ─────────────────────
    console.log('\n[实验 1] 启动 subprocess 任务（echo + sleep），poll 增量输出：')
    const id1 = await jobs.start({ kind: 'subprocess', label: 'say-hi', args: { command: 'echo hello-from-subprocess; sleep 0.2; echo done' } })
    console.log('  拿到 job id =', id1, '| list 长度 =', jobs.list().length)
    let acc1 = ''
    for (let i = 0; i < 20; i++) {
      const chunks = jobs.poll(id1)
      if (chunks.length) { acc1 += chunks.join(''); process.stdout.write('  · ' + chunks.join('').trimEnd() + '\n') }
      if (jobs.list().find(j => j.id === id1)!.status !== 'running') break
      await sleep(30)
    }
    console.log('  聚合输出含 hello-from-subprocess：', acc1.includes('hello-from-subprocess') ? 'OK' : 'FAIL')

    // ── 实验 2：terminal 持久会话（状态跨命令保留） ──────────────
    console.log('\n[实验 2] 启动 terminal 持久会话，连续 send 两条命令：')
    const id2 = await jobs.start({ kind: 'terminal', label: 'shell', args: { shell: 'bash' } })
    console.log('  拿到 job id =', id2)
    await sleep(200)
    jobs.send(id2, 'export GREET=hi-terminal') // 状态留在会话里
    await sleep(300)
    jobs.poll(id2) // 清掉命令回显
    jobs.send(id2, 'echo $GREET') // 读取同一变量，证明状态保留
    await sleep(300)
    const termOut = jobs.poll(id2).join('')
    console.log('  读取 $GREET 输出：', JSON.stringify(termOut.trim().slice(-30)))
    console.log('  会话状态跨命令保留（读到 hi-terminal）：', termOut.includes('hi-terminal') ? 'OK' : 'FAIL')
    await jobs.stop(id2, undefined, 'SIGTERM')
    await sleep(100)

    // ── 实验 3：stop / kill ───────────────────────────────────
    console.log('\n[实验 3] 启动长任务并 SIGTERM 停止：')
    const id3 = await jobs.start({ kind: 'subprocess', label: 'long', args: { command: 'sleep 5; echo should-not-print' } })
    await sleep(50)
    await jobs.stop(id3, undefined, 'SIGTERM')
    await sleep(100)
    const st3 = jobs.list().find(j => j.id === id3)!.status
    console.log('  停止后状态 =', st3, '| 应为 killed：', st3 === 'killed' ? 'OK' : 'FAIL')

    // ── 实验 4：owner 隔离（精确归属鉴权） ─────────────────────
    console.log('\n[实验 4] owner 隔离：用错误 owner 去 stop 应被拒绝：')
    const id4 = await jobs.start({ kind: 'subprocess', label: 'owner-test', args: { command: 'sleep 3' } }, 'alice')
    console.log('  alice 的任务 id =', id4)
    try {
      await jobs.stop(id4, 'bob') // bob 非 owner
      console.log('  FAIL: 未拒绝（不符合预期）')
    } catch (e) {
      console.log('  OK 归属鉴权拒绝：', (e as Error).message.split('，')[0])
    }
    await jobs.stop(id4, 'alice') // alice 自己能停
    await sleep(80)

    // ── 实验 5：完成通知汇总 ─────────────────────────────────
    console.log('\n[实验 5] 完成通知汇总（jobs/event done 事件）：')
    await sleep(150)
    console.log('  收到的终态通知：', dones.length ? dones.join(' | ') : '(无)')
    console.log('  通知覆盖实验1/2/3：',
      dones.some(d => d.includes(id1)) && dones.some(d => d.includes(id2)) && dones.some(d => d.includes(id3)) ? 'OK' : 'FAIL')

    // ── 实验 6：可扩展性——"一切皆为插件"的真正落点 ──────────────
    // 关键主张："新增一种后台任务（如 docker-runner），只需再写一个插件，
    // 无需改 Jobs 一行代码"；且"卸载该插件 → 该 kind 从 Jobs 消失"。
    // 下面用真实注册/卸载动作验证这两句，而不是只停留在文档文字。
    console.log('\n[实验 6] 可扩展性：新增 docker-runner 无需改 Jobs + 卸载即消失：')

    // 6.1 加载 docker-runner 插件（与 subprocess/terminal 完全对等的注册动作）
    const dockerFiber = await ctx.plugin(dockerRunnerProducerPlugin)
    const id6a = await jobs.start(
      { kind: 'docker-runner', label: 'run-nginx', args: { image: 'nginx:alpine', cmd: 'echo hi' } },
    )
    let acc6 = ''
    for (let i = 0; i < 20; i++) {
      const chunks = jobs.poll(id6a)
      if (chunks.length) { acc6 += chunks.join('') }
      if (jobs.list().find(j => j.id === id6a)!.status !== 'running') break
      await sleep(30)
    }
    console.log('  6.1 新 kind 跑通（输出含 docker-runner）：',
      acc6.includes('docker-runner') ? 'OK' : 'FAIL')
    console.log('      （Jobs 服务源码未改动，仅靠插件 registerProducer 贡献该能力）')

    // 6.2 卸载 docker-runner 插件（dispose 触发其 ctx.effect 返回的 disposer）
    await dockerFiber.dispose()
    console.log('  6.2 已卸载 docker-runner 插件')

    // 6.3 再 start 同一 kind → 应报"未注册"（kind 已从 Jobs 消失）
    let removedOK = false
    try {
      await jobs.start({ kind: 'docker-runner', label: 'x', args: {} })
      console.log('  FAIL: kind 仍可被启动（不符合"卸载即消失"）')
    } catch (e) {
      removedOK = (e as Error).message.includes('未注册')
      console.log('  OK kind 已消失：', (e as Error).message)
    }
    console.log('  6.3 卸载后该 kind 不可启动：', removedOK ? 'OK' : 'FAIL')

    console.log('\n==== 结束 ====')
    await sleep(300)
    process.exit(0)
  },
}

export default jobRunner
