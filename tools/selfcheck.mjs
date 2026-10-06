#!/usr/bin/env node
// 离线自检：不启动 DSH，直接把真实的 OpenCode 库转成 DSH V4 事件并校验。
//
//   node tools/selfcheck.mjs                 # 盘点 + 转换 + 本地结构校验
//   node tools/selfcheck.mjs --limit 3       # 只处理最近 3 个会话
//   node tools/selfcheck.mjs --all           # 含子会话
//   node tools/selfcheck.mjs --e2e <dir>     # 再用解压出来的真实 DSH 持久化层
//                                            # 写进临时目录并读回（端到端证据）
//
// 校验规则直接对应 DSH 会话格式 V4 的已发布约束（见 lib/convert.js 顶部注释）。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { openStore } from '../lib/opencode-db.js'
import { buildSessionPlan } from '../lib/convert.js'
import { DEFAULTS, normalizeConfig } from '../lib/ledger.js'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  if (at < 0) return fallback
  const next = argv[at + 1]
  return next === undefined || next.startsWith('--') ? true : next
}
const limit = flag('limit', null) === null ? null : Number(flag('limit'))
const includeChildren = argv.includes('--all')
const e2eDir = typeof flag('e2e', null) === 'string' ? String(flag('e2e')) : null
const outDir = typeof flag('out', null) === 'string' ? String(flag('out')) : mkdtempSync(join(tmpdir(), 'oc-sync-selfcheck-'))

const config = normalizeConfig({ ...DEFAULTS, includeChildren })

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const BLOCK_TYPES = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-addition', 'tool-removal'])

/** 逐事件做「信封 + 表面 + 内容」结构校验。 */
function checkEnvelope(plan, problems) {
  const id = plan.header.id
  let lastSeq = -1
  for (const event of plan.events) {
    const where = `${id} seq ${event.seq} ${event.type}`
    if (typeof event.type !== 'string' || event.type === '') problems.push(`${where}: 缺少 type`)
    if (event.seq !== lastSeq + 1) problems.push(`${where}: seq 不连续（上一条 ${lastSeq}）`)
    lastSeq = event.seq
    if (!Number.isSafeInteger(event.time) || event.time < 0) problems.push(`${where}: time 不是非负安全整数`)
    if (event.data === null || typeof event.data !== 'object') problems.push(`${where}: data 不是对象`)
    if (event.ignorable !== undefined) problems.push(`${where}: 不应带 ignorable`)
    if (SURFACE.has(event.type)) {
      if (event.surfaceOp !== 'append') problems.push(`${where}: 表面事件必须带 surfaceOp='append'`)
      if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
        problems.push(`${where}: assistant/message 不能带 sourceEventSeqs`)
      }
    } else if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
      if (event.type !== 'tool/result') problems.push(`${where}: 非表面事件不该带 surfaceOp/sourceEventSeqs`)
    }
    const content = event.type === 'user/message'
      ? event.data.content
      : event.data?.message?.content
    if (SURFACE.has(event.type)) {
      const message = event.type === 'user/message' ? event.data : event.data?.message
      if (typeof message?.id !== 'string' || message.id === '') problems.push(`${where}: 消息缺少非空 id`)
      if (typeof message?.source?.kind !== 'string' || message.source.kind === '') problems.push(`${where}: source.kind 无效`)
      if (!Array.isArray(content)) problems.push(`${where}: content 不是数组`)
      for (const block of Array.isArray(content) ? content : []) {
        if (!BLOCK_TYPES.has(block?.type)) problems.push(`${where}: 未知内容块类型 ${String(block?.type)}`)
      }
      if (event.type === 'assistant/message') {
        const source = message.source
        if (source.kind !== 'model' || typeof source.provider !== 'string' || source.provider === '' ||
            typeof source.model !== 'string' || source.model === '') {
          problems.push(`${where}: assistant/message 的 source 必须是 model + provider/model`)
        }
        if (!Array.isArray(event.data.stream)) problems.push(`${where}: assistant/message 缺少 stream 数组`)
        for (const record of event.data.stream ?? []) {
          if (record?.type === 'chunk' && record.chunk?.type === 'block-start' && !BLOCK_TYPES.has(record.chunk.blockType)) {
            problems.push(`${where}: stream 里出现未知 blockType ${String(record.chunk.blockType)}`)
          }
        }
      }
      if (event.type === 'tool/result') {
        const source = message.source
        if (source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
          problems.push(`${where}: tool/result 的 source 必须是 tool + callId`)
        }
        if (message.toolCallId !== source.callId) problems.push(`${where}: toolCallId 与 callId 不一致`)
        if (event.data.error !== undefined && message.isError !== true) problems.push(`${where}: 有 error 却没有 isError`)
      }
    }
  }
  if (!Number.isSafeInteger(plan.header.createdAt) || plan.header.createdAt < 0) {
    problems.push(`${id}: header.createdAt 无效`)
  }
  if (plan.header.version !== 4) problems.push(`${id}: header.version 必须是 4`)
  if (plan.header.isSeeded !== false) problems.push(`${id}: header.isSeeded 必须是 false`)
  if (plan.header.cwd !== undefined && !/^([A-Za-z]:\\|\\\\|\/)/.test(plan.header.cwd)) {
    problems.push(`${id}: header.cwd 不是绝对路径：${plan.header.cwd}`)
  }
}

/** DSH 的跨事件关系约束（对应 dsh-session/invariant 的同一套规则）。 */
function checkRelationships(plan, problems) {
  const id = plan.header.id
  let openTurn = null
  let openStep = null
  let nextTurn = 1
  let nextStep = 1
  let pending = new Set()
  for (const event of plan.events) {
    const where = `${id} seq ${event.seq} ${event.type}`
    const d = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        if (openTurn !== null) problems.push(`${where}: turn ${openTurn} 还开着`)
        if (d.turn !== nextTurn) problems.push(`${where}: turn 编号应为 ${nextTurn}`)
        openTurn = d.turn
        nextStep = 1
        break
      case 'turn/end':
        if (openTurn !== d.turn) problems.push(`${where}: 与打开的 turn 不匹配`)
        if (openStep !== null) problems.push(`${where}: step 还开着`)
        openTurn = null
        nextTurn += 1
        break
      case 'step/start':
        if (openTurn !== d.turn) problems.push(`${where}: 不在打开的 turn 内`)
        if (openStep !== null) problems.push(`${where}: 上一个 step 还开着`)
        if (d.step !== nextStep) problems.push(`${where}: step 编号应为 ${nextStep}`)
        openStep = d.step
        break
      case 'step/end':
        if (openTurn !== d.turn || openStep !== d.step) problems.push(`${where}: 与打开的 turn/step 不匹配`)
        openStep = null
        nextStep += 1
        pending = new Set()
        break
      case 'user/message':
        break
      case 'assistant/message':
        if (openTurn !== d.turn || openStep !== d.step) problems.push(`${where}: 需要打开的 turn/step`)
        break
      case 'tool/call':
        if (openTurn !== d.turn || openStep !== d.step) problems.push(`${where}: 需要打开的 turn/step`)
        pending.add(d.callId)
        break
      case 'tool/result': {
        if (openTurn !== d.turn || openStep !== d.step) problems.push(`${where}: 需要打开的 turn/step`)
        const callId = d.message?.source?.callId
        if (!pending.has(callId)) problems.push(`${where}: 同一 step 内没有对应的 tool/call`)
        pending.delete(callId)
        if (Array.isArray(event.sourceEventSeqs)) {
          for (const seq of event.sourceEventSeqs) {
            if (!(seq < event.seq)) problems.push(`${where}: sourceEventSeqs 必须引用更早的事件`)
          }
        }
        break
      }
      case 'session/title':
        if (typeof d.title !== 'string' || d.title === '') problems.push(`${where}: 标题为空`)
        if (!Array.isArray(d.messageSeqs)) problems.push(`${where}: messageSeqs 必须是数组`)
        if (typeof d.source?.kind !== 'string' || d.source.kind === '') problems.push(`${where}: 标题缺少 source`)
        break
      default:
        break
    }
  }
  if (openTurn !== null) problems.push(`${id}: 结束时 turn ${openTurn} 仍开着`)
  if (openStep !== null) problems.push(`${id}: 结束时 step ${openStep} 仍开着`)
  if (pending.size > 0) problems.push(`${id}: 有未结算的 tool/call：${[...pending].join(',')}`)
}

const store = await openStore(config.dbPath)
const all = store.listSessions()
const selected = (includeChildren ? all : all.filter((s) => s.parentId === null || s.parentId === undefined))
  .slice()
  .sort((a, b) => b.updatedAt - a.updatedAt)
const limited = Number.isFinite(limit) && limit > 0 ? selected.slice(0, limit) : selected

const report = {
  dbPath: store.path,
  totalSessions: all.length,
  selectedSessions: limited.length,
  includeChildren,
  plans: [],
  problems: [],
  legacyOnly: [],
  noTranscript: [],
}
mkdirSync(outDir, { recursive: true })

const plans = []
for (const session of limited) {
  const { rows, source } = store.listMessages(session.id)
  if (rows.length === 0) {
    report[source === 'legacy-only' ? 'legacyOnly' : 'noTranscript'].push(session.id)
    continue
  }
  const plan = buildSessionPlan({ session, rows, options: { titlePrefix: config.titlePrefix, agentPreset: config.agentPreset, maxToolResultChars: config.maxToolResultChars } })
  checkEnvelope(plan, report.problems)
  checkRelationships(plan, report.problems)
  plans.push({ session, plan })
  report.plans.push({
    openCodeId: session.id,
    dshSessionId: plan.header.id,
    title: plan.events.at(-1)?.data?.title,
    cwd: plan.header.cwd ?? null,
    events: plan.events.length,
    ...plan.stats,
  })
  writeFileSync(join(outDir, `${session.id}.jsonl`), plan.events.map((e) => JSON.stringify(e)).join('\n'), 'utf8')
}
store.close()

let e2e = null
if (e2eDir !== null) {
  e2e = await runE2E(e2eDir, plans)
  if (e2e.problems.length > 0) report.problems.push(...e2e.problems)
}

report.outDir = outDir
writeFileSync(join(outDir, 'selfcheck-report.json'), `${JSON.stringify({ ...report, e2e }, null, 2)}\n`, 'utf8')

console.log(`OpenCode 库：${report.dbPath}`)
console.log(`会话总数 ${report.totalSessions}，本次转换 ${report.plans.length}（含子会话：${includeChildren}）`)
console.log(`事件总数 ${report.plans.reduce((sum, row) => sum + row.events, 0)}`)
if (report.legacyOnly.length > 0) console.log(`仅有旧格式正文（未解析）：${report.legacyOnly.length}`)
if (report.noTranscript.length > 0) console.log(`无正文：${report.noTranscript.length}`)
if (e2e !== null) {
  console.log(`端到端（真实 DSH 持久化层）：写入 ${e2e.written}，读回 ${e2e.readBack}，根目录 ${e2e.root}`)
}
console.log(report.problems.length === 0 ? '结构校验：全部通过 ✅' : `结构校验：发现 ${report.problems.length} 个问题 ❌`)
for (const problem of report.problems.slice(0, 30)) console.log(`  - ${problem}`)
console.log(`报告与每条会话的事件 JSONL：${outDir}`)
if (report.problems.length > 0) process.exitCode = 1

/** 用解压出来的真实 @deepseek-ai/dsh-session-persistence-jsonl 写盘并读回。 */
async function runE2E(root, planList) {
  const scratch = mkdtempSync(join(tmpdir(), 'oc-sync-e2e-'))
  const { Context } = await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
  const persistenceModule = await import(
    pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href
  )
  const ctx = new Context()
  const fork = ctx.plugin(persistenceModule.default, { root: scratch, compression: 'zstd' })
  await fork.await()
  const persistence = ctx.get('sessionPersistence')
  const problems = []
  let written = 0
  let readBack = 0
  for (const { plan } of planList) {
    try {
      const handle = await persistence.create(plan.header)
      await handle.append(plan.events)
      await handle.flush()
      await handle.close()
      written += 1
    } catch (error) {
      problems.push(`${plan.header.id}: 真实 DSH 写入失败 ${String(error?.message ?? error)}`)
      continue
    }
    try {
      const reader = await persistence.open(plan.header.id, 'read')
      const result = await reader.read(0, 1_000_000)
      await reader.close()
      readBack += result.events.length
      if (result.events.length !== plan.events.length) {
        problems.push(`${plan.header.id}: 读回事件数 ${result.events.length} ≠ 写入 ${plan.events.length}`)
      }
    } catch (error) {
      problems.push(`${plan.header.id}: 真实 DSH 读回失败 ${String(error?.message ?? error)}`)
    }
  }
  await ctx.stop?.()
  rmSync(scratch, { recursive: true, force: true })
  return { root, written, readBack, problems }
}
