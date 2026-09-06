import { Context, Service } from '@deepseek-ai/cordis'
import { scopeOf } from './scope.ts'
import type { ScopeKey } from './scope.ts'

/**
 * m13 · 作用域注册 — 作用域感知的注册表
 *
 * 这个文件演示"作用域注册"最关键的一条性质：
 *
 *    在某个作用域下注册的东西，只在该作用域（及其后代）可见；
 *    该作用域被销毁时，这些东西随之失效。
 *
 * 我们用一个全局的 `Toolbox` Service 来表达"工具注册表"，但它**按作用域分桶**：
 * 每次 register 都带上"当前作用域的 ctx"，工具落进该作用域对应的桶里。
 * 这样：
 *   - agent-A 注册的工具，落在 A 桶；agent-B 的落在 B 桶 → 互不可见；
 *   - 某作用域被 dispose 时，ScopeRegistry 发出 `scope/disposed` 事件，
 *     对应桶被清空 → 该 agent 的注册自动回收，不泄漏。
 *
 * 这对应 deepseek-harness 真实工程里：
 *   - 每个 agent 是一个 scope（`createScope`）
 *   - agent 内注册的能力（tools / handlers / listeners）都是"作用域内的注册"
 *   - agent 退出 → scope dispose → 一切清理干净，不会泄漏到别的 agent。
 *
 * 注：cordis 的 Service 名是全局唯一的（同一名字只能注册一次），所以这里
 * 用"单个全局 Toolbox + 按作用域分桶"来表达，而非"每个作用域一个同名 Service"。
 * 但核心思想一致：注册与生命周期都绑定在作用域（context 子树）上。
 */

export interface Tool {
  name: string
  /** 工具描述（用于展示 / 演示可见性） */
  desc: string
  /** 谁注册了它（作用域 key），方便实验观察 */
  owner: ScopeKey
}

/**
 * Toolbox：一个全局的、作用域感知的工具注册表。
 *
 * - register(scopeCtx, tool)：把工具登记进 scopeCtx 所属作用域的桶。
 * - list(scopeCtx) / get(scopeCtx, name)：只返回该作用域可见的工具。
 * - 监听 `scope/disposed`：作用域销毁时清空对应桶。
 */
export class Toolbox extends Service {
  static inject = ['scopes'] as const

  // 按作用域分桶存储：key -> 该 agent 的工具们
  private byScope = new Map<ScopeKey, Map<string, Tool>>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
    // 任何作用域销毁时，清掉它对应的桶（演示"登记 + 自动回收"）
    ctx.on('scope/disposed', (key) => this.byScope.delete(key))
  }

  /**
   * 在指定作用域的 ctx 下注册一个工具。
   * 必须传入某个 scope 的 ctx（用于确定作用域归属）。
   */
  register(scopeCtx: Context, tool: Omit<Tool, 'owner'>): void {
    const key = scopeOf(scopeCtx)
    if (key === undefined) {
      throw new Error('[Toolbox] register 必须传入某个作用域的 ctx（ctx 没有 scope）')
    }
    let bucket = this.byScope.get(key)
    if (!bucket) {
      bucket = new Map()
      this.byScope.set(key, bucket)
    }
    bucket.set(tool.name, { ...tool, owner: key })
    console.log(`  [tools] 在作用域 ${key} 注册工具 ${tool.name}`)
  }

  /** 列出指定作用域 ctx 可见的工具（即该 agent 的工具箱）。 */
  list(scopeCtx: Context): Tool[] {
    const key = scopeOf(scopeCtx)
    if (key === undefined) return []
    return [...(this.byScope.get(key)?.values() ?? [])]
  }

  /** 按名字在指定作用域查找工具。 */
  get(scopeCtx: Context, name: string): Tool | undefined {
    const key = scopeOf(scopeCtx)
    if (key === undefined) return undefined
    return this.byScope.get(key)?.get(name)
  }

  /** 调试用：全局所有作用域的工具总览（跨作用域并不可见，但可用于观察隔离）。 */
  dumpAll(): Record<ScopeKey, string[]> {
    const out: Record<string, string[]> = {}
    for (const [k, v] of this.byScope) out[k] = [...v.keys()]
    return out
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: Toolbox
  }
}
