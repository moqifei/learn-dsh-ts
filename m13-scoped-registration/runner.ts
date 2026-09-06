import { Context } from '@deepseek-ai/cordis'
import { createScope, ScopeRegistry } from './scope.ts'
import { Toolbox } from './registry.ts'

// 自定义事件名声明到 cordis 的 Events 接口，让 ctx.on 类型通过
declare module '@deepseek-ai/cordis' {
  interface Events {
    greet: (name: string) => void
    query: (q: string) => void
  }
}

/**
 * m13 runner —— 作用域注册实验
 *
 * 运行：node --experimental-strip-types runner.ts
 *
 * 设计：全局 root ctx 上挂两个基础 Service（scopes / tools）。
 * 每个 agent = 一个 scope（createScope(root, key) 返回一个带 tag 的子 context）。
 * agent 的能力（工具、监听器、子插件）都注册在各自的 scope ctx 上，
 * 因此互不可见；scope.dispose() 即回收该 agent 的全部注册。
 *
 * 所有实验逻辑包在 master plugin 里（声明 inject，以合法访问全局 services）。
 */

const root = new Context()
root.plugin(ScopeRegistry)
root.plugin(Toolbox)

const app = (ctx: Context) => {
  const rootCtx = ctx

  // 工具：在指定作用域下注册一个工具
  function registerToolIn(scopeCtx: Context, name: string, desc: string) {
    rootCtx.tools.register(scopeCtx, { name, desc })
  }

  // ── 实验 1：多 agent 作用域隔离 ──────────────────────────────────────
  async function exp1_isolation() {
    console.log('\n=== 实验 1：多 agent 作用域隔离 ===')
    const a = await createScope(rootCtx, 'agent-A')
    const b = await createScope(rootCtx, 'agent-B')
    rootCtx.scopes.register(a)
    rootCtx.scopes.register(b)

    registerToolIn(a.ctx, 'echo', '回声工具')
    registerToolIn(b.ctx, 'calc', '计算器工具')

    console.log('agent-A 工具箱:', rootCtx.tools.list(a.ctx).map((t) => t.name))
    console.log('agent-B 工具箱:', rootCtx.tools.list(b.ctx).map((t) => t.name))

    const aSeesCalc = rootCtx.tools.get(a.ctx, 'calc')
    const bSeesEcho = rootCtx.tools.get(b.ctx, 'echo')
    console.log(`A 能否看到 calc？ ${aSeesCalc ? '能(×错)' : '不能(√对)'} | B 能否看到 echo？ ${bSeesEcho ? '能(×错)' : '不能(√对)'}`)
  }

  // ── 实验 2：销毁作用域 → 注册自动回收 ───────────────────────────────
  async function exp2_disposeCleansUp() {
    console.log('\n=== 实验 2：销毁作用域 → 注册自动回收 ===')
    const c = await createScope(rootCtx, 'agent-C')
    rootCtx.scopes.register(c)
    registerToolIn(c.ctx, 'timer', '定时器工具')
    console.log('销毁前 agent-C 工具箱:', rootCtx.tools.list(c.ctx).map((t) => t.name))
    console.log('销毁前全局 dump:', JSON.stringify(rootCtx.tools.dumpAll()))

    await rootCtx.scopes.dispose('agent-C')
    console.log('销毁后全局 dump:', JSON.stringify(rootCtx.tools.dumpAll()))
    console.log(`agent-C 桶是否已清空？ ${!rootCtx.tools.dumpAll()['agent-C'] ? '是(√对)' : '否(×错)'}`)
  }

  // ── 实验 3：作用域内的监听器（事件随作用域存在/消亡）─────────────────
  async function exp3_scopedListeners() {
    console.log('\n=== 实验 3：作用域内的监听器随作用域存在/消亡 ===')
    const d = await createScope(rootCtx, 'agent-D')
    rootCtx.scopes.register(d)

    let hits = 0
    d.ctx.on('greet', (name: string) => {
      hits++
      console.log(`  [agent-D 监听器] 收到 greet: ${name}`)
    })

    d.ctx.events.emit('greet', 'alice')
    console.log(`agent-D 监听器命中次数: ${hits}（应为 1）`)

    await rootCtx.scopes.dispose('agent-D')
    d.ctx.events.emit('greet', 'bob') // 已 dispose，不会命中
    console.log(`销毁后命中次数: ${hits}（仍为 1，监听器已随作用域卸载）`)
  }

  // ── 实验 4：整个 agent 作为"一个插件"挂进作用域，随 scope 卸载 ────────
  async function exp4_pluginInScope() {
    console.log('\n=== 实验 4：agent 能力作为插件挂进作用域，随 scope 卸载 ===')

    const e = await createScope(rootCtx, 'agent-E')
    rootCtx.scopes.register(e)

    // agent-E 的能力包：注册一个工具 + 一个事件处理
    const agentECapabilities = (c: Context) => {
      rootCtx.tools.register(c, { name: 'search', desc: '搜索工具' })
      c.on('query', (q: string) => console.log(`  [agent-E] 处理查询: ${q}`))
    }
    ;(agentECapabilities as any).inject = ['tools']

    await e.ctx.plugin(agentECapabilities)
    console.log('agent-E 工具箱:', rootCtx.tools.list(e.ctx).map((t) => t.name))
    e.ctx.events.emit('query', '天气')

    await rootCtx.scopes.dispose('agent-E')
    console.log('销毁 agent-E 后全局 dump:', JSON.stringify(rootCtx.tools.dumpAll()))
    console.log('agent-E 能力已随作用域整体卸载 ✓')
  }

  // ── 实验 5：effect 清理 vs 手动 dispose —— 定时器随 scope 销毁自动停止 ──
  async function exp5_effectVsDispose() {
    console.log('\n=== 实验 5：ctx.effect 注册的定时器随 scope 销毁自动停止 ===')
    console.log('（观察：F-scope 的定时器在 dispose 后停止；S-scope 的继续跑）')

    const f = await createScope(rootCtx, 'agent-F') // 将被销毁
    const s = await createScope(rootCtx, 'agent-S') // 保留
    rootCtx.scopes.register(f)
    rootCtx.scopes.register(s)

    let fTicks = 0
    let sTicks = 0

    // 在 F 的 scope 内用 ctx.effect 注册一个定时器（贴上"临终遗书"）
    f.ctx.effect(() => {
      const id = setInterval(() => {
        fTicks++
        console.log(`  [agent-F 定时器 tick ${fTicks}]`)
      }, 200)
      return () => clearInterval(id) // effect 的清理回调：fiber.dispose 时自动调用
    })

    // 在 S 的 scope 内同样注册一个（用于对照，不会被销毁）
    s.ctx.effect(() => {
      const id = setInterval(() => {
        sTicks++
        console.log(`  [agent-S 定时器 tick ${sTicks}]`)
      }, 200)
      return () => clearInterval(id)
    })

    console.log('  等待 500ms（两scope应都还在跑）...')
    await new Promise((r) => setTimeout(r, 500))
    console.log(`  阶段一：F=${fTicks} tick, S=${sTicks} tick`)

    // 主动销毁 F 作用域（手动 dispose → 内部 fiber.dispose → 自动跑 F 的 effect 清理）
    await rootCtx.scopes.dispose('agent-F')
    console.log(`  已 dispose agent-F → 其定时器应被 effect 清理回调自动 clearInterval`)

    const fBefore = fTicks
    console.log('  再等待 500ms（F 应停，S 应继续）...')
    await new Promise((r) => setTimeout(r, 500))
    console.log(`  阶段二：F=${fTicks} tick（应不再增长）, S=${sTicks} tick（应继续增长）`)

    const fStopped = fTicks === fBefore
    const sContinued = sTicks > fBefore
    console.log(`  F 定时器是否已停？ ${fStopped ? '是(√对)' : '否(×错)'} | S 定时器是否继续？ ${sContinued ? '是(√对)' : '否(×错)'}`)

    // 收尾：把对照用的 S 也清掉，避免进程挂起
    await rootCtx.scopes.dispose('agent-S')
  }

  // ── 主流程 ──────────────────────────────────────────────────────────
  return (async () => {
    console.log('=== m13 作用域注册 (Scoped Registration) ===')
    await exp1_isolation()
    await exp2_disposeCleansUp()
    await exp3_scopedListeners()
    await exp4_pluginInScope()
    await exp5_effectVsDispose()
    console.log('\n=== 全部实验完成 ===')
  })()
}
;(app as any).inject = ['scopes', 'tools']

// 用 cordis 加载 master plugin：其 inject 声明会让 ctx 合法访问 scopes / tools
root.plugin(app as any).then(
  () => {},
  (err: unknown) => {
    console.error(err)
    // @ts-ignore
    globalThis.process?.exit?.(1)
  },
)
