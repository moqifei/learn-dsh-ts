/**
 * m23 · 集成快照 · 插件 `skills`（m15 技能目录 + 按需加载）
 * 注册 ctx.skills 服务。load_skill 工具由 capability-tools 注册并委托到本服务。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { SkillsService } from './services.ts'

const skillsPlugin: Plugin<Context> = {
  name: 'skills',
  apply(ctx: Context, config: any) {
    ctx.plugin(SkillsService, config as { root?: string })
  },
}

export default skillsPlugin
