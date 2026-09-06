/**
 * m14 · Preset 组合 Agent — 共享运行时服务
 *
 * 对应 Python 版 s15 的 `RuntimeServices`：
 *   - 它属于"主机平面（host plane）"——进程级常驻，**不随任何 session 的创建/销毁而销毁**；
 *   - 所有 agent 共享同一份 runtime（同一份工具实现、同一个遥测列表）；
 *   - agent 的 scope 销毁时，回收的是"该 agent 自己的插件子树"，不会动到 runtime。
 *
 * 用 cordis 表达：runtime 注册在全局 root ctx 上（作为 Service），
 * 每个 session 的 scope 是 root 的子树，子树的销毁不影响 root 上的 service。
 */

/** 工具实现：名字 → 一个可调用函数。 */
export type ToolImpl = (arg: string) => string

/**
 * RuntimeServices：进程级共享服务。
 *   - telemetry：所有 agent 调用工具的审计日志（共享同一个数组）
 *   - toolImpls：工具名 → 真实实现（共享同一份实现）
 */
export class RuntimeServices {
  /** 审计日志：每条记录形如 "sessionId:toolName" */
  readonly telemetry: string[] = []

  /** 全局工具实现仓库（进程级，所有 agent 共享） */
  readonly toolImpls: ReadonlyMap<string, ToolImpl>

  constructor(toolImpls: Record<string, ToolImpl>) {
    this.toolImpls = new Map(Object.entries(toolImpls))
  }

  /** 已知工具集合（供 PresetStore 校验用）。 */
  knownTools(): ReadonlySet<string> {
    return new Set(this.toolImpls.keys())
  }

  /** 调用一个工具实现并记录遥测。 */
  callTool(sessionId: string, name: string, arg: string): string {
    const impl = this.toolImpls.get(name)
    if (!impl) throw new Error(`unknown tool: ${name}`)
    this.telemetry.push(`${sessionId}:${name}`)
    return impl(arg)
  }
}
