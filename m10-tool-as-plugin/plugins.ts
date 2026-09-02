/**
 * m10 · 工具即插件 —— 不同子系统各自注册自己的工具
 *
 * 关键：每个工具都是一个独立插件，通过 ctx.tools.register(...) 注册，
 * 并用 ctx.effect(...) 挂上清理（插件卸载 → 该工具自动消失）。
 * 注册放在 ctx.effect 里（与 m09 contributors 同构），保证插件 apply
 * 时立即生效，不依赖嵌套 ctx.plugin 的激活时序。
 *
 * 注意挂载顺序：这里故意"乱序"挂载（memory 先于 add），但工具集是无序
 * 集合——模型可见顺序由 schemas() 决定，不依赖挂载时机。
 */

import { Context } from '@deepseek-ai/cordis'
import type { ToolRegistry } from './tool.ts'

/** 记忆工具贡献的 effect disposer（供 runner 演示"撤销该贡献"）。 */
let readNoteDisposer: (() => void) | null = null

/** 撤销 memory 子系统贡献的 read_note 工具（模拟该插件被卸载）。 */
export function unregisterReadNote(): void {
  readNoteDisposer?.()
  readNoteDisposer = null
}

/** 聚合插件：三个子系统各自贡献一个工具（乱序挂载，集合无序）。 */
export const toolsPlugin = {
  name: 'builtin-tools',
  inject: ['tools'],
  apply(ctx: Context): void {
    const tools = ctx.tools as ToolRegistry

    // 记忆工具 —— 模拟 memory 子系统（乱序，先于 math 挂载）。
    readNoteDisposer = ctx.effect(() => tools.register({
      name: 'read_note',
      description: 'Read a note by its id from the user memory store.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      execute: (args: { id: string }) => {
        return `note[${args.id}]: "buy milk on the way home"`
      },
    }))

    // 搜索工具 —— 模拟检索子系统。
    ctx.effect(() => tools.register({
      name: 'web_search',
      description: 'Search the web and return the top result snippet.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: (args: { query: string }) => {
        return `top result for "${args.query}": "Cordis is a plugin framework."`
      },
    }))

    // 数学工具 —— 模拟计算子系统。
    ctx.effect(() => tools.register({
      name: 'add',
      description: 'Add two numbers and return the sum.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: (args: { a: number; b: number }) => {
        return `${args.a} + ${args.b} = ${args.a + args.b}`
      },
    }))
  },
}

export default toolsPlugin
