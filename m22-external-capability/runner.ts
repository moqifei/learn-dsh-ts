/**
 * m22 · 外部能力接入（消费者 + 装配）
 *
 * 消费者（Agent Loop 视角）只做三件事：
 *   1. ctx.external.schemas()  —— 看到 ALL 能力的工具菜单（core + mcp + web + lsp 混在一起）
 *   2. ctx.external.execute(name, args) —— 按 name 分发，从不关心是哪个 Provider
 *   3. 选中的能力来自外部连接还是进程内函数，对循环完全透明
 *
 * 这就是"一切皆为插件"的运行时证据：新增一个外部能力 = 挂载一个新 Provider 插件，
 * Agent Loop 一行都不用改。
 */

import { Context } from '@deepseek-ai/cordis'
import type { CapabilityRuntime } from './external.js'

const runnerPlugin = {
  name: 'external-runner',
  inject: ['external'],
  async apply(ctx: Context) {
    const ext = ctx.external as CapabilityRuntime

    // 等待 Provider 插件（含 web/lsp 异步 effect）完成注册与连接。
    const deadline = Date.now() + 3000
    while (ext.namespaces().length < 4 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }

    console.log('==== m22 外部能力接入 ====\n')

    // [实验1] 发现：一个注册表投影出全部能力（core / mcp / web / lsp 同树）。
    console.log('[发现] 当前能力命名空间:')
    for (const ns of ext.namespaces()) console.log(`  - ${ns}`)

    const schemas = ext.schemas()
    console.log(`\n[投影] 模型可见工具菜单（${schemas.length} 个，core 与 external 混排）:`)
    for (const s of schemas) console.log(`  • ${s.name}: ${s.description}`)

    // [实验2] 执行 core 工具（进程内函数，无连接）。
    const add = await ext.execute('cap__core__add', { a: 2, b: 3 })
    console.log(`\n[执行] cap__core__add(2,3) =`, add)

    // [实验3] 执行 external 工具：mcp（子进程/连接转发）。
    const len = await ext.execute('cap__mcp__length', { s: 'hello world' })
    console.log(`[执行] cap__mcp__length("hello world") =`, len)

    // [实验4] 执行 external 工具：web（真实跨网络边界）。
    try {
      const status = await ext.execute('cap__web__status', {})
      console.log(`[执行] cap__web__status() =`, JSON.stringify(status))
    } catch (e) {
      console.log(`[执行] cap__web__status() 失败（演示连接边界）:`, String(e))
    }

    // [实验5] 执行 external 工具：lsp（真实跨进程边界）。
    try {
      const symbols = await ext.execute('cap__lsp__symbol', { query: 'Capability' })
      console.log(`[执行] cap__lsp__symbol("Capability") =`, JSON.stringify(symbols))
    } catch (e) {
      console.log(`[执行] cap__lsp__symbol() 失败（演示进程边界）:`, String(e))
    }

    // [实验6] 一切皆为插件：core 与 external 工具在同一 schemas() 里，循环不分支。
    const fromCore = schemas.some(s => s.name === 'cap__core__add')
    const fromExternal = schemas.some(s => s.name.startsWith('cap__mcp__') || s.name.startsWith('cap__web__') || s.name.startsWith('cap__lsp__'))
    console.log(`\n[一切皆为插件] core 工具在树中: ${fromCore ? '✅' : '❌'}；external 工具在树中: ${fromExternal ? '✅' : '❌'}`)
    console.log('  Loop 调用 schemas()/execute(name) 时，不区分 cap__core__ / cap__mcp__ / cap__web__ / cap__lsp__')

    console.log('\n==== 结束（外部能力 = 挂载进同一工具树的插件） ====')
    process.exit(0)
  },
}

export default runnerPlugin
