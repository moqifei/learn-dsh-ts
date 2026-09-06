# m13 · 作用域注册 (Scoped Registration)

> 系列：`learn-dsh-ts`（用 TypeScript 逐步复刻 deepseek-harness 的 cordis 插件化架构）
> 前置：`m09 工具即插件` → `m10 工具作为 Service` → `m11 策略包裹执行` → `m12 Loop 也是插件`
> 本模块目标：**一个 agent 一个作用域；在某个作用域下注册的能力，只在该作用域可见，随作用域销毁而回收。**

---

## 0. 一句话理解

- **传统思路**：工具/插件注册进一个全局表，谁都能访问，销毁时要手动逐个 unregister，容易泄漏。
- **作用域注册**：每个 agent 是一个独立的 **context 子树（scope）**；工具、监听器、子插件都注册在这棵子树上；销毁这棵子树（`scope.dispose()`）就一次性回收该 agent 的全部注册。
- 一句话：**"注册的生命周期 + 可见性边界"都由 scope 决定，而不是由程序员手动记住。**

---

## 1. 核心概念

| 概念 | 本示例 | deepseek-harness 真实工程 |
|------|--------|---------------------------|
| 作用域 | `createScope(root, key)` 返回带 tag 的子 context | `createScope(ctx, key)`（`packages/core/scope` 的 ScopeKey + Scope） |
| 作用域标记 | 给子 context 写 `scopeKey` own property | `ScopeKey` 对象携带 `.ctx` 引用 |
| 注册表 | 全局 `Toolbox` Service，按 `scopeKey` 分桶 | 各 agent 在 scope 内注册自己的 tools/handlers |
| 销毁 | `scope.dispose()` → 触发 `scope/disposed` → 清空该桶 | `scope.dispose()` → ScopeLayer 回收 |

**关键约束（cordis 真实行为）**：Service 名字在整棵 context 树里是全局唯一的，同一个 service 名（如 `tools`）只能注册一次。因此本示例用"单个全局 `Toolbox` + 按作用域分桶"来表达隔离，而不是"每个作用域一个同名 Service"。但思想完全一致——注册与生命周期都绑定在作用域（context 子树）上。

---

## 2. 模块结构

```
m13-scoped-registration/
├── scope.ts        # 作用域原语：createScope / ScopeRegistry
├── registry.ts     # 作用域感知的注册表 Service：Toolbox（按 scope 分桶）
├── runner.ts       # 四个实验：隔离 / 回收 / 监听器 / 插件随作用域卸载
├── images/
│   ├── scoped-registration.svg   # 总体心智图
│   └── vs-traditional.svg        # 与传统全局注册对比
├── package.json
└── tsconfig.json
```

### 2.1 `scope.ts` —— 作用域原语

```ts
export async function createScope(parent: Context, key: ScopeKey): Promise<Scope> {
  // 1) 在父 context 下建立一棵子树（fiber）
  const fiber = await parent.plugin(() => {})
  // 2) 给这棵子树打上作用域标记（own property，便于 scopeOf 直接读取）
  const ctx = fiber.ctx.extend({ scopeKey: key } as any)
  // 3) 返回带标记的 ctx + 销毁器（dispose 卸载该 fiber）
  return {
    key,
    ctx,
    disposed: false,
    async dispose() {
      if (this.disposed) return
      this.disposed = true
      await fiber.dispose()
      parent.emit('scope/disposed', key)
    },
  }
}
```

`ScopeRegistry` 是一个挂在全局 ctx 上的 Service，负责登记所有活跃作用域、按 key 取回、以及 `dispose(key)` 销毁某个作用域。

### 2.2 `registry.ts` —— 作用域感知的注册表

`Toolbox` 是全局单例 Service，但注册时**带上调用方的作用域 ctx**，按 `scopeKey` 分桶：

```ts
register(scopeCtx: Context, tool: Omit<Tool, 'owner'>) {
  const key = scopeOf(scopeCtx)      // 从 ctx 上读出所属作用域
  let bucket = this.byScope.get(key) // 取该作用域的桶
  if (!bucket) { bucket = new Map(); this.byScope.set(key, bucket) }
  bucket.set(tool.name, { ...tool, owner: key })
}
// 作用域销毁时自动清空对应桶
ctx.on('scope/disposed', (key) => this.byScope.delete(key))
```

`list(scopeCtx)` / `get(scopeCtx, name)` 只返回该作用域桶里的工具 → **天然隔离**。

---

## 3. 四个实验

运行：`node --experimental-strip-types runner.ts`（或 `npm start`）

### 实验 1：多 agent 作用域隔离
创建 `agent-A` / `agent-B` 两个 scope，各自注册不同工具。结果：
```
agent-A 工具箱: [ 'echo' ]
agent-B 工具箱: [ 'calc' ]
A 能否看到 calc？ 不能(√对) | B 能否看到 echo？ 不能(√对)
```

### 实验 2：销毁作用域 → 注册自动回收
`agent-C` 注册 `timer`，`dispose('agent-C')` 后全局 dump 里 `agent-C` 桶消失：
```
销毁后全局 dump: {"agent-A":["echo"],"agent-B":["calc"]}
agent-C 桶是否已清空？ 是(√对)
```

### 实验 3：作用域内的监听器随作用域存在/消亡
在 `agent-D` 的 scope ctx 上挂监听器，触发一次命中；`dispose` 后再次触发不再命中：
```
[agent-D 监听器] 收到 greet: alice
agent-D 监听器命中次数: 1
销毁后命中次数: 1（监听器已随作用域卸载）
```

### 实验 4：整个 agent 能力作为插件挂进作用域，随 scope 卸载
把 `agent-E` 的"能力包"（工具 + 事件处理）作为插件挂到 scope ctx 上；`dispose('agent-E')` 后该能力整体消失：
```
agent-E 工具箱: [ 'search' ]
[agent-E] 处理查询: 天气
销毁 agent-E 后全局 dump: {"agent-A":["echo"],"agent-B":["calc"]}
agent-E 能力已随作用域整体卸载 ✓
```

### 实验 5：`ctx.effect` 清理 vs 手动 `dispose` —— 定时器随 scope 销毁自动停止
这个实验直观演示前面讨论的"两层生命周期管理"：
- 在 `agent-F` 和对照 `agent-S` 两个 scope 里，各用 `ctx.effect(() => { setInterval(...); return () => clearInterval(...) })` 注册一个周期性定时器；
- `effect` 的返回值（`clearInterval`）就是"临终遗书"：当该 scope 的 fiber 被 dispose 时，cordis **自动**调用它；
- 主动 `dispose('agent-F')` 后，F 的定时器停（遗书被执行），S 的继续跑。

```
[agent-F 定时器 tick 1]
[agent-S 定时器 tick 1]
[agent-F 定时器 tick 2]
[agent-S 定时器 tick 2]
  阶段一：F=2 tick, S=2 tick
  已 dispose agent-F → 其定时器应被 effect 清理回调自动 clearInterval
[agent-S 定时器 tick 3]
[agent-S 定时器 tick 4]
  阶段二：F=2 tick（应不再增长）, S=4 tick（应继续增长）
  F 定时器是否已停？ 是(√对) | S 定时器是否继续？ 是(√对)
```

**结论**：`ctx.effect(fn)` 是"声明清理逻辑"（贴遗书），`scope.dispose()` 是"触发销毁动作"（按按钮）。scope 的 `dispose` 内部调 `fiber.dispose()`，cordis 再去自动执行该作用域内所有 `effect` 的清理回调——二者是协作关系，缺一不可。

```ts
// 在 scope 内声明：定时器归这个 scope 管
f.ctx.scopeEffect?.() // 实际用下面这行
f.ctx.effect(() => {
  const id = setInterval(() => console.log('tick'), 200)
  return () => clearInterval(id)   // ← fiber.dispose() 时自动调用
})
```

---

## 4. 调用过程逐行解读

以"实验 1：agent-A 注册 echo"为例：

```
启动期
  root = new Context()
  root.plugin(ScopeRegistry)        // 全局作用域登记表
  root.plugin(Toolbox)              // 全局工具注册表（按 scope 分桶）

调用期：createScope(root, 'agent-A')
  parent.plugin(() => {})           // (a) 在 root 下建一棵子树，得到 fiber
  fiber.ctx.extend({ scopeKey:'agent-A' })  // (b) 给子树打 tag → scope.ctx
  → 返回 { key, ctx: scope.ctx, dispose }

调用期：root.tools.register(a.ctx, {name:'echo'})
  scopeOf(a.ctx) → 'agent-A'        // (c) 从 ctx 读出所属作用域
  byScope.get('agent-A').set('echo', ...)  // (d) 落进 agent-A 的桶
  → 工具只存在于 agent-A 桶，agent-B 看不见

销毁期：root.scopes.dispose('agent-A')
  scope.dispose() → fiber.dispose() // (e) 卸载整棵子树
  emit('scope/disposed','agent-A')  // (f) 通知 Toolbox
  byScope.delete('agent-A')         // (g) 清空该桶 → 无泄漏
```

### 调用时序图

```
   root ctx
     │
     ├─ plugin(ScopeRegistry) ── 登记 {A,B,C,...} scopes
     ├─ plugin(Toolbox)       ── 按 scopeKey 分桶的全局注册表
     │
     └─ createScope(root,'agent-A')             createScope(root,'agent-B')
          │  parent.plugin(()=>{})                   │
          │  fiber.ctx.extend({scopeKey:'A'})        │  fiber.ctx.extend({scopeKey:'B'})
          ▼                                          ▼
       scope-A ctx                               scope-B ctx
          │  tools.register(scopeA, echo)           │  tools.register(scopeB, calc)
          ▼                                          ▼
       bucket['A'] = {echo}                       bucket['B'] = {calc}
          │                                          │
          └──────── 互不可见：list(scopeA) 只有 echo ─┘

   dispose('agent-A'):
       scope-A.dispose() → fiber.dispose()
       emit('scope/disposed','A') → byScope.delete('A')
       → agent-A 的全部注册被回收，agent-B 不受影响
```

### 洋葱模型（作用域 = 边界）

```
        ┌──────────────── 全局 root ctx ────────────────┐
        │  services: scopes, tools（全局唯一）          │
        │                                                │
        │   ┌──── scope-A ctx（子树）────┐               │
        │   │ tools: echo                │               │
        │   │ listener: greet            │               │
        │   └────────────────────────────┘               │
        │   ┌──── scope-B ctx（子树）────┐               │
        │   │ tools: calc                │               │
        │   └────────────────────────────┘               │
        └────────────────────────────────────────────────┘

   每个 scope 是一层独立边界：注册进来的东西，
   只在该边界内可见；撕掉边界（dispose）→ 一切随之消失。
```

### 关键坑位（与 m11 一致的 cordis 真实语义）

1. **Service 名全局唯一**：同一个 service 名（如 `tools`）整棵树只能注册一次。所以"每作用域一个同名 Service"会报 `service "tools" has been registered`。解决办法是"单个全局 Service + 按 scope 分桶"。
2. **context 是 proxy，不能直接赋值属性**：`ctx.scopeKey = key` 会抛 `cannot set property ... without provide`。必须用 `ctx.extend({ scopeKey: key })` 来写入 own property。
3. **`extend({ scopeKey })` 写入的 own property 是静态标记**，读取时不经过 service inject 检查，所以 `scopeOf` 能直接拿到 key。
4. **dispose 不是 `ctx.dispose()`**：cordis 的 Context 没有 `dispose` 方法，生命周期由 `fiber.dispose()` 管理。`createScope` 返回的销毁器内部调用 `fiber.dispose()`。
5. **访问 service 需要 inject**：在非 plugin 顶层直接 `ctx.tools` 会报 `cannot get property tools without inject`。解决办法是把实验逻辑包进一个声明了 `inject: ['scopes','tools']` 的 master plugin。
6. **`ctx.effect(fn)` 是"声明清理逻辑"，`scope.dispose()` 是"触发销毁动作"**：`effect(fn)` 的返回值（`disposer`）会在所属 plugin 的 fiber 被 dispose 时由 cordis **自动**调用——你不需要手动卸载。而 `scope.dispose()` 是你从外部主动按下"销毁这个作用域"的按钮，其内部正是调用 `fiber.dispose()`，从而触发该作用域内所有 `effect` 清理回调。两者协作：你的 `dispose` 调 `fiber.dispose()` → cordis 自动执行各 plugin 的 `effect` 遗书。见**实验 5**与 §5.3。

---

## 5. 示例 vs deepseek-harness 真实工程实践

> 本节对照真实工程 `deepseek-harness`（见 `docs/subsystems/scope.zh.md` 与 `packages/core/scope`），说明示例做了哪些简化、真实工程如何做。

### 5.1 真实工程的 scope 包

真实工程有一套专门的 `scope` 子系统，五个核心概念：

| 概念 | 作用 |
|------|------|
| `ScopeKey` | 作用域的标识（一个对象，携带 `.ctx` 引用） |
| `Scoped<T>` | 被作用域包裹的值类型 |
| `Scope` | 一个具体作用域实例，内部持有 `ctx` 与 `dispose` |
| `ScopeLayer` | 作用域的层级容器，管理多层 scope 的叠加 |
| `ScopedLayers` | 全局已激活作用域层的栈 |

真实 `createScope` 的实现（节选）：

```ts
export function createScope(ctx: Context, key: ScopeKey): Scope {
  const fiber = ctx.plugin(scope)        // 建立子树
  const scopedCtx = fiber.ctx.extend({ [kScope]: key })
  return { ctx: scopedCtx, dispose: () => key.ctx.dispose() }
}
```

### 5.2 示例与真实的差异

| 维度 | 本示例 m13 | deepseek-harness 真实工程 |
|------|-----------|---------------------------|
| 作用域标记 | 普通字符串 `scopeKey` own property | `Symbol` 标记的 `ScopeKey` 对象（携带 `.ctx`） |
| 分层 | 单层（root → scope） | `ScopeLayer` 支持多层 scope 叠加（如 agent 层 + request 层） |
| 注册隔离 | 全局 Service 按 key 分桶 | 各 scope 内独立注册，`isolate` 做 service 级隔离 |
| 生命周期 | `fiber.dispose()` | 同，外加 `ScopedLayers` 全局栈管理激活态 |
| 可见性 | 靠分桶 Map 隔离 | 靠 context 子树天然隔离 + `scopeOf` 向上查找 |

### 5.3 示例刻意保留的"真实内核"

- **`createScope(parent, key)` 返回带 tag 的子 context**：与真实工程一致——作用域本质是一棵独立的 context 子树。
- **dispose 回收整棵子树**：与真实工程一致——作用域 = 注册的生命周期边界。
- **`scope/disposed` 事件驱动注册表自清理**：对应真实工程 ScopeLayer 销毁时的级联回收。
- **`ctx.effect` 声明式清理 + `scope.dispose` 触发式销毁协作**：effect 贴"遗书"，dispose 按"按钮"，fiber.dispose 自动执行遗书。见实验 5。

### 5.4 真实工程里作用域注册解决什么问题

在 deepseek-harness 中，一个多 agent 系统里：
- 每个 agent 运行在自己的 scope 里，注册自己的 tools / handlers / middleware；
- 一个 request 进来时再叠一层 request scope（携带本次会话状态）；
- agent 退出 / request 结束 → 对应 scope dispose → 所有局部注册被回收，**不会泄漏到别的 agent 或下一次请求**。

这正是"作用域注册"在工程里的核心价值：**把"资源归属 + 生命周期 + 可见性"三者统一收口到 scope 这一个概念上**，而不是靠程序员手动 unregister。

---

## 6. 运行与验证

```bash
cd m13-scoped-registration
npm start          # node --experimental-strip-types runner.ts
npm run typecheck  # tsc --noEmit（零错误）
```

预期：四个实验全部输出 `√ 对`，`=== 全部实验完成 ===`。

---

## 7. 小结

- **作用域 = 一棵独立的 context 子树**，它同时是"注册的可见性边界"和"生命周期边界"。
- **注册进 scope 的东西，只在该 scope 可见；dispose scope，东西随之回收。**
- cordis 的 Service 名全局唯一，因此用"单个全局 Service + 按 scope 分桶"来表达隔离（或真实工程里用 `isolate` 做 service 级隔离）。
- 下一模块可以继续：把"agent loop + tools + 策略"整体挂进 scope，实现一个"每 agent 一个可独立启停的作用域"的完整 agent 实例。
```
