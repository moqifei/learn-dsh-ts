/**
 * m18 · 后台 Job 与 Terminal —— 两个 Job Producer（都是"插件"）
 *
 * 关键教学点：**一切皆为插件**。
 * - Jobs 服务（jobs.ts）本身不知道世界上有哪几种后台任务能跑；
 * - "能跑 subprocess 命令" 是一种能力，"能开一个持久 terminal 会话" 是另一种能力；
 * - 每种能力都是一个独立的 Cordis 插件：通过 ctx.effect 调用 ctx.jobs.registerProducer
 *   把自己的 kind 注入 Jobs。卸载该插件 → 该 kind 从 Jobs 消失。
 *
 * 因此：新增一种后台任务（比如 docker-runner），不需要改 Jobs 一行代码，
 * 只要再写一个插件 registerProducer 即可。这就是"一切皆为插件"。
 */

import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { JobEvent, JobHandle, JobProducer, JobSpec, SendCapableHandle, Jobs } from './jobs.ts'

// ───────────────────────────────────────────────────────────────
// Producer 1：subprocess（一次性命令，如 `echo` / `sleep`）
// ───────────────────────────────────────────────────────────────
class SubprocessProducer implements JobProducer {
  readonly kind = 'subprocess'

  async start(spec: JobSpec, emit: (ev: JobEvent) => void): Promise<JobHandle> {
    const command = String(spec.args.command ?? 'true')
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })

    let settled = false
    const settle = (status: 'completed' | 'failed' | 'killed', detail?: string) => {
      if (settled) return
      settled = true
      emit({ type: 'done', status, detail })
    }

    const onData = (buf: Buffer) => emit({ type: 'output', chunk: buf.toString('utf8') })
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code, signal) => {
      if (signal) settle('killed', `signal=${signal}`)
      else if (code === 0) settle('completed', 'exit=0')
      else settle('failed', `exit=${code}`)
    })

    return {
      async stop(sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
        child.kill(sig === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM')
        await once(child, 'exit').catch(() => {})
      },
      async next() {
        return { chunk: '', done: settled }
      },
    }
  }
}

// ───────────────────────────────────────────────────────────────
// Producer 2：terminal（持久会话：可多次 send 命令、跨命令保留状态）
// ───────────────────────────────────────────────────────────────
// 真实 deepseek-harness 的 terminal 是一个 PTY 会话（bash），命令之间
// 保留工作目录、环境变量等状态。本课用一个单 shell 进程模拟：
// 每次 send 一条命令到 stdin，等其输出收集完返回（SendCapableHandle）。
class TerminalProducer implements JobProducer {
  readonly kind = 'terminal'

  async start(spec: JobSpec, emit: (ev: JobEvent) => void): Promise<SendCapableHandle> {
    // 非交互 bash：从 stdin 逐行读取命令执行，变量 / cwd 等状态跨命令保留。
    // 不进入交互模式（-i 在无 tty 时不可靠），用普通 bash 从 stdin 读脚本。
    const shell = spawn(String(spec.args.shell ?? 'bash'), [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false
    const settle = (status: 'completed' | 'failed' | 'killed', detail?: string) => {
      if (settled) return
      settled = true
      emit({ type: 'done', status, detail })
    }
    shell.on('exit', (code, signal) => {
      if (signal) settle('killed', `signal=${signal}`)
      else settle('completed', `exit=${code}`)
    })

    // 输出实时推到 Jobs 的 outbox（Consumer 用 poll 拉取）。
    const onData = (buf: Buffer) => emit({ type: 'output', chunk: buf.toString('utf8') })
    shell.stdout.on('data', onData)
    shell.stderr.on('data', onData)

    const send = (text: string): void => {
      // 写入一条完整命令（补换行），bash 执行后状态留在会话里。
      shell.stdin.write(text.endsWith('\n') ? text : text + '\n')
    }

    return {
      send,
      async stop(sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
        // bash 非交互进程会响应 SIGTERM；先关 stdin 再发信号，避免管道悬挂。
        try { shell.stdin.end() } catch { /* 已关闭 */ }
        shell.kill(sig === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM')
        await once(shell, 'exit').catch(() => {})
      },
      async next(): Promise<{ chunk: string; done: boolean }> {
        return { chunk: '', done: settled }
      },
    }
  }
}

// ───────────────────────────────────────────────────────────────
// 两个独立 Producer 插件（"一切皆为插件"的具象）：
// - 每个 producer 是一个独立的 Cordis 插件对象（有 name / apply）；
// - 主插件（runner.ts）用 `ctx.plugin(subprocessProducerPlugin)` 把它们加载进
//   同一个 fiber，它们各自在 apply 里把 kind 注册进 Jobs；
// - 卸载某个 producer 插件 → 该 kind 从 Jobs 消失，互不影响。
//
// 真实 deepseek-harness 里这两类能力也是两个独立包
// （@deepseek-ai/dsh-subprocess-local / @deepseek-ai/dsh-bash-local），
// 各自通过注册把自己贡献给统一的 Job 运行时——本课用两个插件对象复刻这一点。
// ───────────────────────────────────────────────────────────────

export const subprocessProducerPlugin = {
  name: 'job-producer-subprocess',
  inject: ['jobs'],
  apply(ctx: Context): void {
    const disposer = (ctx.jobs as Jobs).registerProducer(new SubprocessProducer())
    console.log('  [插件] 注册 kind="subprocess"（一次性命令）')
    ctx.effect(() => disposer)
  },
}

export const terminalProducerPlugin = {
  name: 'job-producer-terminal',
  inject: ['jobs'],
  apply(ctx: Context): void {
    const disposer = (ctx.jobs as Jobs).registerProducer(new TerminalProducer())
    console.log('  [插件] 注册 kind="terminal"（持久会话）')
    ctx.effect(() => disposer)
  },
}

// ───────────────────────────────────────────────────────────────
// Producer 3：docker-runner（演示"一切皆为插件"的可扩展性）
// ───────────────────────────────────────────────────────────────
// 重点不是 docker 本身，而是：这是一个**全新的 kind**，但 Jobs 服务源码
// 一行都没改——只要写一个 Producer 类 + 一个插件对象，registerProducer 即可。
// 卸载该插件（调用其 effect 返回的 disposer）后，kind 从 Jobs 消失。
//
// 这里用 `echo` 模拟 "docker run <镜像>"（避免依赖真实 docker 环境），
// 但 start/emit/disposer 的注册路径与真实 docker-runner 完全一致。
class DockerRunnerProducer implements JobProducer {
  readonly kind = 'docker-runner'

  async start(spec: JobSpec, emit: (ev: JobEvent) => void): Promise<JobHandle> {
    const image = String(spec.args.image ?? 'alpine:latest')
    const cmd = String(spec.args.cmd ?? '/bin/sh -c "echo running-in-container"')
    // 真实工程：spawn('docker', ['run', image, ...])；此处用 echo 模拟容器输出。
    const child = spawn('echo', [`[docker-runner] 容器(${image}) 启动：${cmd}`], { stdio: ['ignore', 'pipe', 'pipe'] })

    let settled = false
    const settle = (status: 'completed' | 'failed' | 'killed', detail?: string) => {
      if (settled) return
      settled = true
      emit({ type: 'done', status, detail })
    }
    const onData = (buf: Buffer) => emit({ type: 'output', chunk: buf.toString('utf8') })
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code, signal) => {
      if (signal) settle('killed', `signal=${signal}`)
      else if (code === 0) settle('completed', 'exit=0')
      else settle('failed', `exit=${code}`)
    })

    return {
      async stop(sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
        child.kill(sig === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM')
        await once(child, 'exit').catch(() => {})
      },
      async next() {
        return { chunk: '', done: settled }
      },
    }
  }
}

/**
 * docker-runner 插件（"一切皆为插件"活化石）：
 * - 它和 subprocess/terminal 是**完全对等**的插件：同样的 registerProducer 写法；
 * - Jobs 服务（jobs.ts）对此一无所知，却能通过 jobs.start({kind:'docker-runner'}) 跑起来；
 * - apply 里把 disposer 交给 ctx.effect：插件卸载时 disposer 触发，kind 从 Jobs 注销。
 */
export const dockerRunnerProducerPlugin = {
  name: 'job-producer-docker-runner',
  inject: ['jobs'],
  apply(ctx: Context): void {
    const disposer = (ctx.jobs as Jobs).registerProducer(new DockerRunnerProducer())
    console.log('  [插件] 注册 kind="docker-runner"（容器任务，演示可扩展）')
    ctx.effect(() => disposer)
  },
}

