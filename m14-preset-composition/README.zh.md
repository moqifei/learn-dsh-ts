# m14 · Preset 组合 Agent (Preset Composition)

> 系列：`learn-dsh-ts`（用 TypeScript 逐步复刻 deepseek-harness 的 cordis 插件化架构）
> 前置：`m09 工具即插件` → `m10 工具作为 Service` → `m11 策略包裹执行` → `m12 Loop 也是插件` → `m13 作用域注册`
> 本模块目标：**用一份"具名 preset 数据"（id / persona / tools）校验通过后，在 session 作用域下组合出一个独立的 agent 子树；多个 agent 共享同一份运行时，但各自作用域隔离。**

---

## 0. 一句话理解

- **preset 是"数据"，不是代码**：它描述"这个 agent 用什么人设、组合哪些工具"，是一份 composition 文件。
- **组合 = 挂载插件子树**：拿到 preset 后，在为该 session 新开的 scope 下，挂上 `persona-plugin` 和 `tool-policy-plugin` 两棵子树。
- **共享运行时，隔离作用域**：所有 agent 共用一份 `RuntimeServices`（进程级常驻），但每个 agent 拥有自己的 scope 子树——互不干扰，销毁一个不影响另一个。
- **创建是一个事务**：未发布 scope → 挂载 → 审计 → 发布；任一步失败 → 回滚（dispose 该 scope）。

---

## 1. 核心概念

| 概念 | 本示例 | deepseek-harness 真实工程 |
|------|--------|---------------------------|
| Preset | `preset.ts` 里的 JSON 数据（id/persona/tools） | `agent-presets/<id>/agent.cordis.yml` 这份 composition 文件 |
| 校验 | `PresetStore.resolve`：文件存在、字段齐、工具已知 | mount 前对 composition 做 schema / 引用校验 |
| 运行时 | `RuntimeServices`（telemetry + 工具实现） | "HOST 平面"：注册表、模型路由、sandbox 等进程级共享服务 |
| 组合 | `AgentFactory.create`：开 scope → 挂两棵插件子树 → 审计 → 发布 | preset 作为一棵子树 mount 进 session，贡献 tools/persona/prompt |
| 隔离 | 每个 agent 一个 scope 子树 | 每个 session 一个 scope（可叠加 `isolate`  realm） |

**关键约束（与 m13 一致）**：cordis 的 Service 名全局唯一，所以"共享工具实现"放在全局 `RuntimeServices`，而"每个 agent 的工具箱"是 scope 下的局部存储（按 scopeKey 分桶）。agent 销毁只回收局部子树，不碰共享运行时。

---

## 2. 模块结构

```
m14-preset-composition/
├── scope.ts        # 复用 m13 的作用域原语（createScope / ScopeRegistry）
├── preset.ts       # Preset 数据 + PresetStore（JSON 解析、严格校验、拒绝未知工具）
├── runtime.ts      # RuntimeServices（进程级共享：telemetry + 工具实现）
├── factory.ts      # AgentFactory.create() —— 组合事务（校验→开 scope→挂载→审计→发布/回滚）
├── runner.ts       # 五个实验
├── presets/
│   ├── analyst.json   # 人设 + [search, inspect_runtime]
│   └── builder.json   # 人设 + [inspect_runtime, write_file]
├── images/
│   ├── preset-transaction.svg   # create() 事务流程图
│   └── preset-subtree.svg       # 共享 runtime + 隔离 scope 子树图
├── package.json / tsconfig.json / node-shims.d.ts
```

### 2.1 `preset.ts` —— 数据与校验

```ts
export class PresetStore {
  resolve(presetId: string): Preset {
    // 1) 文件必须存在；2) 必须是恰好 {id,persona,tools}；
    // 3) persona 非空；4) tools 非空字符串列表、无重复、且都是已知工具
    // 任何一项不过 → 抛错（缺失 → PresetNotFoundError，其余 → Error）
  }
}
```

### 2.2 `runtime.ts` —— 共享运行时

```ts
export class RuntimeServices {
  readonly telemetry: string[] = []                 // 所有 agent 共享的审计日志
  readonly toolImpls: ReadonlyMap<string, ToolImpl> // 工具实现只存一份
  callTool(sessionId, name, arg) {                  // 调用实现 + 记遥测
    this.telemetry.push(`${sessionId}:${name}`)
    return this.toolImpls.get(name)!(arg)
  }
}
```

### 2.3 `factory.ts` —— 组合事务（核心）

```ts
async create(sessionId, presetId): Promise<Agent> {
  if (this.sessions.has(sessionId)) throw ...        // 防重复
  const preset = this.presetStore.resolve(presetId)  // ① 校验（失败直接抛）
  const scope = await createScope(root, `session:${sessionId}`)  // ② 开未发布 scope
  try {
    await this.mountPersona(scope, preset)           // ③ 挂 persona 子树
    await this.mountTools(scope, preset)             // ③ 挂 tool-policy 子树
    if (!persona || tools.empty) throw ...           // ④ 审计
    this.sessions.set(sessionId, {...})              // ⑤ 发布
    return agent
  } catch (err) {
    await this.scopes.dispose(scope.key)             // 回滚：销毁未发布 scope
    throw err
  }
}
```

---

## 3. 五个实验

运行：`node --experimental-strip-types runner.ts`（或 `npm start`）

### 实验 1：analyst / builder 组合出独立 agent
```
analyst 人设: You are a careful research analyst...
analyst 工具: search, inspect_runtime
builder 人设: You are a pragmatic software builder...
builder 工具: inspect_runtime, write_file
共享 runtime？ true (scope 不同) | runtime 同一份: true
analyst.call(search): research results for scoped registries
builder.call(write_file): wrote result.txt
遥测记录: ["session-a:search","session-b:write_file"]
```
→ 不同 preset 组合出不同工具集；两者共享同一 RuntimeServices。

### 实验 2：缺失 preset 被拒绝
```
缺失 preset 被拒: preset "missing" not found in .../presets/
残留 session 数（应为 2）: 2
```
→ 校验失败直接抛 `PresetNotFoundError`，不创建任何 agent。

### 实验 3：无效 preset（未知工具）被拒绝
```
无效 preset 被拒: preset "broken" names unknown tools: teleport
残留 session 数（仍应为 2）: 2
```
→ 引用未知工具的 preset 在 resolve 阶段被拒，不留残留。

### 实验 4：清理 analyst，builder 与 runtime 不受影响
```
analyst 关闭后，builder 仍可用？ true
builder.call(inspect_runtime): shared runtime healthy
残留 session 数（应为 1）: 1
analyst 的 scope 已回收（builder 工具箱仍独立）: inspect_runtime, write_file
```
→ 回滚/销毁一个 agent 的 scope，兄弟 agent 与共享 runtime 完好。

### 实验 5：全部关闭，共享 runtime 仍在
```
关闭后 session 数: 0
共享 runtime 永驻（遥测保留）: ["session-a:search","session-b:write_file","session-b:inspect_runtime"]
all per-session subtrees cleaned up ✓
```
→ 所有 per-session 子树被回收，但进程级 RuntimeServices 仍常驻。

---

## 4. 调用过程逐行解读

以 `factory.create('session-a', 'analyst')` 为例：

```
① 校验
   presetStore.resolve('analyst')
     → 读 presets/analyst.json（存在）
     → 字段恰为 {id,persona,tools}，persona 非空，tools 已知无重复
     → 返回 Preset{ id, persona, [search, inspect_runtime] }

② 开未发布的 session scope
   createScope(root, 'session:session-a')
     → parent.plugin(()=>{}) 建子树 fiber
     → fiber.ctx.extend({ scopeKey:'session:session-a' }) 打 tag
     → 返回 scope（此时还没进 sessions 表，属于"未发布"）

③ 挂载插件子树（都落在 scope.ctx 上）
   mountPersona(scope, preset)
     → scope.ctx.plugin(ctx => personaStore.set('session:session-a', persona))
   mountTools(scope, preset)
     → scope.ctx.plugin(ctx => for t of tools: toolBox.set(scopeKey, t, impl))
   // 这两棵子树都属于该 scope，scope 销毁时一并回收

④ 审计
   resolvePersona(scope) 非空？ tools 非空？  → 通过

⑤ 发布
   sessions.set('session-a', { agent, mounted })
   return agent

── 若③或④抛错 ──
   回滚：scopes.dispose('session:session-a')
        → fiber.dispose() 回收两棵子树 + emit('scope/disposed')
        → toolBox 对应桶清空
        → agent 不进 sessions 表（无残留）
```

### create() 事务流程图（成功 / 失败回滚）

```
        create(sessionId, presetId)
                 │
        ┌────────┴────────┐
        │ resolve(preset) │  ① 校验
        └────────┬────────┘
          成功 │   失败 → 抛错（无残留）
                 ▼
        createScope()   ② 开未发布 scope
                 │
        ┌────────┴────────┐
        │ mount persona    │  ③ 挂子树
        │ mount tools      │
        └────────┬────────┘
                 ▼
        audit: persona & tools 可用？  ④ 审计
          通过 │   不通过 → catch
                 ▼              │
        publish to sessions ⑤   │
        return agent            ▼
                          dispose(scope)  ← 回滚：回收未发布子树
                          rethrow
```

### 共享/隔离心智图

```
        ┌────────────── 进程级 RuntimeServices（HOST 平面，永驻）──────────────┐
        │  telemetry: [...]    toolImpls: { search, inspect_runtime, write_file } │
        └───────────────────────────────────────────────────────────────────────┘
                    ▲ 所有 agent 共享同一份
        ┌───────────┴───────────────┐
   scope:session-a                scope:session-b     ← 各自独立子树（隔离）
   ┌──────────────────┐           ┌──────────────────┐
   │ persona: analyst │           │ persona: builder │
   │ tools:           │           │ tools:           │
   │  - search        │           │  - inspect_...   │
   │  - inspect_...   │           │  - write_file    │
   └──────────────────┘           └──────────────────┘
   销毁 A → 只回收 A 子树，B 与 runtime 不受影响
```

### 关键坑位（与 m13 一致的 cordis 真实语义）

1. **Service 名全局唯一** → 共享工具实现放全局 `RuntimeServices`，per-agent 工具箱用 scope 下的局部分桶存储。
2. **context 是 proxy，不能直接赋值属性** → scope 标记用 `extend({ scopeKey })` 写 own property。
3. **dispose 不是 `ctx.dispose()`** → 走 `fiber.dispose()`；scope 的 `dispose` 内部调它。
4. **`parent.plugin(Service)` 是异步的** → 构造函数里不能同步读到刚注册的 service；本示例改为"调用方先 `await root.plugin(ScopeRegistry)` 再建工厂"。
5. **`import type` 区分值与类型** → `Preset`/`Scope` 是 interface，node 的 `--experimental-strip-types` 要求用 `import type`，否则报 "does not provide an export"。
6. **create 是事务** → 校验失败/审计失败都要回滚未发布的 scope，避免"半吊子 agent"泄漏到 sessions 表。

---

## 5. 示例 vs deepseek-harness 真实工程实践

> 本节对照真实工程 `deepseek-harness`（见 `apps/cli/config/agent-presets/cordis/agent.cordis.yml` 与 `docs` 中关于 host/agent 两平面的论述），说明示例做了哪些简化、真实工程如何做。

### 5.1 真实工程的 preset 是一份 composition 文件

真实 `cordis` preset 是 `agent-presets/cordis/agent.cordis.yml`，里面是一行行"插件行（row）"：

```yaml
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
          You are in plan mode...
```

每一行把"一个能力"挂进该 session 的组合里——这与示例里 `mountPersona` / `mountTools` 两棵子树是同一个思想：**preset 描述"要挂哪些插件"，mount 阶段把它们组合进 session scope**。

### 5.2 两平面（HOST vs AGENT PRESET）

真实工程的核心论述（见 composition.md）：

- **HOST 平面**：注册表、模型路由、sandbox、subagent registry、共享服务——跨 session 共享，属于"进程级"。
- **AGENT PRESET 平面**：一个 session 对宿主注册表的"贡献"——它的 tools、persona、prompt sections。

> "A row that publishes a service belongs in the host composition, or inside an `isolate` realm if the preset genuinely owns that service and nothing outside one agent reads it."

对应本示例：
- `RuntimeServices`（telemetry + toolImpls）= HOST 平面，常驻；
- 每个 agent 的 persona / 工具箱 = AGENT PRESET 平面的贡献，落在各自 scope 子树；
- 用 `isolate` 表达"只属于一个 agent"的隔离——本示例用 per-scope 分桶达到了等价效果。

### 5.3 示例与真实的差异

| 维度 | 本示例 m14 | deepseek-harness 真实工程 |
|------|-----------|---------------------------|
| preset 形式 | 极简 JSON `{id,persona,tools}` | 完整 composition YAML（多 row、group、isolate、config） |
| 挂载方式 | 手写 `mountPersona`/`mountTools` 两棵子树 | 通用 composition 加载器按 row 逐个 `ctx.plugin` |
| 隔离机制 | scope 下局部分桶存储 | `isolate` realm + scope 子树双层隔离 |
| 校验 | 字段齐 + 工具已知 | schema + 引用 + 权限/信任边界校验 |
| 运行时 | 单文件 `RuntimeServices` | 一整套 HOST 平面 service（registry/model/sandbox/...） |
| 信任边界 | 无 | `tool-cordis` 明确标注为"信任边界而非沙箱" |

### 5.4 示例刻意保留的"真实内核"

- **preset 是数据不是代码**：组合行为由"数据描述 + 加载器解释"完成，而非硬编码。
- **组合 = 在 scope 下挂插件子树**：与真实 `createScope` + mount 一致。
- **共享运行时 / 隔离作用域的两平面思想**：HOST 常驻、AGENT 贡献局部。
- **create 是事务、失败回滚**：真实工程里 mount 失败也要保证不留下半吊子 session。

---

## 6. 运行与验证

```bash
cd m14-preset-composition
npm start          # node --experimental-strip-types runner.ts
npm run typecheck  # tsc --noEmit（零错误）
```

预期：五个实验全部输出符合预期，`=== 全部实验完成 ===`。

---

## 7. 小结

- **preset 是组合 agent 的"配方数据"**，校验通过后才能 mount。
- **组合 = 在 session scope 下挂插件子树**（persona + tool-policy）。
- **所有 agent 共享一份运行时（HOST 平面），但各自拥有隔离的 scope 子树（AGENT 平面）**。
- **`create` 是事务**：校验→开 scope→挂载→审计→发布，失败回滚未发布的 scope。
- 下一模块可以把"agent loop（m12）+ 作用域（m13）+ preset 组合（m14）"三者合一：一个 preset 不仅组合工具，还组合整个 loop 行为，形成一个"可一键启停、互不干扰的多 agent 系统"。
```
