/**
 * m23 · 集成快照 · 插件 `capability-tools`（工具层）
 * s24 同构：本插件把四个工具 schema 注册进 ctx.tools，分别委托到 skills / subagents / workspace
 * 服务。Loop 此后只看到一组工具，不关心它们属于哪一课——"一切皆为插件"的最小证据。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { SkillsService, WorkspaceService, SubagentRuntime } from './services.ts'

const capabilityToolsPlugin: Plugin<Context> = {
  name: 'capability-tools',
  inject: ['tools', 'skills', 'subagents', 'workspace', 'session'] as const,
  apply(ctx: Context) {
    const tools = ctx.tools as { register: (d: any) => () => void }
    const skills = ctx.skills as SkillsService
    const subagents = ctx.subagents as SubagentRuntime
    const ws = ctx.workspace as WorkspaceService
    const session = ctx.session as { append: (t: string, d: Record<string, unknown>) => void }

    ctx.effect(() => {
      const d1 = tools.register({
        name: 'load_skill',
        description: 'Load a skill by name; contributes its instructions into the context.',
        parameters: { type: 'object', properties: { name: { type: 'string' } } },
        execute: (args: any) => {
          const hit = skills.catalog().find((s) => s.name === args.name)
          if (hit === undefined) throw new Error(`skill not found: ${args.name}`)
          const full = skills.load(String(args.name))
          session.append('skill/loaded', { name: full.name, description: full.description })
          return { name: full.name, description: full.description, body: full.body }
        },
      })
      const d2 = tools.register({
        name: 'delegate_research',
        description: 'Spawn a research subagent and return its findings.',
        parameters: { type: 'object', properties: { task: { type: 'string' } } },
        execute: async (args: any) => subagents.start('research', { prompt: String(args.task), parent: 'main' }),
      })
      const d3 = tools.register({
        name: 'write_file',
        description: 'Write content to a workspace file (confined to the workspace root).',
        parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } } },
        execute: (args: any) => ws.write(String(args.name), String(args.content)),
      })
      const d4 = tools.register({
        name: 'read_file',
        description: 'Read a workspace file (confined to the workspace root).',
        parameters: { type: 'object', properties: { name: { type: 'string' } } },
        execute: (args: any) => ws.read(String(args.name)),
      })
      return () => {
        d1()
        d2()
        d3()
        d4()
      }
    })
  },
}

export default capabilityToolsPlugin
