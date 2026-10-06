// 会话计划的本地结构校验：不依赖 DSH 宿主，供自检脚本与单元测试共用。
//
// 规则来自 DSH 会话格式 V4 的已发布约束：
//   * 信封：{ type, seq, time, data }，seq 从 0 连续，time 为非负安全整数
//   * 表面事件（system/developer/user/assistant/tool-result）必须带 surfaceOp
//   * 表面事件必须带非空消息 id、对象 source、数组 content
//   * assistant/message 的 source 必须是 model + 非空 provider/model，且带 stream
//   * tool/result 的 source 必须是 tool + callId，且 toolCallId 与之一致
//   * 内容块类型必须在已知集合内；stream 的 blockType 同理
//   * 不写 `ignorable`（那是给更新 harness 的兼容标记）
// 跨事件关系（turn/step 顺序、tool 调用结算）对应 dsh-session 的 invariant 包。

export const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

export const CONTENT_BLOCK_TYPES = new Set([
  'text',
  'reasoning',
  'image',
  'file',
  'tool-call',
  'tool-addition',
  'tool-removal',
])

/** 逐事件做「信封 + 表面 + 内容」校验，返回问题列表（空数组 = 通过）。 */
export function checkEnvelope(plan, problems = []) {
  const id = plan?.header?.id ?? '(缺少 header.id)'
  const events = Array.isArray(plan?.events) ? plan.events : []
  let lastSeq = -1
  for (const event of events) {
    const where = `${id} seq ${event?.seq} ${event?.type}`
    if (typeof event?.type !== 'string' || event.type === '') problems.push(`${where}: 缺少 type`)
    if (event?.seq !== lastSeq + 1) problems.push(`${where}: seq 不连续（上一条 ${lastSeq}）`)
    lastSeq = event?.seq
    if (!Number.isSafeInteger(event?.time) || event.time < 0) problems.push(`${where}: time 不是非负安全整数`)
    if (event?.data === null || typeof event?.data !== 'object') problems.push(`${where}: data 不是对象`)
    if (event?.ignorable !== undefined) problems.push(`${where}: 不应带 ignorable`)

    if (SURFACE_EVENT_TYPES.has(event.type)) {
      if (event.surfaceOp !== 'append') problems.push(`${where}: 表面事件必须带 surfaceOp='append'`)
      if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
        problems.push(`${where}: assistant/message 不能带 sourceEventSeqs`)
      }
      const message = event.type === 'user/message' ? event.data : event.data?.message
      if (typeof message?.id !== 'string' || message.id === '') problems.push(`${where}: 消息缺少非空 id`)
      if (typeof message?.source?.kind !== 'string' || message.source.kind === '') {
        problems.push(`${where}: source.kind 无效`)
      }
      if (!Array.isArray(message?.content)) problems.push(`${where}: content 不是数组`)
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (!CONTENT_BLOCK_TYPES.has(block?.type)) problems.push(`${where}: 未知内容块类型 ${String(block?.type)}`)
      }
      if (event.type === 'assistant/message') {
        const source = message?.source ?? {}
        if (
          source.kind !== 'model' ||
          typeof source.provider !== 'string' ||
          source.provider === '' ||
          typeof source.model !== 'string' ||
          source.model === ''
        ) {
          problems.push(`${where}: assistant/message 的 source 必须是 model + provider/model`)
        }
        if (!Array.isArray(event.data.stream)) problems.push(`${where}: assistant/message 缺少 stream 数组`)
        for (const record of event.data.stream ?? []) {
          if (
            record?.type === 'chunk' &&
            record.chunk?.type === 'block-start' &&
            !CONTENT_BLOCK_TYPES.has(record.chunk.blockType)
          ) {
            problems.push(`${where}: stream 里出现未知 blockType ${String(record.chunk.blockType)}`)
          }
        }
      }
      if (event.type === 'tool/result') {
        const source = message?.source ?? {}
        if (source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
          problems.push(`${where}: tool/result 的 source 必须是 tool + callId`)
        }
        if (message?.toolCallId !== source.callId) problems.push(`${where}: toolCallId 与 callId 不一致`)
        if (event.data.error !== undefined && message?.isError !== true) {
          problems.push(`${where}: 有 error 却没有 isError`)
        }
      }
      continue
    }

    if (event.type !== 'tool/result' && (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined)) {
      problems.push(`${where}: 非表面事件不该带 surfaceOp/sourceEventSeqs`)
    }
  }

  const header = plan?.header ?? {}
  if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) problems.push(`${id}: header.createdAt 无效`)
  if (header.version !== 4) problems.push(`${id}: header.version 必须是 4`)
  if (header.isSeeded !== false) problems.push(`${id}: header.isSeeded 必须是 false`)
  if (header.cwd !== undefined && !/^([A-Za-z]:\\|\\\\|\/)/.test(header.cwd)) {
    problems.push(`${id}: header.cwd 不是绝对路径：${header.cwd}`)
  }
  return problems
}

/** DSH 的跨事件关系约束（turn/step 顺序、tool 调用结算、序号引用）。 */
export function checkRelationships(plan, problems = []) {
  const id = plan?.header?.id ?? '(缺少 header.id)'
  const events = Array.isArray(plan?.events) ? plan.events : []
  let openTurn = null
  let openStep = null
  let nextTurn = 1
  let nextStep = 1
  let pending = new Set()

  for (const event of events) {
    const where = `${id} seq ${event?.seq} ${event?.type}`
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        if (openTurn !== null) problems.push(`${where}: turn ${openTurn} 还开着`)
        if (data.turn !== nextTurn) problems.push(`${where}: turn 编号应为 ${nextTurn}`)
        openTurn = data.turn
        nextStep = 1
        break
      case 'turn/end':
        if (openTurn !== data.turn) problems.push(`${where}: 与打开的 turn 不匹配`)
        if (openStep !== null) problems.push(`${where}: step 还开着`)
        openTurn = null
        nextTurn += 1
        break
      case 'step/start':
        if (openTurn !== data.turn) problems.push(`${where}: 不在打开的 turn 内`)
        if (openStep !== null) problems.push(`${where}: 上一个 step 还开着`)
        if (data.step !== nextStep) problems.push(`${where}: step 编号应为 ${nextStep}`)
        openStep = data.step
        break
      case 'step/end':
        if (openTurn !== data.turn || openStep !== data.step) problems.push(`${where}: 与打开的 turn/step 不匹配`)
        openStep = null
        nextStep += 1
        pending = new Set()
        break
      case 'assistant/message':
      case 'system/message':
      case 'developer/message':
        if (openTurn !== data.turn || openStep !== data.step) problems.push(`${where}: 需要打开的 turn/step`)
        break
      case 'tool/call':
        if (openTurn !== data.turn || openStep !== data.step) problems.push(`${where}: 需要打开的 turn/step`)
        pending.add(data.callId)
        break
      case 'tool/result': {
        if (event.surfaceOp === 'append' && (openTurn !== data.turn || openStep !== data.step)) {
          problems.push(`${where}: 需要打开的 turn/step`)
        }
        const callId = data.message?.source?.callId
        if (!pending.has(callId)) problems.push(`${where}: 同一 step 内没有对应的 tool/call`)
        pending.delete(callId)
        for (const seq of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
          if (!(seq < event.seq)) problems.push(`${where}: sourceEventSeqs 必须引用更早的事件`)
        }
        break
      }
      case 'session/title':
        if (typeof data.title !== 'string' || data.title === '') problems.push(`${where}: 标题为空`)
        if (!Array.isArray(data.messageSeqs)) problems.push(`${where}: messageSeqs 必须是数组`)
        if (typeof data.source?.kind !== 'string' || data.source.kind === '') {
          problems.push(`${where}: 标题缺少 source`)
        }
        break
      default:
        break
    }
  }

  if (openTurn !== null) problems.push(`${id}: 结束时 turn ${openTurn} 仍开着`)
  if (openStep !== null) problems.push(`${id}: 结束时 step ${openStep} 仍开着`)
  if (pending.size > 0) problems.push(`${id}: 有未结算的 tool/call：${[...pending].join(',')}`)
  return problems
}

/** 一次跑完两类校验。 */
export function validatePlan(plan) {
  return checkRelationships(plan, checkEnvelope(plan))
}
