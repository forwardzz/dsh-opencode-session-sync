// fixture 驱动的单元测试：只喂「OpenCode 库里的行形状」，不依赖真实 OpenCode 库、
// 不依赖 DSH 宿主，所以能在任何机器（含 CI）上跑。
//
//   node --test test/convert.test.mjs
//
// 每个用例都额外跑一遍 lib/validate.js 的结构 + 跨事件关系校验。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildAppendPlan, buildSessionPlan, dshSessionIdFor, normalizeCwd } from '../lib/convert.js'
import { validatePlan } from '../lib/validate.js'

const T0 = 1791200000000

const SESSION = {
  id: 'ses_0123456789abcdefABCDEFghij',
  directory: 'C:/Users/ZJY/Desktop/dsh_ws',
  title: '测试会话',
  createdAt: T0,
  updatedAt: T0 + 90_000,
  parentId: null,
  model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
}

let seq = 0
const nextSeq = () => nextSeq.value++
nextSeq.value = 0

function userRow(text, at = T0) {
  return { id: `msg_user_${++seq}`, type: 'user', seq, createdAt: at, updatedAt: at, data: { text } }
}

function assistantRow(content, at = T0 + 1000, extra = {}) {
  return {
    id: `msg_assistant_${++seq}`,
    type: 'assistant',
    seq,
    createdAt: at,
    updatedAt: at + 500,
    data: {
      model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
      content,
      tokens: { input: 10, output: 5, total: 15, reasoning: 2, cache: { read: 3, write: 0 } },
      time: { created: at, completed: at + 500 },
      ...extra,
    },
  }
}

function toolBlock(name, callId, state = {}) {
  return {
    type: 'tool',
    id: callId,
    name,
    state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }], ...state },
  }
}

function idleRow(at = T0 + 2000) {
  return { id: `msg_idle_${++seq}`, type: 'idle', seq, createdAt: at, updatedAt: at, data: { time: { created: at }, outcome: 'succeeded' } }
}

const plan = (rows, options = {}) => buildSessionPlan({ session: SESSION, rows, options })

const types = (result) => result.events.map((event) => event.type)

test('基础对话：事件序列、header 与消息内容', () => {
  const result = plan([userRow('你好'), assistantRow([{ type: 'text', text: '你好，有什么可以帮你？' }]), idleRow()])
  assert.deepEqual(types(result), [
    'turn/start',
    'step/start',
    'user/message',
    'assistant/message',
    'step/end',
    'turn/end',
    'session/title',
  ])
  assert.deepEqual(validatePlan(result), [])

  assert.equal(result.header.version, 4)
  assert.equal(result.header.isSeeded, false)
  assert.equal(result.header.delegationDepth, 0)
  assert.equal(result.header.cwd, 'C:\\Users\\ZJY\\Desktop\\dsh_ws')
  assert.equal(result.header.createdAt, T0)
  assert.equal(result.header.id, dshSessionIdFor(SESSION.id))

  const user = result.events.find((event) => event.type === 'user/message')
  assert.equal(user.surfaceOp, 'append')
  assert.equal(user.data.source.kind, 'user')
  assert.equal(user.data.content[0].text, '你好')
  assert.equal(user.data.role, 'user')

  const assistant = result.events.find((event) => event.type === 'assistant/message')
  assert.equal(assistant.data.turn, 1)
  assert.equal(assistant.data.step, 1)
  assert.deepEqual(assistant.data.message.source, {
    kind: 'model',
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  })
  assert.equal(assistant.data.usage.inputTokens, 10)
  assert.equal(assistant.data.usage.cacheReadTokens, 3)
  assert.equal(assistant.data.stream.at(-1).chunk.type, 'finish')
  assert.equal(assistant.data.stream.at(-1).chunk.reason.kind, 'stop')

  assert.equal(result.events.at(-1).data.title, '测试会话')
  assert.deepEqual(result.events.at(-1).data.messageSeqs, [])
})

test('seq 从 0 连续、time 单调不减、信封字段完整', () => {
  const result = plan([userRow('a'), assistantRow([{ type: 'text', text: 'b' }]), idleRow()])
  result.events.forEach((event, index) => {
    assert.equal(event.seq, index)
    assert.ok(Number.isSafeInteger(event.time) && event.time >= 0)
    assert.equal(typeof event.data, 'object')
    assert.equal(event.ignorable, undefined)
  })
  for (let i = 1; i < result.events.length; i += 1) {
    assert.ok(result.events[i].time >= result.events[i - 1].time, `seq ${i} 的时间倒退了`)
  }
})

test('工具调用：tool/call + tool/result，且结果引用调用序号', () => {
  const rows = [
    userRow('读一下文件'),
    assistantRow([{ type: 'text', text: '好的' }, toolBlock('read', 'call_a', { content: [{ type: 'text', text: '文件内容' }] })]),
    idleRow(),
  ]
  const result = plan(rows)
  assert.deepEqual(validatePlan(result), [])
  const callIndex = result.events.findIndex((event) => event.type === 'tool/call')
  const resultEvent = result.events.find((event) => event.type === 'tool/result')
  assert.ok(callIndex > 0 && resultEvent !== undefined)
  assert.equal(result.events[callIndex].data.callId, 'call_a')
  assert.equal(result.events[callIndex].data.name, 'read')
  assert.equal(result.events[callIndex].data.arguments, '{}')
  assert.deepEqual(resultEvent.sourceEventSeqs, [result.events[callIndex].seq])
  assert.equal(resultEvent.data.message.source.kind, 'tool')
  assert.equal(resultEvent.data.message.toolCallId, 'call_a')
  assert.equal(resultEvent.data.message.content[0].text, '文件内容')
  assert.equal(resultEvent.data.message.isError, undefined)
  assert.equal(resultEvent.data.error, undefined)
  // assistant/message 的内容里必须带同名 tool-call 块，回放时才对得上
  const assistant = result.events.find((event) => event.type === 'assistant/message')
  const toolCallBlock = assistant.data.message.content.find((block) => block.type === 'tool-call')
  assert.equal(toolCallBlock.id, 'call_a')
  assert.equal(toolCallBlock.name, 'read')
})

test('工具报错：isError + data.error，内容带错误说明', () => {
  const rows = [
    userRow('试试'),
    assistantRow([
      toolBlock('webfetch', 'call_err', {
        status: 'error',
        error: { type: 'unknown', message: 'Request failed with status code: 403' },
      }),
    ]),
    idleRow(),
  ]
  const result = plan(rows)
  assert.deepEqual(validatePlan(result), [])
  const resultEvent = result.events.find((event) => event.type === 'tool/result')
  assert.equal(resultEvent.data.message.isError, true)
  assert.equal(resultEvent.data.error.name, 'OpenCodeToolError')
  assert.equal(resultEvent.data.error.code, 'unknown')
  assert.match(resultEvent.data.message.content[0].text, /403/)
  assert.equal(result.stats.toolErrors, 1)
})

test('重复 callId 会被改写成唯一值', () => {
  const rows = [
    userRow('两次同名调用'),
    assistantRow([
      toolBlock('read', 'call_same'),
      toolBlock('read', 'call_same'),
    ]),
    idleRow(),
  ]
  const result = plan(rows)
  assert.deepEqual(validatePlan(result), [])
  const ids = result.events.filter((event) => event.type === 'tool/call').map((event) => event.data.callId)
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
  assert.ok(ids.every((id) => id.startsWith('call_same')))
})

test('空 assistant 行被跳过，不产生多余 step', () => {
  const rows = [userRow('只有提问'), assistantRow([]), idleRow()]
  const result = plan(rows)
  assert.deepEqual(validatePlan(result), [])
  assert.equal(result.events.filter((event) => event.type === 'assistant/message').length, 0)
  assert.equal(result.events.filter((event) => event.type === 'step/start').length, 1)
  assert.equal(result.stats.skippedBlocks['empty-assistant-row'], 1)
})

test('includeReasoning=false 时丢掉推理块但保留正文与工具', () => {
  const rows = [
    userRow('带推理'),
    assistantRow([
      { type: 'reasoning', text: '先想一下' },
      { type: 'text', text: '答案' },
      toolBlock('grep', 'call_r'),
    ]),
    idleRow(),
  ]
  const result = plan(rows, { includeReasoning: false })
  assert.deepEqual(validatePlan(result), [])
  const assistant = result.events.find((event) => event.type === 'assistant/message')
  assert.deepEqual(assistant.data.message.content.map((block) => block.type), ['text', 'tool-call'])
  assert.equal(result.stats.skippedBlocks.reasoning, 1)
})

test('超长工具输出被截断并标注', () => {
  const long = 'x'.repeat(500)
  const rows = [
    userRow('大输出'),
    assistantRow([toolBlock('read', 'call_long', { content: [{ type: 'text', text: long }] })]),
    idleRow(),
  ]
  const result = plan(rows, { maxToolResultChars: 100 })
  assert.deepEqual(validatePlan(result), [])
  const text = result.events.find((event) => event.type === 'tool/result').data.message.content[0].text
  assert.match(text, /已截断 400 个字符/)
  assert.equal(result.stats.truncatedToolResults, 1)
})

test('标题：前缀生效，空标题回退到会话 id 尾段', () => {
  const withPrefix = buildSessionPlan({
    session: SESSION,
    rows: [userRow('hi'), assistantRow([{ type: 'text', text: 'yo' }]), idleRow()],
    options: { titlePrefix: '[OC] ' },
  })
  assert.equal(withPrefix.events.at(-1).data.title, '[OC] 测试会话')

  const blank = buildSessionPlan({
    session: { ...SESSION, title: '   ' },
    rows: [userRow('hi'), idleRow()],
    options: {},
  })
  assert.match(blank.events.at(-1).data.title, /^OpenCode 会话 /)
})

test('多回合：idle 切分回合，step 编号在每回合内从 1 重新计数', () => {
  const rows = [
    userRow('第一问', T0),
    assistantRow([{ type: 'text', text: '第一答' }], T0 + 1000),
    idleRow(T0 + 2000),
    userRow('第二问', T0 + 3000),
    assistantRow([{ type: 'text', text: '第二答' }, toolBlock('glob', 'call_2')], T0 + 4000),
    idleRow(T0 + 5000),
  ]
  const result = plan(rows)
  assert.deepEqual(validatePlan(result), [])
  assert.deepEqual(types(result), [
    'turn/start',
    'step/start',
    'user/message',
    'assistant/message',
    'step/end',
    'turn/end',
    'turn/start',
    'step/start',
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
    'turn/end',
    'session/title',
  ])
  const turns = result.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
  assert.deepEqual(turns, [1, 2])
  assert.equal(result.stats.turns, 2)
  assert.equal(result.stats.steps, 2)
})

test('同一回合里两条用户消息各自开新 step（与真实 DSH 形状一致）', () => {
  const rows = [
    userRow('第一句', T0),
    assistantRow([{ type: 'text', text: '回应一' }], T0 + 500),
    userRow('第二句', T0 + 600),
    assistantRow([{ type: 'text', text: '回应二' }], T0 + 900),
    idleRow(T0 + 1500),
  ]
  const result = plan(rows)
  assert.deepEqual(validatePlan(result), [])
  assert.equal(result.stats.turns, 1)
  assert.equal(result.stats.steps, 2)
  const steps = result.events.filter((event) => event.type === 'step/start').map((event) => event.data.step)
  assert.deepEqual(steps, [1, 2])
})

test('没有 idle 收尾时仍会闭合 turn', () => {
  const result = plan([userRow('未收尾'), assistantRow([{ type: 'text', text: '答' }])])
  assert.deepEqual(validatePlan(result), [])
  assert.equal(result.events.at(-2).type, 'turn/end')
})

test('非绝对路径的目录被省略，并给出警告', () => {
  const result = buildSessionPlan({
    session: { ...SESSION, directory: 'relative/path' },
    rows: [userRow('hi'), idleRow()],
    options: {},
  })
  assert.equal(result.header.cwd, undefined)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /不是绝对路径/)
  assert.deepEqual(validatePlan(result), [])
})

test('未知/噪音事件只计数、不进入事件流', () => {
  seq += 1
  const rows = [
    { id: 'msg_sys', type: 'system', seq, createdAt: T0, updatedAt: T0, data: { text: '工具变更' } },
    userRow('hi', T0 + 1),
    { id: 'msg_comp', type: 'compaction', seq: seq + 2, createdAt: T0 + 2, updatedAt: T0 + 2, data: { summary: '摘要' } },
    idleRow(T0 + 3),
  ]
  const result = plan(rows)
  assert.deepEqual(validatePlan(result), [])
  assert.equal(result.stats.skippedEvents.system, 1)
  assert.equal(result.stats.skippedEvents.compaction, 1)
})

test('dshSessionIdFor：稳定、唯一、形如 session-<uuid>', () => {
  const a = dshSessionIdFor('ses_one')
  const b = dshSessionIdFor('ses_one')
  const c = dshSessionIdFor('ses_two')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('normalizeCwd：Windows 盘符、UNC、POSIX、相对路径', () => {
  assert.equal(normalizeCwd('C:/Users/ZJY/Desktop/dsh_ws/'), 'C:\\Users\\ZJY\\Desktop\\dsh_ws')
  assert.equal(normalizeCwd('c:\\a\\b'), 'c:\\a\\b')
  assert.equal(normalizeCwd('\\\\server\\share\\dir\\'), '\\\\server\\share\\dir')
  assert.equal(normalizeCwd('/home/zjy/project/'), '/home/zjy/project')
  assert.equal(normalizeCwd('/'), '/')
  assert.equal(normalizeCwd('relative/path'), null)
  assert.equal(normalizeCwd(''), null)
  assert.equal(normalizeCwd(null), null)
})

test('模型信息缺失时回退到会话级模型，仍满足 model 来源要求', () => {
  const row = assistantRow([{ type: 'text', text: '答' }])
  delete row.data.model
  const result = plan([userRow('hi'), row, idleRow()])
  assert.deepEqual(validatePlan(result), [])
  const assistant = result.events.find((event) => event.type === 'assistant/message')
  assert.equal(assistant.data.message.source.provider, 'opencode-go')
  assert.equal(assistant.data.message.source.model, 'deepseek-v4.1-flash')

  const orphanRow = assistantRow([{ type: 'text', text: '答' }])
  delete orphanRow.data.model
  const bare = buildSessionPlan({
    session: { ...SESSION, model: null },
    rows: [userRow('hi'), orphanRow],
    options: {},
  })
  assert.deepEqual(validatePlan(bare), [])
  assert.deepEqual(bare.events.find((event) => event.type === 'assistant/message').data.message.source, {
    kind: 'model',
    provider: 'opencode',
    model: 'unknown',
  })
})

// ---------------------------------------------------------------- 增量追加

/** 先做一次首次导入，拿到既有日志，再按它的末尾坐标构造追加段。 */
function importThenAppend(firstRows, laterRows, appendOptions = {}) {
  const first = plan(firstRows)
  const lastSeq = first.events.at(-1).seq
  const maxTurn = Math.max(...first.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn))
  const append = buildAppendPlan({
    session: SESSION,
    rows: laterRows,
    options: {
      startSeq: lastSeq + 1,
      startTurn: maxTurn + 1,
      baseTime: first.events.at(-1).time,
      ...appendOptions,
    },
  })
  return { first, append, combined: { header: first.header, events: [...first.events, ...append.events] } }
}

test('增量追加：seq 与 turn 号接在既有日志之后，合并后仍通过校验', () => {
  const { first, append, combined } = importThenAppend(
    [userRow('第一问'), assistantRow([{ type: 'text', text: '第一答' }]), idleRow()],
    [userRow('第二问'), assistantRow([{ type: 'text', text: '第二答' }]), idleRow()],
  )
  assert.equal(append.events[0].seq, first.events.at(-1).seq + 1)
  assert.equal(append.events[0].type, 'turn/start')
  assert.equal(append.events[0].data.turn, 2)
  assert.deepEqual(
    combined.events.map((event) => event.seq),
    combined.events.map((_, index) => index),
  )
  assert.deepEqual(validatePlan(combined), [])
  const users = combined.events.filter((e) => e.type === 'user/message').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['第一问', '第二问'])
})

test('增量追加：idle 行决定轮边界，两轮不会被并成一整轮', () => {
  const { append } = importThenAppend(
    [userRow('第一问'), assistantRow([{ type: 'text', text: '第一答' }]), idleRow()],
    // 故意带上 idle：真实调用方切出的是「源的后缀」，idle 在其中
    [userRow('第二问'), assistantRow([{ type: 'text', text: '第二答' }]), idleRow(), userRow('第三问'), assistantRow([{ type: 'text', text: '第三答' }]), idleRow()],
  )
  assert.deepEqual(append.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn), [2, 3])
  assert.equal(append.stats.turns, 2)
})

test('增量追加：标题没变就不重复写标题事件，变了才补一条', () => {
  const rows = [userRow('问'), assistantRow([{ type: 'text', text: '答' }]), idleRow()]
  const same = importThenAppend(rows, [userRow('再问'), assistantRow([{ type: 'text', text: '再答' }]), idleRow()], {
    currentTitle: '测试会话',
  })
  assert.equal(same.append.titleChanged, false)
  assert.equal(same.append.events.filter((e) => e.type === 'session/title').length, 0)

  const changed = importThenAppend(rows, [userRow('再问'), assistantRow([{ type: 'text', text: '再答' }]), idleRow()], {
    currentTitle: '旧标题',
  })
  assert.equal(changed.append.titleChanged, true)
  const titles = changed.append.events.filter((e) => e.type === 'session/title')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].data.title, '测试会话')
  assert.deepEqual(validatePlan(changed.combined), [])
})

test('增量追加：没有可导入的行时不产生任何事件', () => {
  seq += 1
  const onlyNoise = [
    { id: 'msg_sys_1', type: 'system', seq, createdAt: T0, updatedAt: T0, data: { text: '工具变更' } },
    idleRow(),
  ]
  const { append } = importThenAppend([userRow('问'), assistantRow([{ type: 'text', text: '答' }]), idleRow()], onlyNoise)
  assert.equal(append.events.length, 0)
  assert.equal(append.stats.events, 0)
})

test('增量追加：工具调用与错误结果同样接续', () => {
  const { append, combined } = importThenAppend(
    [userRow('第一问'), assistantRow([{ type: 'text', text: '第一答' }]), idleRow()],
    [
      userRow('第二问'),
      assistantRow([
        toolBlock('read', 'call_inc', { content: [{ type: 'text', text: '内容' }] }),
        toolBlock('bad', 'call_bad', { status: 'error', error: { type: 'unknown', message: 'boom' } }),
      ]),
      idleRow(),
    ],
  )
  assert.deepEqual(validatePlan(combined), [])
  const calls = append.events.filter((e) => e.type === 'tool/call').map((e) => e.data.callId)
  assert.deepEqual(calls, ['call_inc', 'call_bad'])
  assert.equal(append.events.find((e) => e.data?.message?.toolCallId === 'call_bad').data.message.isError, true)
})
