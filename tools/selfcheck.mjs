#!/usr/bin/env node
// 离线自检：不启动 DSH，直接把真实的 OpenCode 库转成 DSH V4 事件并校验。
//
//   node tools/selfcheck.mjs                 # 盘点 + 转换 + 结构校验
//   node tools/selfcheck.mjs --limit 3       # 只处理最近 3 个会话
//   node tools/selfcheck.mjs --all           # 含子会话
//   node tools/selfcheck.mjs --e2e <dir>     # 再用解压出来的真实 DSH 持久化层
//                                            # 写进临时目录并读回（端到端证据）
//   node tools/selfcheck.mjs --db <路径>     # 指定 OpenCode 数据库
//
// 退出码：0 通过 / 1 发现问题 / 2 环境不满足（例如本机没有 OpenCode 库）。
// 校验规则见 lib/validate.js。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { openStore, resolveDbPath } from '../lib/opencode-db.js'
import { buildSessionPlan } from '../lib/convert.js'
import { DEFAULTS, normalizeConfig } from '../lib/ledger.js'
import { validatePlan } from '../lib/validate.js'

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
const keepE2E = argv.includes('--keep-e2e')
const dbFlag = typeof flag('db', null) === 'string' ? String(flag('db')) : ''
const outDir = typeof flag('out', null) === 'string' ? String(flag('out')) : mkdtempSync(join(tmpdir(), 'oc-sync-selfcheck-'))

const config = normalizeConfig({ ...DEFAULTS, includeChildren, dbPath: dbFlag })

let store
try {
  store = await openStore(config.dbPath)
} catch (error) {
  console.error(`自检无法开始：${String(error?.message ?? error)}`)
  console.error(`提示：OpenCode 数据库默认在 ${resolveDbPath('')}；可用 --db <路径> 指定。`)
  process.exit(2)
}

const all = store.listSessions()
const selected = (includeChildren ? all : all.filter((s) => s.parentId === null || s.parentId === undefined))
  .slice()
  .sort((a, b) => b.updatedAt - a.updatedAt)
const targets = Number.isFinite(limit) && limit > 0 ? selected.slice(0, limit) : selected

const report = {
  dbPath: store.path,
  totalSessions: all.length,
  selectedSessions: targets.length,
  includeChildren,
  plans: [],
  problems: [],
  legacyOnly: [],
  noTranscript: [],
}
mkdirSync(outDir, { recursive: true })

const plans = []
for (const session of targets) {
  const { rows, source } = store.listMessages(session.id)
  if (rows.length === 0) {
    report[source === 'legacy-only' ? 'legacyOnly' : 'noTranscript'].push(session.id)
    continue
  }
  const plan = buildSessionPlan({
    session,
    rows,
    options: {
      titlePrefix: config.titlePrefix,
      agentPreset: config.agentPreset,
      maxToolResultChars: config.maxToolResultChars,
    },
  })
  report.problems.push(...validatePlan(plan))
  plans.push({ session, plan })
  report.plans.push({
    openCodeId: session.id,
    dshSessionId: plan.header.id,
    title: plan.events.at(-1)?.data?.title,
    cwd: plan.header.cwd ?? null,
    events: plan.events.length,
    ...plan.stats,
  })
  writeFileSync(join(outDir, `${session.id}.jsonl`), plan.events.map((event) => JSON.stringify(event)).join('\n'), 'utf8')
}
store.close()

let e2e = null
if (e2eDir !== null) {
  e2e = await runE2E(e2eDir, plans, keepE2E)
  report.problems.push(...e2e.problems)
}

report.outDir = outDir
writeFileSync(join(outDir, 'selfcheck-report.json'), `${JSON.stringify({ ...report, e2e }, null, 2)}\n`, 'utf8')

console.log(`OpenCode 库：${report.dbPath}`)
console.log(`会话总数 ${report.totalSessions}，本次转换 ${report.plans.length}（含子会话：${includeChildren}）`)
console.log(`事件总数 ${report.plans.reduce((sum, row) => sum + row.events, 0)}`)
if (report.legacyOnly.length > 0) console.log(`仅有旧格式正文（未解析）：${report.legacyOnly.length}`)
if (report.noTranscript.length > 0) console.log(`无正文：${report.noTranscript.length}`)
if (e2e !== null) {
  console.log(`端到端（真实 DSH 持久化层）：写入 ${e2e.written}，读回 ${e2e.readBack}，根目录 ${e2e.scratch}`)
}
console.log(report.problems.length === 0 ? '结构校验：全部通过 ✅' : `结构校验：发现 ${report.problems.length} 个问题 ❌`)
for (const problem of report.problems.slice(0, 30)) console.log(`  - ${problem}`)
console.log(`报告与每条会话的事件 JSONL：${outDir}`)
if (report.problems.length > 0) process.exitCode = 1

/** 用解压出来的真实 @deepseek-ai/dsh-session-persistence-jsonl 写盘并读回。 */
async function runE2E(root, planList, keep) {
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
  if (keep) console.log(`端到端临时根目录保留在：${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
  return { root, scratch, written, readBack, problems }
}
