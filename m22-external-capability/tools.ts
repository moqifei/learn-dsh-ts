// tools.ts — m22 核心：统一的外部工具注册表（Definition / 接入点）
//
// 设计：外部能力（MCP / Web / LSP / 任意协议）最终都要进入同一个"工具池"。
// 消费方（model loop、agent）只看到一组统一的、带命名空间的工具 schema。
// provider 负责发现/连接/协议细节/teardown；注册表只负责挂载与命名空间归属。
//
// 这一层本身也是一个 Cordis 插件（ExternalToolsService），挂在 ctx.tools 上。
// —— 再一次印证"一切皆为插件"：连"能力接入点"本身也是插件树的一部分。

import { Context, Service } from '@cordisjs/core'
import { Dict } from 'cordis'

// ---- 工具类型 ----

// 一个对外暴露的工具定义。名字是"全局公开名"，由 namespace + 本地名拼成。
export interface ToolDef {
  // 公开名：形如 mcp_demo__checksum / web__fetch / lsp__symbol
  name: string
  namespace: string
  description: string
  // 极简参数 schema（仅 name/type，够教学用）
  parameters: { name: string; type: string; description?: string }[]
  // 可执行行为。返回给消费方的字符串结果。
  invoke(args: Record<string, unknown>): Promise<string> | string
}

// ---- 注册表服务 ----

// 这个类是 Definition：稳定的服务契约。
// provider 通过 register 把工具挂进来；consumer 通过 schemas/list/invoke 使用。
export class ExternalToolsService extends Service {
  // 按公开名索引的工具表
  private tools = new Map<string, ToolDef>()
  // 按 namespace 反向索引，便于整块卸载某个 provider 的贡献
  private byNamespace = new Map<string, Set<string>>()
  // 命名空间冲突检测
  private namespaces = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'tools', true)
  }

  // 注册一批属于同一 namespace 的工具。
  // 返回 disposer：调用后精确移除该 namespace 贡献的所有工具。
  register(namespace: string, defs: ToolDef[]): () => void {
    if (this.namespaces.has(namespace)) {
      throw new Error(`[tools] 重复命名空间: ${namespace}（同一命名空间只能有一个 provider）`)
    }
    // 安装前校验：公开名冲突
    for (const d of defs) {
      if (this.tools.has(d.name)) {
        throw new Error(`[tools] 公开名冲突: ${d.name}`)
      }
    }

    this.namespaces.add(namespace)
    const names = new Set<string>()
    for (const d of defs) {
      this.tools.set(d.name, d)
      names.add(d.name)
    }
    this.byNamespace.set(namespace, names)

    const owned = names
    const ns = namespace
    return () => {
      for (const n of owned) this.tools.delete(n)
      this.byNamespace.delete(ns)
      this.namespaces.delete(ns)
    }
  }

  // 当前公开名清单（consumer 拿这个当 schema 列表）
  schemas(): string[] {
    return [...this.tools.keys()].sort()
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  // 解析公开名 -> 调用对应 provider 行为
  async invoke(name: string, args: Record<string, unknown>): Promise<string> {
    const def = this.tools.get(name)
    if (!def) throw new Error(`[tools] 未知工具: ${name}`)
    return def.invoke(args)
  }

  // 列出某个 namespace 当前拥有的工具（用于实验观察）
  listByNamespace(namespace: string): string[] {
    const s = this.byNamespace.get(namespace)
    return s ? [...s].sort() : []
  }
}

declare module '@cordisjs/core' {
  interface Context {
    tools: ExternalToolsService
  }
}

// 服务插件：把 ExternalToolsService 挂到 ctx.tools
export const toolsPlugin = (ctx: Context) => {
  ctx.plugin(ExternalToolsService)
}
