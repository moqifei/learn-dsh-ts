/**
 * m23 · 集成快照 · 插件 `model`（m07 模型即 Provider）
 * 仅注册 ctx.llm 服务；默认 Provider（教学脚本模型）已在 ModelService 构造内注册。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { ModelService } from './services.ts'

const modelPlugin: Plugin<Context> = {
  name: 'model',
  apply(ctx: Context) {
    ctx.plugin(ModelService)
  },
}

export default modelPlugin
