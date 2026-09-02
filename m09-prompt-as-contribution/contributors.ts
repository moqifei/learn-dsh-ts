/**
 * m09 · 多方贡献 —— 不同子系统各自注册自己的分段
 *
 * 关键：每个贡献都是一个独立插件，通过 ctx.prompt.section(...) 注册，
 * 并用 ctx.effect(...) 挂上清理（插件卸载 → 分段自动消失）。
 *
 * 注意挂载顺序：这里故意"乱序"挂载（workspace 先于 identity），
 * 但渲染顺序只由 order 决定，不依赖挂载时机——这正是注册表的要点。
 */

import { Context } from '@deepseek-ai/cordis'
import type { PromptRegistry } from './prompt.ts'

/** memory:recall 段贡献的 effect disposer（供 runner 演示"撤销该真实贡献"）。 */
export let memoryRecallFiber: (() => void) | undefined

/** 多方贡献插件：各子系统通过 ctx.prompt.section(...) 注册自己的分段。 */
export const contributors = {
  name: 'prompt-contributors',
  inject: ['prompt'],
  apply(ctx: Context): void {
    const prompt = ctx.prompt as PromptRegistry

  // 部署人格（order 0）—— 与真实 PERSONA_SECTION 同构。
  ctx.effect(() => {
    return prompt.section({
      name: 'deployment:persona',
      order: 0,
      text: 'Be concise, precise, and follow exact-output requests literally.',
    })
  })

  // 工作区事实（order 50，引用动态变量 {{cwd}}）。
  ctx.effect(() => {
    return prompt.section({
      name: 'workspace',
      order: 50,
      text: 'Working directory: {{cwd}}',
    })
  })

  // harness 身份（order -100，固定开场）。
  ctx.effect(() => {
    return prompt.section({
      name: 'harness:identity',
      order: -100,
      text: 'You are an AI agent powered by a plugin harness.',
    })
  })

  // 记忆召回（order 60，模拟 memory 子系统）。
  // 具名接住该贡献的 effect disposer 并导出，供 runner 演示"撤销真实贡献"。
  memoryRecallFiber = ctx.effect(() => {
    return prompt.section({
      name: 'memory:recall',
      order: 60,
      text: 'User prefers responses in Chinese.',
    })
  })

  // 技能目录（order 70，模拟 skill catalog 子系统）。
  ctx.effect(() => {
    return prompt.section({
      name: 'skill:catalog',
      order: 70,
      text: 'Available skills: search, summarize, translate.',
    })
  })

  // 动态时钟（order 80，每次组装重新求值）。
  ctx.effect(() => {
    return prompt.section({
      name: 'runtime:clock',
      order: 80,
      text: () => `Current time: ${new Date().toISOString()}`,
    })
  })

  // 两个严格变量：cwd（静态快照），user（动态）。
  ctx.effect(() => prompt.variable('cwd', () => process.cwd()))
  ctx.effect(() => prompt.variable('user', () => process.env.USER ?? 'anonymous'))
  },
}

export default contributors
