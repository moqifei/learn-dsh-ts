/**
 * m08 · 事件溯源 Session —— 运行演示
 *
 * 演示四件事（词汇对齐真实 SessionEventMap）：
 *   1. 往 Session 追加事件（turn/step 边界 + message/chunk/tool）；
 *   2. 用两个投影派生视图：deriveMessages() 聊天消息、deriveStats() 统计；
 *   3. 「恢复会话」= 把同一份日志灌入新 Session 再派生（状态从不单独存储）；
 *   4. 不可变性：append 时 data 被深拷贝，调用方后续改对象不影响日志真相。
 */

import { Session } from './session.ts'
import type { SessionEvent } from './events.ts'

/** 用时钟打点，保证 time 单调递增，便于演示 ttftMs/toolMs 派生。 */
let clock = 1_000
function now(): number {
  clock += 7
  return clock
}

/** 构造一条事件：自动填好 seq 与时间戳（data 会被 Session 深拷贝）。 */
function emit(session: Session, base: Omit<SessionEvent, 'seq' | 'time'>): SessionEvent {
  const event = { ...base, seq: session.seq, time: now() } as SessionEvent
  session.append(event)
  return event
}

export async function apply(_ctx: any): Promise<void> {
  console.log('==== m08 事件溯源 Session ====\n')

  // ── 1. 追加事件（模拟一次真实 turn：含两个 step + 一次工具调用） ───
  const s = new Session('demo-1')

  // 订阅：事件溯源的"副作用出口"——真实实现里 projection / telemetry 挂在这。
  s.onAppend(e => console.log(`  [event] seq=${e.seq} ${e.type}`))

  emit(s, { type: 'turn/start', data: { turn: 1 } })
  emit(s, { type: 'user/message', data: { turn: 1, content: '帮我查下北京天气' } })

  emit(s, { type: 'step/start', data: { turn: 1, step: 1 } })
  emit(s, { type: 'request/header', data: { turn: 1, step: 1, provider: 'fake', model: 'mock', system: 'you are helpful' } })
  emit(s, { type: 'assistant/chunk', data: { turn: 1, step: 1, delta: '北京今天' } })
  emit(s, { type: 'assistant/chunk', data: { turn: 1, step: 1, delta: '晴，22℃。' } })
  emit(s, { type: 'assistant/message', data: { turn: 1, step: 1, text: '北京今天晴，22℃。' } })

  emit(s, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'getWeather', arguments: '{"city":"北京"}' } })
  emit(s, { type: 'tool/result', data: { turn: 1, step: 1, callId: 'c1', output: '{"temp":22,"sky":"clear"}' } })

  emit(s, { type: 'step/start', data: { turn: 1, step: 2 } })
  emit(s, { type: 'assistant/chunk', data: { turn: 1, step: 2, delta: '已为你查到' } })
  emit(s, { type: 'assistant/message', data: { turn: 1, step: 2, text: '已为你查到北京天气：晴，22℃。' } })
  emit(s, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })

  console.log('\n  —— 事件日志是"唯一真相"，共', s.seq, '条 ——')

  // ── 2. 两个投影派生视图 ────────────────────────────────────────
  const messages = s.deriveMessages()
  const stats = s.deriveStats()
  console.log('\n[deriveMessages] 派生出的聊天消息：')
  for (const m of messages) {
    console.log(`  turn=${m.turn} ${m.role.padEnd(9)} | ${m.parts.map(p => p.text).join('')}`)
  }
  console.log('\n[deriveStats] 派生的统计：', JSON.stringify(stats))

  // ── 3. 恢复会话 = 灌入同一份日志 ──────────────────────────────
  const recovered = new Session('demo-1-replay', s.events)
  const again = recovered.deriveMessages()
  const againStats = recovered.deriveStats()
  console.log('\n[重放恢复] 消息一致：', JSON.stringify(again) === JSON.stringify(messages) ? '✅' : '❌',
              ' | 统计一致：', JSON.stringify(againStats) === JSON.stringify(stats) ? '✅' : '❌')

  // ── 4. 不可变性：改动被 emit 的对象，日志不变 ──────────────────
  const probe = emit(s, { type: 'user/message', data: { turn: 1, content: '探针消息' } })
  ;(probe.data as any).content = '被篡改'
  const last = s.events[s.events.length - 1] as Extract<SessionEvent, { type: 'user/message' }>
  console.log('\n[不可变性] append 后改调用方对象，日志是否仍干净：',
    (last.data as any).content === '探针消息' ? '✅ 未被篡改' : '❌ 被污染')

  console.log('\n==== 结束 ====')
}
