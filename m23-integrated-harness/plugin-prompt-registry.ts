/**
 * m23 · 集成快照 · 插件 `prompt-registry`（m09 提示即有序贡献）
 * 仅注册 ctx.prompt 服务；默认 section（role / format）已在 PromptRegistry 构造内注册。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { PromptRegistry } from './services.ts'

const promptRegistryPlugin: Plugin<Context> = {
  name: 'prompt-registry',
  apply(ctx: Context) {
    ctx.plugin(PromptRegistry)
  },
}

export default promptRegistryPlugin
