/**
 * Provider 插件实现层的示例。
 *
 * 两个 Provider 都是**对等插件**：
 *  - spawn-in-process：复用当前进程/服务做轻量子代理（对应真实 packages/subagent-dsh-sdk）；
 *  - fork：模拟"独立分叉的子代理"（本课新增，演示可扩展）；
 *
 * 它们都通过 registerProvider 把自己注入 Runtime，并让 ctx.effect 返回 disposer，
 * 从而使"卸载插件 → 该 provider 从 Runtime 消失"。Runtime 源码不感知任何具体 Provider。
 */
import { Context } from '@deepseek-ai/cordis'
import {
  SubagentProvider,
  SubagentRun,
  SubagentRuntime,
  SubagentStartRequest,
  SubagentResult,
} from './subagents.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ───────────────────────────────────────────────────────────────
// Provider 1：spawn-in-process（真实存在；支持 outputSchema）
// ───────────────────────────────────────────────────────────────
class SpawnInProcessProvider implements SubagentProvider {
  readonly name = 'spawn-in-process'
  readonly capabilities = { outputSchema: true, persona: true }
  readonly inheritsParentContext = true

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const id = `spawn-${Math.random().toString(36).slice(2, 8)}`
    const result: Promise<SubagentResult> = (async () => {
      await sleep(40)
      // 模拟子代理产出；若要求结构化则以 JSON 包裹
      const body = `我是 ${request.parent} 派生的子代理，收到：${request.prompt}`
      const output = request.outputSchema ? JSON.stringify({ answer: body }) : body
      return { output, stopReason: 'completed' as const }
    })()
    let disposed = false
    return {
      id,
      result,
      async dispose() {
        if (disposed) return
        disposed = true
        await sleep(0)
      },
    }
  }
}

// ───────────────────────────────────────────────────────────────
// Provider 2：fork（演示"一切皆为插件"：新增 kind 无需改 Runtime）
// ───────────────────────────────────────────────────────────────
// 真实工程里可能是 "在独立进程/沙箱里 fork 一个子代理"，这里用 echo 风格模拟，
// 但注册路径（registerProvider + effect disposer）与真实 fork provider 完全一致。
// 注意：它**不支持** outputSchema，用来演示 capability 校验。
class ForkProvider implements SubagentProvider {
  readonly name = 'fork'
  readonly capabilities = { outputSchema: false, persona: false }
  readonly inheritsParentContext = false

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const id = `fork-${Math.random().toString(36).slice(2, 8)}`
    const result: Promise<SubagentResult> = (async () => {
      await sleep(60)
      const body = `fork 子代理（独立上下文）处理：${request.prompt}`
      return { output: body, stopReason: 'completed' as const }
    })()
    let disposed = false
    return {
      id,
      result,
      async dispose() {
        if (disposed) return
        disposed = true
      },
    }
  }
}

// ── 插件对象（与 m18 的 producer 插件完全对等）─────────────────────────
export const spawnInProcessProviderPlugin = {
  name: 'subagent-provider-spawn-in-process',
  inject: ['subagents'],
  apply(ctx: Context): void {
    const disposer = (ctx.subagents as SubagentRuntime).registerProvider(
      new SpawnInProcessProvider(),
    )
    console.log('  [插件] 注册 provider="spawn-in-process"（支持 outputSchema）')
    ctx.effect(() => disposer)
  },
}

export const forkProviderPlugin = {
  name: 'subagent-provider-fork',
  inject: ['subagents'],
  apply(ctx: Context): void {
    const disposer = (ctx.subagents as SubagentRuntime).registerProvider(new ForkProvider())
    console.log('  [插件] 注册 provider="fork"（独立上下文，演示可扩展）')
    ctx.effect(() => disposer)
  },
}
