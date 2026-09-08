import { Context, Service } from '@deepseek-ai/cordis'

/**
 * m16 · 作用域注册 — 作用域原语（从 m13/m15 复用）
 *
 * 一个 Scope 是父 context 下的一棵子树，带一个唯一的 scopeKey 标签。
 * 压缩服务跑在各自的 agent scope 里：每个 agent 的 Session 是作用域局部的，
 * dispose 作用域时整体回收。
 *
 * 这里与 m13/m15 完全一致：用 cordis 的 context 子树表达作用域。
 */

/** 作用域 key 的类型 —— 工程里通常用字符串 id（如 agent id）。 */
export type ScopeKey = string

/** 作用域对象的形状：一个被 tag 的子 context + 它的销毁器。 */
export interface Scope {
  /** 作用域 key */
  key: ScopeKey
  /** 承载该作用域所有注册的子 context（带 scopeKey 标记） */
  ctx: Context
  /** 销毁作用域：卸载其 fiber，回收该作用域的一切注册 */
  dispose(): Promise<void>
  /** 是否已被销毁 */
  disposed: boolean
}

// 让 context 能携带 scopeKey 这个普通字符串属性（extend 的 meta 写入它）
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前 context 所属作用域的 key；顶层 / 不在任何作用域里则为 undefined。 */
    scopeKey?: ScopeKey
  }
  interface Events {
    /** 作用域销毁事件（用于登记表自清理，以及实验观察） */
    'scope/disposed': (key: ScopeKey) => void
  }
}

/**
 * 创建一个作用域（对应真实工程的 `createScope(ctx, key)`）。
 *
 * @param parent 父 context（通常是全局根 ctx）
 * @param key    作用域 key，例如某个 agent 的 id
 */
export async function createScope(parent: Context, key: ScopeKey): Promise<Scope> {
  const fiber = await parent.plugin(() => {})
  const ctx = fiber.ctx.extend({ scopeKey: key } as any)
  const scope: Scope = {
    key,
    ctx,
    disposed: false,
    async dispose() {
      if (scope.disposed) return
      scope.disposed = true
      await fiber.dispose()
      parent.emit('scope/disposed', key)
    },
  }
  return scope
}

/**
 * 沿父链向上查找当前 context 所属的作用域 key。
 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  let cur: Context | undefined = ctx
  while (cur) {
    const key = (cur as any).scopeKey as ScopeKey | undefined
    if (key !== undefined) return key
    cur = (cur as any).parent as Context | undefined
  }
  return undefined
}

/**
 * 一个最小的作用域管理 Service（对应真实工程 scope 包的"作用域注册表"概念）。
 */
export class ScopeRegistry extends Service {
  static inject = [] as const
  private scopes = new Map<ScopeKey, Scope>()

  constructor(ctx: Context) {
    super(ctx, 'scopes')
  }

  register(scope: Scope) {
    this.scopes.set(scope.key, scope)
    this.ctx.on('scope/disposed', (key) => {
      if (key === scope.key) this.scopes.delete(key)
    })
  }

  get(key: ScopeKey): Scope | undefined {
    return this.scopes.get(key)
  }

  keys(): ScopeKey[] {
    return [...this.scopes.keys()]
  }

  async dispose(key: ScopeKey) {
    const scope = this.scopes.get(key)
    if (scope) await scope.dispose()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    scopes: ScopeRegistry
  }
}
