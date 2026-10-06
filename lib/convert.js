// OpenCode 会话 → DSH V4 会话事件日志的纯转换层。
//
// 设计约束（来自 DSH 会话格式 V4 的已发布规则，见 README「依据」一节）：
//   * 每个事件信封 = { type, seq, time, data }，seq 从 0 连续递增。
//   * 表面事件（user/assistant/tool-result）必须带 surfaceOp: 'append'。
//   * turn/start、step/start 的编号必须从 1 起连续，且不能重入。
//   * tool/call 要求 step 打开；tool/result 要求同一 step 内已有对应 tool/call。
//   * assistant/message 的 source 必须是 kind:'model' 且带 provider/model 字符串。
//   * tool/result 的 message.source.kind 必须是 'tool'，callId 与 toolCallId 一致。
//   * 不写 `ignorable`（那是给更新的 harness 用的兼容标记）。
//
// 本模块不依赖 DSH 宿主，可单独用 node 运行，便于离线自检。

import { createHash } from 'node:crypto'

/** 由 OpenCode 会话 id 推导出稳定的 DSH 会话 id（重复导入得到同一个 id）。 */
export function dshSessionIdFor(openCodeId) {
  const hex = createHash('sha256').update(`opencode-session-sync:${openCodeId}`).digest('hex')
  return `session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** 把 OpenCode 的目录写法规范成宿主平台风格（`C:/a/b` → `C:\a\b`）。 */
export function normalizeCwd(directory) {
  if (typeof directory !== 'string') return null
  const raw = directory.trim()
  if (raw === '') return null
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw.replace(/\//g, '\\').replace(/[\\/]+$/, '')
  if (raw.startsWith('\\\\')) return raw.replace(/\//g, '\\').replace(/[\\/]+$/, '')
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '') || '/'
  return null
}

const MAX_TOOL_NAME = 64
const DEFAULT_MAX_TOOL_RESULT_CHARS = 200_000

function sanitizeToolName(name) {
  const raw = typeof name === 'string' ? name.trim() : ''
  if (raw === '') return 'unknown'
  const cleaned = raw.replace(/[^\w.:+-]/g, '_').slice(0, MAX_TOOL_NAME)
  return cleaned === '' ? 'unknown' : cleaned
}

function trimBlock(text, limit) {
  if (typeof text !== 'string') return ''
  if (limit > 0 && text.length > limit) {
    return `${text.slice(0, limit)}\n\n[已截断 ${text.length - limit} 个字符，原始长度 ${text.length}]`
  }
  return text
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

/** OpenCode assistant 行的 tokens 字段 → DSH TokenUsage。 */
function toUsage(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined
  const cache = tokens.cache !== null && typeof tokens.cache === 'object' ? tokens.cache : {}
  const usage = {}
  const input = numberOrUndefined(tokens.input)
  const output = numberOrUndefined(tokens.output)
  const total = numberOrUndefined(tokens.total)
  const reasoning = numberOrUndefined(tokens.reasoning)
  const cacheRead = numberOrUndefined(cache.read)
  const cacheWrite = numberOrUndefined(cache.write)
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (total !== undefined) usage.totalTokens = total
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  return usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined : usage
}

/** 把一行的模型信息收敛成 DSH 需要的 provider/model 对。 */
function modelPair(rowModel, sessionModel, fallback) {
  const candidates = [rowModel, sessionModel, fallback]
  for (const candidate of candidates) {
    const provider = typeof candidate?.providerID === 'string' && candidate.providerID !== ''
      ? candidate.providerID
      : typeof candidate?.provider === 'string' && candidate.provider !== ''
        ? candidate.provider
        : null
    const model = typeof candidate?.id === 'string' && candidate.id !== ''
      ? candidate.id
      : typeof candidate?.modelID === 'string' && candidate.modelID !== ''
        ? candidate.modelID
        : typeof candidate?.model === 'string' && candidate.model !== ''
          ? candidate.model
          : null
    if (provider !== null && model !== null) return { provider, model }
  }
  return { provider: 'opencode', model: 'unknown' }
}

function textOf(block) {
  return typeof block?.text === 'string' ? block.text : ''
}

/**
 * 事件核心：把 OpenCode 的正文行展开成 DSH 事件序列。
 *
 * 起始 seq 与起始 turn 可指定，因此同一套逻辑同时服务两种场景：
 *   * 首次导入：startSeq=0、startTurn=1
 *   * 增量追加：startSeq=既有日志长度、startTurn=既有最大 turn + 1、baseTime=最后一条事件的时间
 *
 * @param {object} input
 * @param {object} input.session   OpenCode 会话行
 * @param {object[]} input.rows    session_message 行（时间升序）
 * @param {object} [input.options] startSeq / startTurn / baseTime / maxToolResultChars / includeReasoning / includeToolCalls / now
 * @returns {{events: object[], stats: object, sourceRowIds: string[]}}
 */
export function buildEventCore({ session, rows, options = {} }) {
  const maxToolResultChars = Number.isFinite(options.maxToolResultChars)
    ? Number(options.maxToolResultChars)
    : DEFAULT_MAX_TOOL_RESULT_CHARS
  const includeReasoning = options.includeReasoning !== false
  const includeToolCalls = options.includeToolCalls !== false
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()

  const stats = {
    turns: 0,
    steps: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    reasoningBlocks: 0,
    textBlocks: 0,
    events: 0,
    truncatedToolResults: 0,
    skippedEvents: {},
    skippedBlocks: {},
  }

  const createdAt = Number.isFinite(session.createdAt) && session.createdAt > 0 ? session.createdAt : now
  const startSeq = Number.isSafeInteger(options.startSeq) && options.startSeq >= 0 ? options.startSeq : 0
  const startTurn = Number.isSafeInteger(options.startTurn) && options.startTurn > 0 ? options.startTurn : 1
  const baseTime = Number.isFinite(options.baseTime) && options.baseTime > 0 ? options.baseTime : createdAt

  const events = []
  const sourceRowIds = []
  let clock = baseTime
  const nextTime = (hint) => {
    const t = Number.isFinite(hint) && hint > 0 ? hint : clock
    clock = Math.max(clock, t)
    return clock
  }
  const push = (type, data, extra = {}, timeHint) => {
    events.push({ type, seq: startSeq + events.length, time: nextTime(timeHint), data, ...extra })
  }

  // ---- 会话正文按 idle 切分成「轮」，再按 DSH 的 turn/step 结构展开 ----
  const items = []
  for (const row of rows) {
    if (row.type === 'user' || row.type === 'assistant') items.push(row)
    else if (row.type === 'idle') items.push({ ...row, type: 'idle' })
    else stats.skippedEvents[row.type] = (stats.skippedEvents[row.type] ?? 0) + 1
  }

  const turns = []
  let current = null
  for (const item of items) {
    if (item.type === 'user' || item.type === 'assistant') {
      if (current === null) current = { items: [] }
      current.items.push(item)
      continue
    }
    // idle：收束当前轮
    if (current !== null && current.items.length > 0) {
      turns.push(current)
      current = null
    }
  }
  if (current !== null && current.items.length > 0) turns.push(current)

  const usedCallIds = new Set()
  const uniqueCallId = (candidate, index) => {
    const base = typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : `oc-call-${index}`
    let id = base
    let suffix = 2
    while (usedCallIds.has(id)) {
      id = `${base}-${suffix}`
      suffix += 1
    }
    usedCallIds.add(id)
    return id
  }

  let turnNumber = startTurn - 1
  let stepNumber = 0
  let stepOpen = false
  let stepHasAssistant = false

  const openTurn = () => {
    turnNumber += 1
    stepNumber = 0
    push('turn/start', { turn: turnNumber }, {}, turns[turnNumber - startTurn]?.items?.[0]?.createdAt)
    stats.turns += 1
  }
  const openStep = () => {
    stepNumber += 1
    push('step/start', { turn: turnNumber, step: stepNumber })
    stepOpen = true
    stepHasAssistant = false
    stats.steps += 1
  }
  const closeStep = () => {
    if (!stepOpen) return
    push('step/end', { turn: turnNumber, step: stepNumber })
    stepOpen = false
  }
  const closeTurn = () => {
    closeStep()
    push('turn/end', { turn: turnNumber, reason: { kind: 'completed' } })
  }

  for (const turn of turns) {
    openTurn()
    for (const row of turn.items) {
      if (row.type === 'user') {
        const text = textOf(row.data)
        if (text.trim() === '') {
          stats.skippedBlocks['empty-user-text'] = (stats.skippedBlocks['empty-user-text'] ?? 0) + 1
          continue
        }
        // 真实 DSH 里「用户提问 + 首个助手回复」同属一个 step；只有当这一步
        // 已经产出过助手消息时，下一条用户消息才开新 step。
        if (stepOpen && stepHasAssistant) closeStep()
        if (!stepOpen) openStep()
        push(
          'user/message',
          {
            id: String(row.id || `oc-user-${events.length}`),
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: trimBlock(text, maxToolResultChars) }],
          },
          { surfaceOp: 'append' },
          row.createdAt,
        )
        stats.userMessages += 1
        sourceRowIds.push(String(row.id))
        continue
      }

      // assistant 行 → 一个 step 内的 assistant/message（+ 其工具调用）
      const content = Array.isArray(row.data?.content) ? row.data.content : []
      const blocks = []
      const toolBlocks = []
      for (const block of content) {
        if (block?.type === 'reasoning') {
          const text = textOf(block)
          if (text.trim() === '') continue
          if (!includeReasoning) {
            stats.skippedBlocks.reasoning = (stats.skippedBlocks.reasoning ?? 0) + 1
            continue
          }
          blocks.push({ type: 'reasoning', text: trimBlock(text, maxToolResultChars) })
          stats.reasoningBlocks += 1
          continue
        }
        if (block?.type === 'text') {
          const text = textOf(block)
          if (text.trim() === '') continue
          blocks.push({ type: 'text', text: trimBlock(text, maxToolResultChars) })
          stats.textBlocks += 1
          continue
        }
        if (block?.type === 'tool') {
          if (!includeToolCalls) {
            stats.skippedBlocks.tool = (stats.skippedBlocks.tool ?? 0) + 1
            continue
          }
          const callId = uniqueCallId(block.id, toolBlocks.length)
          const name = sanitizeToolName(block.name)
          const input = block.state?.input
          let args
          try {
            args = JSON.stringify(input === undefined ? {} : input)
          } catch {
            args = '{}'
          }
          blocks.push({ type: 'tool-call', id: callId, name, arguments: args })
          toolBlocks.push({ callId, name, args, state: block.state ?? {}, source: block })
          continue
        }
        const kind = String(block?.type ?? 'unknown')
        stats.skippedBlocks[kind] = (stats.skippedBlocks[kind] ?? 0) + 1
      }

      if (blocks.length === 0) {
        stats.skippedBlocks['empty-assistant-row'] = (stats.skippedBlocks['empty-assistant-row'] ?? 0) + 1
        continue
      }

      if (stepOpen && stepHasAssistant) closeStep()
      if (!stepOpen) openStep()
      stepHasAssistant = true

      const { provider, model } = modelPair(row.data?.model, session.model, null)
      const time = numberOrUndefined(row.createdAt) ?? nextTime()
      const stream = []
      blocks.forEach((block, index) => {
        stream.push({ type: 'chunk', time, chunk: { type: 'block-start', index, blockType: block.type } })
        stream.push({ type: 'chunk', time, chunk: { type: 'block-end', index, block: block } })
      })
      stream.push({
        type: 'chunk',
        time,
        chunk: { type: 'finish', reason: { kind: toolBlocks.length > 0 ? 'tool-calls' : 'stop' } },
      })
      const assistantData = {
        turn: turnNumber,
        step: stepNumber,
        message: {
          id: String(row.id || `oc-assistant-${events.length}`),
          role: 'assistant',
          source: { kind: 'model', provider, model },
          content: blocks,
        },
        stream,
      }
      const usage = toUsage(row.data?.tokens)
      if (usage !== undefined) assistantData.usage = usage
      if (row.data?.error !== undefined && row.data?.error !== null) {
        assistantData.interrupted = true
      }
      push('assistant/message', assistantData, { surfaceOp: 'append' }, time)
      stats.assistantMessages += 1
      sourceRowIds.push(String(row.id))

      let toolIndex = 0
      for (const tool of toolBlocks) {
        const callTime = numberOrUndefined(tool.state.time?.created) ?? time + toolIndex * 2 + 1
        const resultTime = numberOrUndefined(tool.state.time?.completed) ?? callTime + 1
        push(
          'tool/call',
          { turn: turnNumber, step: stepNumber, callId: tool.callId, name: tool.name, arguments: tool.args },
          {},
          callTime,
        )
        const callSeq = events.length - 1
        const isError = tool.state.status === 'error'
        const resultContent = []
        if (isError) {
          const message = typeof tool.state.error?.message === 'string' ? tool.state.error.message : '未知错误'
          resultContent.push({ type: 'text', text: trimBlock(`[OpenCode 工具错误] ${message}`, maxToolResultChars) })
          stats.toolErrors += 1
        } else {
          const parts = Array.isArray(tool.state.content) ? tool.state.content : []
          for (const part of parts) {
            if (part?.type !== 'text') continue
            const text = textOf(part)
            if (text === '') continue
            const trimmed = trimBlock(text, maxToolResultChars)
            if (trimmed.length !== text.length) stats.truncatedToolResults += 1
            resultContent.push({ type: 'text', text: trimmed })
          }
        }
        const resultData = {
          turn: turnNumber,
          step: stepNumber,
          message: {
            id: `${String(row.id || `oc-${events.length}`)}:tool:${toolIndex}`,
            role: 'tool',
            source: { kind: 'tool', callId: tool.callId },
            toolCallId: tool.callId,
            content: resultContent,
          },
        }
        if (isError) {
          resultData.message.isError = true
          resultData.error = {
            name: 'OpenCodeToolError',
            code: typeof tool.state.error?.type === 'string' ? tool.state.error.type : 'unknown',
            reason: typeof tool.state.error?.message === 'string' ? tool.state.error.message.slice(0, 2000) : undefined,
          }
        }
        push('tool/result', resultData, { surfaceOp: 'append', sourceEventSeqs: [callSeq] }, resultTime)
        stats.toolCalls += 1
        toolIndex += 1
      }
    }
    closeTurn()
  }

  stats.events = events.length
  return { events, stats, sourceRowIds }
}

/** 会话在 DSH 里的标题（带可选前缀）。 */
function planTitle(session, options) {
  const prefix = typeof options.titlePrefix === 'string' ? options.titlePrefix : ''
  const raw = typeof session.title === 'string' && session.title.trim() !== ''
    ? session.title.trim()
    : `OpenCode 会话 ${session.id.slice(-8)}`
  return `${prefix}${raw}`.slice(0, 200)
}

/**
 * 首次导入：核心事件 + header，末尾补一条用户指定的标题事件。
 *
 * @returns {{header: object, events: object[], stats: object, warnings: string[], sourceRowIds: string[]}}
 */
export function buildSessionPlan({ session, rows, options = {} }) {
  const warnings = []
  const cwd = normalizeCwd(session.directory)
  if (cwd === null && typeof session.directory === 'string' && session.directory.trim() !== '') {
    warnings.push(`目录不是绝对路径，已省略 cwd：${session.directory}`)
  }

  const createdAt = Number.isFinite(session.createdAt) && session.createdAt > 0 ? session.createdAt : Date.now()
  const header = {
    version: 4,
    id: dshSessionIdFor(session.id),
    createdAt,
    isSeeded: false,
    delegationDepth: 0,
  }
  if (cwd !== null) header.cwd = cwd
  if (typeof options.agentPreset === 'string' && options.agentPreset !== '') header.agentPreset = options.agentPreset

  const core = buildEventCore({ session, rows, options })
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const lastTime = core.events.length > 0 ? core.events[core.events.length - 1].time : createdAt
  core.events.push({
    type: 'session/title',
    seq: core.events.length > 0 ? core.events[core.events.length - 1].seq + 1 : 0,
    time: Math.max(lastTime, now),
    data: { title: planTitle(session, options), messageSeqs: [], source: { kind: 'user' } },
  })
  core.stats.events = core.events.length
  return { header, events: core.events, stats: core.stats, warnings, sourceRowIds: core.sourceRowIds }
}

/**
 * 增量追加：只把新增的正文行展开成事件，seq 与 turn 号接在既有日志之后。
 * 标题变化时才追加新的 `session/title`。
 *
 * @param {object} input
 * @param {string} [input.options.currentTitle] 既有日志里的标题；相同则不重复追加
 * @returns {{events: object[], stats: object, sourceRowIds: string[], titleChanged: boolean}}
 */
export function buildAppendPlan({ session, rows, options = {} }) {
  const core = buildEventCore({ session, rows, options })
  const title = planTitle(session, options)
  const currentTitle = typeof options.currentTitle === 'string' ? options.currentTitle : null
  const titleChanged = core.events.length > 0 && title !== currentTitle
  if (titleChanged) {
    const last = core.events[core.events.length - 1]
    core.events.push({
      type: 'session/title',
      seq: last.seq + 1,
      time: Math.max(last.time, Number.isFinite(options.now) ? Number(options.now) : Date.now()),
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    })
  }
  core.stats.events = core.events.length
  return { events: core.events, stats: core.stats, sourceRowIds: core.sourceRowIds, titleChanged }
}
