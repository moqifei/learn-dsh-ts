/**
 * StageProvider 插件实现层 —— "一切皆为插件"的可替换驱动边界。
 *
 * 两个对等插件：
 *  - local-echo：本地模拟阶段执行（默认，输出含标记，便于断言未重跑）；
 *  - remote：模拟"远程 worker"驱动（对应真实 workflow-worker-thread）；
 *            刻意输出不同签名，用来证明"换 provider 不改 Runtime、不改 journal 验证语义"。
 *
 * 两者都通过 registerProvider 注入 WorkflowService，并被 ctx.effect 的 disposer 管理生命周期。
 * 真实工程里还可有 subagent-driven provider（复用 m19 Subagent Definition），本课聚焦"可替换"本身。
 */
import { Context } from '@deepseek-ai/cordis'
import { StageProvider, Stage, WorkflowService } from './workflow.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── Provider 1：local-echo（默认驱动）──────────────────────────────
class LocalEchoProvider implements StageProvider {
  readonly name = 'local-echo'
  async run(stage: Stage, renderedPrompt: string, requestId: string): Promise<string> {
    await sleep(20)
    // 用 stage.id 做确定性输出，便于恢复后逐字节复用、证明未重跑
    return `[${this.name}|${requestId}] ${stage.id} => ${renderedPrompt.slice(0, 40)}`
  }
}

// ── Provider 2：remote（演示可替换驱动边界）────────────────────────
class RemoteProvider implements StageProvider {
  readonly name = 'remote'
  async run(stage: Stage, renderedPrompt: string, requestId: string): Promise<string> {
    await sleep(30)
    return `[${this.name}|${requestId}] (via remote worker) ${stage.id} => ${renderedPrompt.slice(0, 40)}`
  }
}

// ── 插件对象（与 m18/m19 完全对等）─────────────────────────────────
export const localEchoProviderPlugin = {
  name: 'workflow-provider-local-echo',
  inject: ['workflows'],
  apply(ctx: Context): void {
    const disposer = (ctx.workflows as WorkflowService).registerProvider(new LocalEchoProvider())
    console.log('  [插件] 注册 stage provider="local-echo"（默认驱动）')
    ctx.effect(() => disposer)
  },
}

export const remoteProviderPlugin = {
  name: 'workflow-provider-remote',
  inject: ['workflows'],
  apply(ctx: Context): void {
    const disposer = (ctx.workflows as WorkflowService).registerProvider(new RemoteProvider())
    console.log('  [插件] 注册 stage provider="remote"（可替换驱动，演示一切皆为插件）')
    ctx.effect(() => disposer)
  },
}
