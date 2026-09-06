# m12 · Loop 也是插件（Agent Loop as Plugin）

> 一句话：**Agent Loop 不是框架里写死的核心，而是一个通过 Service/插件生命周期进入系统的普通插件。**
> 它只做协调（turn / step 的时间顺序），所有能力（llm / session / prompt / tools）都通过服务解析，绝不 import 具体实现。

---

## 1. 为什么"Loop 也是插件"

传统 agent 框架把"循环调用模型、执行工具"写成框架内核，模型适配器、工具、记忆都被硬编码进 `Agent` 类。

deepseek-harness 的颠覆性设计（s13）：**Loop 本身是一个插件**。这意味着：

- 换模型供应商（Azure → 本地 Ollama）→ 换一个 `llm` 插件，**Loop 一行不改**
- 换持久化（内存 → Postgres）→ 换一个 `session` 插件，**Loop 一行不改**
- 换驱动器（目标驱动 loop / workflow runner / replay driver）→ 提供一个新的 `agent` 服务，**能力插件一行不改**

课程目标：把这套思想落到可运行的 TS 代码里，并验证"换插件无需改 Loop"。

---

## 2. 课程代码地图

| 文件 | 角色 | 真实工程对照 |
|------|------|--------------|
| `loop.ts` | `AgentLoop extends Service`，声明依赖服务，实现 turn/step 协调 | `deepseek-harness/packages/core/agent-loop` 的 `AgentLoop` |
| `llm.ts` | 脚本化 `ScriptedLlm` 服务（确定性模型，无需网络） | `packages/core/agent-default-model` / `llm` provider 插件 |
| `prompt.ts` | `PromptService`（render 系统提示词） | `packages/core/system-prompt` |
| `session.ts` | `SessionService`（事件溯源 append + 投影） | `packages/core/session` |
| `tools.ts` | `ToolRegistry`（register / schemas / execute） | `packages/core/tools` |
| `plugins.ts` | 把各能力 + AgentLoop 装配为独立插件 | s13 的"每个组件通过挂载接入" |
| `runner.ts` | 4 个实验 | 无（演示用） |

> m09（Prompt 是多方贡献）、m10（工具即插件）、m11（策略包裹执行）的能力在这里被**整合**进一个 Loop。

---

## 3. 核心：AgentLoop 如何"只做协调"

```ts
export class AgentLoop extends Service {
  // 硬依赖：通过 cordis 服务解析注入，绝不 import 具体实现
  static inject = ['llm', 'session', 'prompt', 'tools'] as const

  constructor(ctx: Context, config = {}) {
    super(ctx, 'agent')   // 把自己注册为 ctx.agent 服务
  }

  async run(userInput: string): Promise<string> {
    const llm = this.ctx.llm       // 解析到的"与 provider 无关"的 LLM 服务
    const session = this.ctx.session
    const prompt = this.ctx.prompt
    const tools = this.ctx.tools

    session.append('turn/start', { turn: 1 })
    session.append('user/message', { content: userInput })

    while (step < MAX_STEPS) {
      session.append('step/start', ...)
      const response = await llm.complete({      // 模型决策
        system: prompt.render(),
        messages: session.messages(),
        tools: tools.schemas(),
      })
      session.append('assistant/message', { ...response })
      if (response.toolCalls.length === 0) return response.text  // 模型自然停止
      for (const call of response.toolCalls) {                    // 执行工具
        const result = await tools.execute(call)
        session.append('tool/result', { ...result })
      }
    }
  }
}
```

三个关键点：

1. **依赖声明而非 import**：`static inject = ['llm','session','prompt','tools']`。cordis 在激活 `AgentLoop` 前，先确保这些服务就绪，否则 `AgentLoop` 不会启动。
2. **模型自己决定**：Loop 不硬编码"调哪个工具、调几次"。`if (toolCalls.length === 0) return` 表示"模型不再要工具 = 停止"。
3. **Session 是唯一事实源**：Loop 从不维护自己的 `messages[]`，每次请求都从 `session.messages()` 投影。

---

## 4. 调用过程解读（一次 turn 的全景）

```
用户输入
  │
  ├─ session.append('turn/start')
  ├─ session.append('user/message')
  │
  └─ while step < MAX:
       ├─ session.append('step/start')
       ├─ llm.complete({ system, messages: session.messages(), tools: tools.schemas() })
       │     └─ 模型：第 1 步返回 tool_call；有 tool/result 后返回纯文本
       ├─ session.append('assistant/message')   ← 模型产出是"事实"，先记录
       ├─ if 无 toolCalls → return（模型自然停止）
       └─ for each call:
            ├─ session.append('tool/call')
            ├─ tools.execute(call)
            └─ session.append('tool/result')
```

实验①的完整日志正好印证这条流：
```
turn/start → user/message → step/start → request/header
  → 模型发起 echo → assistant/message → tool/call → tool/result → step/end
  → step/start → 模型不再调用 → assistant/message → step/end → turn/end
```

**洋葱心智**：模型在"最里层"决策，Loop 在外层只负责把决策翻译成 Session 事实与工具调用，再把结果喂回下一轮。这与 m11「策略包裹执行」的洋葱结构是一致的——都是"框架搭管线和编排，具体行为由插件贡献"。

---

## 5. 运行演示

```bash
npm install        # 或复用同级 m10 的 node_modules（symlink）
npm start          # node --experimental-strip-types runner.ts
npm run typecheck  # tsc --noEmit
```

四个实验（每个实验用独立 Context 装配，演示"换插件 = 换装配"）：

| 实验 | 装配变化 | 验证点 |
|------|---------|--------|
| ① 基础 turn | 默认全装配 | Loop 协调模型调用 echo 后自然停止 |
| ② 替换 provider | 不挂 `llmPlugin`，改挂 `DirectLlm` | **AgentLoop 代码不变**，模型直接回答 |
| ③ 卸载工具 | `ctx.tools.unregister('echo')` | schema 中无 echo，模型自适应为直接回答 |
| ④ 替换驱动器 | 提供 `SingleShotAgent` 作为新 `agent` 服务 | 能力插件（llm/session/prompt/tools）一字未改 |

> 注：cordis 禁止运行时热删插件（`ctx.delete` 不存在），故实验用"独立 Context 装配"表达"换插件"，这与真实 Harness 通过配置/分支装载不同插件集合等价。

输出节选：
```
① 最终回答： done: 已通过工具回声验证 loop 作为插件运转正常。
② 最终回答： hello from direct provider
   ⇒ AgentLoop 代码一字未改，只换了 provider 插件
③ 当前工具表仍含 echo？ false
   ⇒ 工具从 schema 中消失，模型自适应为直接回答
④ 最终回答： [singleshot] done: 已通过工具回声验证 loop 作为插件运转正常。
   ⇒ 同一组能力之上，换驱动器无需改它们
```

---

## 6. 配图

- `images/loop-as-plugin.svg`：AgentLoop 插件与四个能力服务的依赖图。
- `images/vs-traditional.svg`：传统写死 vs 插件化 Loop。

---

## 7. 示例 vs deepseek-harness 真实工程实践

| 维度 | 课程示例（m12） | deepseek-harness 真实实现 |
|------|----------------|---------------------------|
| Loop 形态 | `AgentLoop extends Service` | `AgentLoop extends Service`（同） |
| 依赖方式 | `static inject = ['llm','session','prompt','tools']` | 同，通过 cordis service 解析 |
| 模型调用 | `llm.complete({system, messages, tools})` | `ctx.require('llm').complete(...)`（同签名思想） |
| 停止条件 | `toolCalls.length === 0 → return` | 模型 `finishReason==='stop'` 自然停止（同） |
| Session | `append` 事件 + `messages()` 投影 | s13 的 event-sourced `Session`（同） |
| 工具 | `tools.schemas()` + `tools.execute()` | 同（m10/m11 已讲） |
| 模型实现 | 确定性 `ScriptedLlm`（无网络） | 真实 Azure / 本地 provider 插件 |
| 换 provider | 换 Context 里挂的 llm 插件 | 换 `agent-default-model` / 其他 provider 插件 |
| 换驱动器 | 提供新 `agent` 服务 | 提供 workflow / goal-loop / replay driver |

> 课程把 s13 的"Loop 是插件"思想完整搬到 TS：AgentLoop 与真实实现**结构一致**，仅把真实 LLM 换成确定性脚本模型，把真实持久化换成内存事件数组。

---

## 8. 小结

- **Loop 不是内核，是插件**：通过 Service 生命周期进入，声明依赖服务。
- **只协调、不实现**：turn/step 的顺序由它编排，具体能力全靠服务解析。
- **可替换性 = 可演进性**：换 provider / 工具 / 驱动器都不碰 Loop 代码——这正是 deepseek-harness 架构最锋利的一点。
- 与 m09~m11 一脉相承：**能力由插件贡献，框架只搭管线与编排**。
