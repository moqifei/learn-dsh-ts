import { Context } from '@deepseek-ai/cordis'
import type { NodeConfig } from './profile'
import { mount } from './registry'

/**
 * 两种节点形态。注意：它们本身"不知道自己会被挂在树的哪里"，
 * 位置完全由 profile 决定——这就是"配置即插件树"的含义。
 *
 * 关键设计：节点 apply 内部【绝不使用 ctx.plugin 动态挂子】。
 * 否则会触发本 fiber 自身 restart（Cordis 依赖图变化），造成"挂载即卸载"的抖动。
 * 树形结构完全由 Loader 在外部按 parentId 平铺挂载 + 递归 dispose，节点只管自己的 effect。
 */

/** 叶子：一份可观测的 effect，HMR 时能看到它的 卸载→重挂 */
export const leafNode = {
  name: 'leaf',
  apply(ctx: Context, config: NodeConfig) {
    console.log(`  [leaf:${config.id}] 挂载  label="${config.label}"`)
    // effect：注册即"生效"，返回的 disposer 即"失效"
    ctx.effect(() => {
      console.log(`  [leaf:${config.id}] ▶ 生效（effect 已注册）`)
      return () => console.log(`  [leaf:${config.id}] ◀ 失效（旧 label="${config.label}"）`)
    }, 'leaf-active')
    // 插件级 cleanup：比 effect 更外层，卸载整棵插件时打印
    return () => console.log(`  [leaf:${config.id}] 插件卸载  label="${config.label}"`)
  }
}

/** 分支：只负责自己的 effect；子节点由 Loader 在外层平铺挂载（避免嵌套重启） */
export const branchNode = {
  name: 'branch',
  apply(ctx: Context, config: NodeConfig) {
    const childLabels = (config.children ?? []).map((c) => c.label).join(' / ')
    console.log(`[branch:${config.id}] 挂载  label="${config.label}"  子节点=[${childLabels}]`)
    ctx.effect(() => {
      console.log(`[branch:${config.id}] ▶ 生效`)
      return () => console.log(`[branch:${config.id}] ◀ 失效（旧 label="${config.label}"）`)
    }, 'branch-active')
    return () => console.log(`[branch:${config.id}] 插件卸载  label="${config.label}"`)
  }
}

/** 根据节点配置挑出对应的 apply 对象（branch / leaf 两种形态） */
export function nodeOf(cfg: NodeConfig) {
  return cfg.kind === 'branch' ? branchNode : leafNode
}
