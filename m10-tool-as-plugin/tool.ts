/**
 * m10 · ToolRegistry —— 工具即插件（参考 s11，真实 Cordis）
 *
 * 对应 deepseek-harness @deepseek-ai/dsh-tools 的 ToolRuntime。本示例只取
 * 主干，不照抄：注册 / 投影 schema / 分发执行 / 注册即 effect（卸载自动撤销）。
 */

import { Context, Service } from '@deepseek-ai/cordis'

// 让本示例能用 'tools/change' 事件，并把 ctx.tools 注入 Context 类型
// （贴近真实实现的注册/卸载副作用）。
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 有工具注册或卸载（可用工具集变化）时触发。 */
    'tools/change'(): void
  }
  interface Context {
    /** 工具注册表服务（ToolRegistry 实例）。 */
    tools: ToolRegistry
  }
}

/** 模型可见的工具 schema（排除执行函数等内部字段）。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 一次工具调用的结果。 */
export interface ToolResult {
  isError: boolean
  content: string
  /** 结构化返回值（供流水线使用）。 */
  value?: unknown
}

/** 工具定义：schema + 执行函数。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 执行函数：args 已被调用方负责解析/校验（本示例简化为透传）。 */
  execute(args: any): Promise<unknown> | unknown
}

/**
 * 工具注册表服务（ctx.tools）。
 * 注册即 effect：register() 返回的 disposer 在插件卸载时被 cordis 自动调用，
 * 对应工具从注册表消失——这就是"工具即插件"的落地。
 */
export class ToolRegistry extends Service {
  static inject = [] as const
  private tools = new Map<string, ToolDefinition>()

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'tools')
    void config
  }

  /**
   * 注册一个工具。返回的 disposer 在插件卸载时由 cordis 自动调用 → 工具消失。
   * @throws 若同名工具已注册则直接拒绝（真实现在 ScopedLayers 层拦截）。
   */
  register(definition: ToolDefinition): () => void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool "${definition.name}" 已注册（重复贡献直接拒绝）`)
    }
    this.tools.set(definition.name, definition)
    this.ctx.emit('tools/change')
    // 返回 disposer；真实实现里这是个 cordis effect，插件卸载自动撤销。
    return () => {
      this.tools.delete(definition.name)
      this.ctx.emit('tools/change')
    }
  }

  /** 当前注册的全部工具名。 */
  names(): string[] {
    return [...this.tools.keys()]
  }

  /** 投影模型可见的 schema 列表（排除 execute 等内部字段）。 */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  }

  /**
   * 分发执行一个工具调用。未知工具返回结构化错误（真实工程为 UNKNOWN_TOOL）。
   * 调用方负责把模型给的 JSON 解析成 args 并传入。
   */
  async execute(name: string, args: any): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        isError: true,
        content: `Error: unknown tool "${name}"`,
      }
    }
    try {
      const value = await tool.execute(args)
      return {
        isError: false,
        content: typeof value === 'string' ? value : JSON.stringify(value),
        value,
      }
    } catch (err) {
      return {
        isError: true,
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}

export default ToolRegistry
