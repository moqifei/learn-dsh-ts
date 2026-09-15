/**
 * m23 · 集成快照 · 插件 `capability-external`（m22 外部能力即插件）
 * 仅注册 ctx.external 服务；core / web / lsp 三类默认 Provider 已在 CapabilityRuntime 构造内注册。
 * web（真实回环 HTTP）/ lsp（真实子进程）的启连接由 Service 的 effect 完成。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { CapabilityRuntime } from './services.ts'

const externalPlugin: Plugin<Context> = {
  name: 'capability-external',
  apply(ctx: Context, config: any) {
    ctx.plugin(CapabilityRuntime, config as { web?: { baseUrl: string; path: string }; lsp?: { command: string; args: string[] } })
  },
}

export default externalPlugin
