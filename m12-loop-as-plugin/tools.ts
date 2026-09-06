/**
 * m12 · Loop 也是插件 · 能力服务（四）：Tools
 * ---------------------------------------------------------------------------
 * 真实工程对照：deepseek-harness `packages/core/tools` 的 ToolRegistry。
 * 课程版简化为"注册表 + 直接执行"（m10 讲"工具即插件"、m11 讲"策略包裹执行"，
 * 这里不再展开，只暴露 `register` / `schemas` / `execute` 三个方法给 Loop 用）。
 */

import { Context, Service } from '@deepseek-ai/cordis'

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => unknown
}

export interface ToolResult {
  callId: string
  name: string
  content: unknown
  isError: boolean
}

export class ToolRegistry extends Service {
  static inject = [] as const
  private defs: Map<string, ToolDef> = new Map()

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'tools')
    void config
  }

  /** 注册一个工具（由工具插件调用）。 */
  register(def: ToolDef): void {
    this.defs.set(def.name, def)
    console.log(`    🔧 工具注册：${def.name}`)
  }

  /** 投影当前所有工具的 schema（OpenAI 兼容），供 LLM 请求使用。 */
  schemas(): Array<Record<string, unknown>> {
    return [...this.defs.values()].map((d) => ({
      type: 'function',
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }))
  }

  /** 执行一次调用；未知工具或异常都被归一化为 ToolResult。 */
  async execute(call: { id: string; name: string; arguments: Record<string, unknown> }): Promise<ToolResult> {
    const def = this.defs.get(call.name)
    if (!def) {
      return { callId: call.id, name: call.name, content: `unknown tool: ${call.name}`, isError: true }
    }
    try {
      const value = await def.execute(call.arguments)
      return { callId: call.id, name: call.name, content: value, isError: false }
    } catch (err) {
      return {
        callId: call.id,
        name: call.name,
        content: `${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }

  /** 暴露内部定义，便于实验里"卸载某个工具"。 */
  has(name: string): boolean {
    return this.defs.has(name)
  }

  /** 反注册一个工具（供 effect disposer 调用，实现热卸载）。 */
  unregister(name: string): void {
    this.defs.delete(name)
    console.log(`    🔧 工具卸载：${name}`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRegistry
  }
}

export default ToolRegistry
