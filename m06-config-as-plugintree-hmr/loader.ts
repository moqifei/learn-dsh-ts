import { Context } from '@deepseek-ai/cordis'
import type { NodeConfig } from './profile'
import { nodeOf } from './nodes'
import { mount, get, list, drop } from './registry'

/**
 * Loader：把"配置（数据）"翻译成"插件森林（运行时）"，并负责 HMR 的结构化 diff。
 *
 * 这是 m06 的核心。它对应 deepseek-harness s07 的 Loader，但底层是真实 Cordis：
 *   - 每个节点 → 一次 `ctx.plugin(nodeOf(node), config)` → 得到一个 fiber
 *   - fiber 按稳定 id 登记到模块级 registry（registry.ts 的 Map）
 *   - reconcile(next)：把下一份 profile 与"上一份 profile"做【结构化 diff】：
 *       · 某 id 在 prev 有、next 无 → 递归 dispose 其子树（effect 自动回收）
 *       · 某 id 在 prev 无、next 有 → `ctx.plugin(...)` 新增（平铺挂到 root）
 *       · 同 id 且 config 变了       → `fiber.update(cfg)`（局部热重载，走 internal/update）
 *       · 同 id 且 config 没变       → 【不碰它】（外科手术式：只动变化的部分）
 *
 * 关键：只有"结构化 diff 出变化"的节点才会被触碰，其余保持原样运行——
 * 这正是 s07 强调的"稳定 id + 选择性 HMR"，而不是整树 dispose+重建。
 *
 * 所有节点都平铺挂到同一个 root context（互不嵌套），因此一次更新不会触发
 * 其他节点的级联重启。树形关系仅靠 parentId 在 Loader 内维护（删除父时递归删子）。
 * 这与 Cordis 原生的"context 嵌套级联"效果等价，但每一步都可被稳定 id 精确定位、
 * 可预测、易于教学观察。
 */
export class Loader {
  private rootCtx: Context
  /** 上一份 profile：作为 diff 的基准 */
  private previous: NodeConfig[] = []

  constructor(ctx: Context) {
    this.rootCtx = ctx
  }

  /** 首次挂载整棵 profile 树（递归平铺到 rootCtx） */
  async mount(profile: NodeConfig[]) {
    for (const node of profile) {
      await this.mountNode(node)
    }
    this.previous = profile
  }

  /** 挂载单个节点并登记，再递归挂其子节点（仅 mount 阶段用） */
  private async mountNode(node: NodeConfig) {
    const fiber = this.rootCtx.plugin(nodeOf(node), node)
    mount(node.id, fiber)
    await fiber
    if (node.children) {
      for (const child of node.children) await this.mountNode(child)
    }
  }

  /** 只挂载单个节点自身（不递归子），新增节点的子由 sync 递归负责 */
  private async mountSelf(node: NodeConfig) {
    const fiber = this.rootCtx.plugin(nodeOf(node), node)
    mount(node.id, fiber)
    await fiber
  }

  /** 收集某节点的全部后代 id（含自身），用于删除时的递归 dispose */
  private descendantsOf(node: NodeConfig, acc: string[] = []): string[] {
    acc.push(node.id)
    for (const c of node.children ?? []) this.descendantsOf(c, acc)
    return acc
  }

  /** 比较"除 children 外的配置"是否相等（children 由递归 diff 处理） */
  private configChanged(a: NodeConfig, b: NodeConfig): boolean {
    return JSON.stringify({ id: a.id, kind: a.kind, label: a.label }) !==
           JSON.stringify({ id: b.id, kind: b.kind, label: b.label })
  }

  /** 把 profile 摊平成 id → 节点 的索引 */
  private index(profile: NodeConfig[], map = new Map<string, NodeConfig>()): Map<string, NodeConfig> {
    for (const n of profile) {
      map.set(n.id, n)
      if (n.children) this.index(n.children, map)
    }
    return map
  }

  /**
   * 结构化 reconcile：把运行时对齐到下一份 profile。
   * 用稳定 id + config 比对做 diff，只有变化的节点才会被 update/dispose/新增。
   */
  async reconcile(next: NodeConfig[]) {
    // 1) 给每个节点补上 parentId（仅用于"新增节点"时记录层级）
    const annotate = (nodes: NodeConfig[], pid?: string) => {
      for (const n of nodes) {
        ;(n as any).parentId = pid
        if (n.children) annotate(n.children, n.id)
      }
    }
    annotate(next)

    const prevIndex = this.index(this.previous)
    const nextIndex = this.index(next)

    // 2) 删除：prev 有、next 无 → 递归 dispose 整棵子树
    for (const [id, pNode] of prevIndex) {
      if (!nextIndex.has(id)) {
        const subTree = this.descendantsOf(pNode)
        console.log(`  [loader] 删除子树 id=${id}（含 ${subTree.length} 个节点）→ dispose`)
        for (const subId of subTree) {
          const f = get(subId)
          if (f) f.dispose()
          drop(subId)
        }
      }
    }

    // 3) 新增 / 更新：逐节点递归 diff（父没变时子仍可能变，故逐层进入）
    const sync = async (n: NodeConfig) => {
      const prev = prevIndex.get(n.id)
      if (!prev) {
        console.log(`  [loader] 新增节点 id=${n.id} → plugin（parent=${(n as any).parentId ?? 'root'}）`)
        await this.mountSelf(n)
      } else if (this.configChanged(prev, n)) {
        console.log(`  [loader] 更新节点 id=${n.id} → fiber.update`)
        await get(n.id).update(n)
      }
      // 无论本节点是否变化，子节点都要逐层 diff
      if (n.children) for (const c of n.children) await sync(c)
    }
    for (const n of next) await sync(n)

    this.previous = next
  }
}
