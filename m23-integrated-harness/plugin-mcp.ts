/**
 * m23 · 集成快照 · 插件 `mcp`（m22 外部 MCP 能力接入点）
 * 最小可运行证据：把一个 MCP 风格工具作为命名空间 provider 接入同一棵 external Runtime。
 * 复用 m22 的 CapabilityRuntime（ctx.external），证明外部协议只是又一类 Provider 插件。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { ExternalCapabilityProvider, MountedTool } from './services.ts'

class McpProvider implements ExternalCapabilityProvider {
  readonly namespace = 'mcp'
  listTools(): MountedTool[] {
    return [
      {
        name: 'ping',
        description: 'A minimal MCP-style tool surfaced through the external capability runtime.',
        parameters: { type: 'object', properties: { msg: { type: 'string' } } },
        execute: (a: any) => ({ pong: String(a.msg ?? 'ok'), protocol: 'mcp-over-external' }),
      },
    ]
  }
  close(): void {}
}

const mcpPlugin: Plugin<Context> = {
  name: 'mcp',
  inject: ['external'] as const,
  apply(ctx: Context) {
    // external 由 capability-external 插件注册；这里仅挂一个最小 MCP 风格 provider。
    ctx.effect(() => {
      const ext = ctx.external as { registerProvider: (n: string, p: ExternalCapabilityProvider) => void }
      ext.registerProvider('mcp', new McpProvider())
      return () => {
        /* 反注册可在此（示例简化） */
      }
    })
  },
}

export default mcpPlugin
