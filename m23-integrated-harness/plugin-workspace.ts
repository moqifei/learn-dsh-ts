/**
 * m23 · 集成快照 · 插件 `workspace`（m10 受限文件根）
 * 注册 ctx.workspace 服务（受控根目录的读写解析）。write_file/read_file 工具由 capability-tools 注册。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { WorkspaceService } from './services.ts'

const workspacePlugin: Plugin<Context> = {
  name: 'workspace',
  apply(ctx: Context, config: any) {
    ctx.plugin(WorkspaceService, config as { root?: string })
  },
}

export default workspacePlugin
