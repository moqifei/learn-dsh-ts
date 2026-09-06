import { Context, Service, Fiber } from '@deepseek-ai/cordis'

/**
 * m13 · 作用域注册 — 作用域原语
 *
 * 这一文件对应 deepseek-harness 的 `packages/core/scope` 包。
 * 真实工程里那一套有 ScopeKey / Scoped / Scope / ScopeLayer / ScopedLayers 五个概念，
 * 对于"学习作用域注册"这个目标来说过于重了。我们抽取它最本质的三件事，
 * 用 cordis 自带的 context 子树来表达：
 *
 *   1. createScope(parent, key) —— 在某个父 context 下 mint 一个带 tag 的子 context，
 *                                  这个子 context 就是"一个作用域"。
 *   （核心思想：把"某个 agent 的全部注册"挂在一个子树里，dispose 这棵子树即可整体回收。）
 *
 * 为什么用 cordis 的 context 子树表达作用域？因为：
 *   - 在 scope ctx 上调用 ctx.plugin(...) / ctx.on(...) / ctx.effect(...) 产生的所有注册，
 *     都挂在这个子树里；
 *   - 调用 scopeCtx 的 fiber.dispose() 即可一次性回收该作用域的一切，
 *     不需要手动记住、逐个卸载。这正是"作用域 = 注册的生命周期 + 可见性边界"。
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
 * 做法与 deepseek-harness 真实实现一致：
 *   const fiber = await ctx.plugin(scopePlugin)   // 在该父 context 下挂一个 fiber
 *   fiber.ctx.extend({ scopeKey: key })            // 给 fiber 的子 context 打上 tag
 * 返回这个带 tag 的 ctx 及其销毁器。
 *
 * @param parent 父 context（通常是全局根 ctx）
 * @param key    作用域 key，例如某个 agent 的 id
 */
export async function createScope(parent: Context, key: ScopeKey): Promise<Scope> {
  // 用一个空插件在该父 context 下建立一棵子树（fiber）；
  // 之后所有"这个作用域的注册"都挂在这棵子树上。
  const fiber = await parent.plugin(() => {})

  // 用 extend 给 fiber 的子 context 打上 scopeKey 标记（own property，
  // 不会触发 proxy 的 provide 检查），便于 scopeOf 直接读取。
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
 * 对应真实工程里 `scopeOf(ctx)` 返回最近一层的 ScopeKey。
 *
 * 在简版里，createScope 给 fiber 的子 context 打了 scopeKey 标记，
 * 所以我们从 ctx 自身向上找第一个带 scopeKey 的祖先即可。
 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  let cur: Context | undefined = ctx
  while (cur) {
    const key = (cur as any).scopeKey as ScopeKey | undefined
    if (key !== undefined) return key
    // 走向父 context：cordis 中通过 root 链，这里用 reflect 的 parent 字段
    cur = (cur as any).parent as Context | undefined
  }
  return undefined
}

/**
 * 一个最小的作用域管理 Service（对应真实工程 scope 包的"作用域注册表"概念）。
 * 它负责：
 *   - 登记所有活跃作用域（key -> Scope）
 *   - 按 key 取回作用域
 *   - dispose 某个作用域（回收其全部注册）
 *
 * 它自身也是个 Service，挂在全局 ctx 上，所以所有作用域共享它。
 */
export class ScopeRegistry extends Service {
  static inject = [] as const
  private scopes = new Map<ScopeKey, Scope>()

  constructor(ctx: Context) {
    super(ctx, 'scopes')
  }

  /** 登记一个作用域（通常在 createScope 之后调用）。 */
  register(scope: Scope) {
    this.scopes.set(scope.key, scope)
    // 作用域销毁时从登记表里移除
    this.ctx.on('scope/disposed', (key) => {
      if (key === scope.key) this.scopes.delete(key)
    })
  }

  /** 取得某作用域对象；没有则返回 undefined。 */
  get(key: ScopeKey): Scope | undefined {
    return this.scopes.get(key)
  }

  /** 当前活跃的所有作用域 key。 */
  keys(): ScopeKey[] {
    return [...this.scopes.keys()]
  }

  /** 销毁一个作用域。 */
  async dispose(key: ScopeKey) {
    const scope = this.scopes.get(key)
    if (scope) await scope.dispose()
  }
}

// 让 ScopeRegistry 作为一个可注入 Service 被识别
declare module '@deepseek-ai/cordis' {
  interface Context {
    scopes: ScopeRegistry
  }
}
