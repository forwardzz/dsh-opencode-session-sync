// 增量同步的真实验证：造一个可增长的合成 opencode.db（用真实表结构），
// 然后驱动 runSync 走完「首次导入 → 源会话增长 → 追加 → 无变化 → 源回退」全流程。
//
//   node test/incremental.mjs <解压出来的 dsh 目录>
//
// 为什么要合成库：真实 OpenCode 库在测试期间不会增长，无法验证「追加」这条路径。
// 这里用 node:sqlite 建同样的 session_v2 / session_message 表，写入同样形状的 data JSON，
// 因此被验证的仍然是插件真实的读取与转换链路。

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validatePlan } from '../lib/validate.js'
import { dshSessionIdFor } from '../lib/convert.js'

const dshDir = process.argv[2]
if (!dshDir || !existsSync(dshDir)) {
  console.error('用法：node test/incremental.mjs <解压出来的 dsh 目录>')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'oc-sync-inc-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'oc-sync-inc-store-'))
process.env.USERPROFILE = home
process.env.HOME = home

const dbPath = join(home, 'opencode.db')
const OC_SESSION = 'ses_incremental_0001'
const CWD = 'C:/Users/me/project'
const T0 = 1791300000000
let clock = T0
let seq = 0

// ---------------------------------------------------------------- 合成源库
const db = new DatabaseSync(dbPath)
db.exec(`
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT,
  slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT,
  metadata TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
  tokens_cache_read INTEGER, tokens_cache_write INTEGER, revert TEXT, permission TEXT, agent TEXT,
  model TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER
);
CREATE TABLE session_message (
  id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
  time_created INTEGER, time_updated INTEGER, data TEXT
);
`)
db.prepare(
  `INSERT INTO session_v2 (id, parent_id, directory, title, agent, model, time_created, time_updated, tokens_input, tokens_output, cost)
   VALUES (?, NULL, ?, ?, 'build', ?, ?, ?, 0, 0, 0)`,
).run(OC_SESSION, CWD, '增量同步测试', JSON.stringify({ id: 'deepseek-v4.1-flash', providerID: 'opencode-go' }), T0, T0)

const insertRow = db.prepare(
  'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
)
const addRow = (id, type, data, at) => {
  seq += 1
  insertRow.run(id, OC_SESSION, type, seq, at, at, JSON.stringify(data))
  clock = Math.max(clock, at)
}

/** 追加一整轮：用户消息 + 助手回复 + idle 收尾（与真实 OpenCode 的形状一致）。 */
function addTurn(index, userText, assistantText) {
  const t = T0 + index * 10_000
  addRow(`msg_user_${index}`, 'user', { text: userText, time: { created: t } }, t)
  addRow(
    `msg_assistant_${index}`,
    'assistant',
    {
      model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
      content: [{ type: 'text', text: assistantText }],
      tokens: { input: 10, output: 5, total: 15, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: t + 1000, completed: t + 2000 },
    },
    t + 1000,
  )
  addRow(`msg_idle_${index}`, 'idle', { time: { created: t + 3000 }, outcome: 'succeeded' }, t + 3000)
}

/** 模拟「在 OpenCode 里回退」：删掉最后一轮的行。 */
function dropTurn(index) {
  db.exec(`DELETE FROM session_message WHERE id IN ('msg_user_${index}', 'msg_assistant_${index}', 'msg_idle_${index}')`)
}

const setTitle = (title) => {
  db.prepare('UPDATE session_v2 SET title = ?, time_updated = ? WHERE id = ?').run(title, clock + 1, OC_SESSION)
}

// ---------------------------------------------------------------- 宿主与配置
const configFile = join(home, '.dsh', 'opencode-session-sync.json')
mkdirSync(join(home, '.dsh'), { recursive: true })
writeFileSync(
  configFile,
  JSON.stringify({ dbPath, autoSyncOnStart: false, importLimit: 10, titlePrefix: '[OC] ' }, null, 2),
  'utf8',
)

const { Context } = await import(pathToFileURL(join(dshDir, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
const persistencePlugin = await import(
  pathToFileURL(join(dshDir, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href
)
const ctx = new Context()
await ctx.plugin(persistencePlugin.default, { root: scratch, compression: 'zstd' }).await()
const persistence = ctx.get('sessionPersistence')

const { runSync } = await import('../lib/sync.js')

const coldSnapshots = []
const projections = {
  coldSnapshot(meta, inherited, events) {
    coldSnapshots.push({ id: meta.id, events: events.length })
    return { asOfSeq: events.length - 1, values: {} }
  },
}
const deps = { persistence, workspaces: null, projections }
const dshId = dshSessionIdFor(OC_SESSION)

async function readLog() {
  const handle = await persistence.open(dshId, 'read')
  try {
    const events = []
    let offset = 0
    for (;;) {
      const chunk = await handle.read(offset, 2000)
      const batch = chunk?.events ?? []
      events.push(...batch)
      if (batch.length < 2000) break
      offset += batch.length
    }
    return { header: handle.header, events }
  } finally {
    await handle.close()
  }
}

const userTexts = (log) =>
  log.events.filter((e) => e.type === 'user/message').map((e) => e.data.content.map((b) => b.text).join(''))
const turns = (log) => log.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)

// ---------------------------------------------------------------- 1) 首次导入
addTurn(1, '第一问', '第一答')
let report = await runSync(deps, {})
assert.equal(report.failed, 0, JSON.stringify(report.sessions))
assert.equal(report.imported, 1, '第一轮应新导入')
assert.equal(report.appended, 0)
let log = await readLog()
const afterFirst = log.events.length
assert.deepEqual(userTexts(log), ['第一问'])
assert.deepEqual(turns(log), [1])
assert.deepEqual(validatePlan(log), [], '首次导入后的完整日志应通过校验')
assert.equal(coldSnapshots.at(-1).events, afterFirst, '投影缓存应收到完整日志')
console.log(`1) 首次导入：${afterFirst} 个事件，turn=${JSON.stringify(turns(log))}`)

// ---------------------------------------------------------------- 2) 无变化
report = await runSync(deps, {})
assert.equal(report.imported, 0)
assert.equal(report.appended, 0)
assert.equal(report.upToDate, 1, '源没变时应判定已同步')
assert.equal((await readLog()).events.length, afterFirst, '不应写入任何事件')
console.log('2) 无变化：upToDate=1，事件数不变')

// ---------------------------------------------------------------- 3) 源增长 → 追加
addTurn(2, '第二问', '第二答')
addTurn(3, '第三问', '第三答')
report = await runSync(deps, {})
assert.equal(report.failed, 0, JSON.stringify(report.sessions))
assert.equal(report.imported, 0, '已有会话不应重复导入')
assert.equal(report.appended, 1, '应走追加路径')
log = await readLog()
const afterAppend = log.events.length
assert.ok(afterAppend > afterFirst, '追加后事件数应增加')
assert.deepEqual(userTexts(log), ['第一问', '第二问', '第三问'], '三条用户消息应都在，且顺序正确')
assert.deepEqual(turns(log), [1, 2, 3], 'turn 号应接在既有日志之后')
assert.deepEqual(log.events.map((e) => e.seq), log.events.map((_, i) => i), 'seq 应整体连续')
assert.deepEqual(validatePlan(log), [], '追加后的完整日志应通过校验')
assert.equal(coldSnapshots.at(-1).events, afterAppend, '追加后投影缓存应收到完整日志')
console.log(`3) 源增长：追加到 ${afterAppend} 个事件，turn=${JSON.stringify(turns(log))}`)

// 追加的那一段要「接得上」：seq 与 turn 号都延续既有日志，并以 turn/end 收尾
const appendedOnly = log.events.slice(afterFirst)
assert.equal(appendedOnly[0].seq, afterFirst, '追加段的第一条 seq 应接在既有日志之后')
assert.equal(appendedOnly.find((e) => e.type === 'turn/start').data.turn, 2, '第一轮追加应从 turn 2 开始')
assert.equal(appendedOnly.at(-1).type, 'turn/end', '追加段应以 turn/end 收尾')
assert.deepEqual(
  appendedOnly.filter((e) => e.type === 'tool/result').map((e) => e.data.message.toolCallId),
  appendedOnly.filter((e) => e.type === 'tool/call').map((e) => e.data.callId),
  '追加段内的工具调用应各自结算',
)

// ---------------------------------------------------------------- 4) dry-run
addTurn(4, '第四问', '第四答')
report = await runSync(deps, { dryRun: true })
assert.equal(report.imported, 0)
assert.equal(report.appended, 0, 'dry-run 不应写盘')
const planned = report.sessions.find((row) => row.status === 'planned')
assert.ok(planned, 'dry-run 应给出 planned 计划')
assert.ok(planned.events > 0)
assert.equal((await readLog()).events.length, afterAppend, 'dry-run 后事件数不变')
console.log(`4) dry-run：计划追加 ${planned.events} 个事件，未写盘`)

// ---------------------------------------------------------------- 5) 标题变化
setTitle('增量同步测试（改名）')
report = await runSync(deps, {})
assert.equal(report.appended, 1, '改名也应触发一次追加（补一条 session/title）')
log = await readLog()
const titleEvents = log.events.filter((e) => e.type === 'session/title')
assert.equal(titleEvents.length, 2, '应有两处标题事件')
assert.equal(titleEvents.at(-1).data.title, '[OC] 增量同步测试（改名）')
assert.deepEqual(validatePlan(log), [], '改名后的完整日志应通过校验')
const afterRename = log.events.length
console.log(`5) 标题变化：标题事件 ${titleEvents.length} 条，事件数 ${afterRename}`)

// ---------------------------------------------------------------- 6) 源回退 → 拒绝追加
dropTurn(4)
db.prepare('UPDATE session_v2 SET title = ? WHERE id = ?').run('增量同步测试', OC_SESSION)
report = await runSync(deps, {})
assert.equal(report.diverged, 1, '源回退应被判定为 diverged')
assert.equal(report.appended, 0, '回退时不应追加')
const diverged = report.sessions.find((row) => row.status === 'diverged')
assert.match(diverged.reason, /回退或改写/)
assert.equal((await readLog()).events.length, afterRename, '回退后不应写入任何事件')
console.log(`6) 源回退：diverged=1，未写入；理由：${diverged.reason}`)

await ctx.stop?.()
db.close()
rmSync(home, { recursive: true, force: true })
rmSync(scratch, { recursive: true, force: true })
console.log('增量同步测试通过 ✅')
process.exit(0)
