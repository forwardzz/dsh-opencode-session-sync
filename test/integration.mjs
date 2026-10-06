// 插件集成测试：用真实的 DSH 会话持久化层跑一遍 runSync 全流程。
//
//   node test/integration.mjs <解压出来的 dsh 目录>
//
// 覆盖：配置默认值落盘 → 读取 OpenCode 库 → 转换 → 真实写入 → stat 幂等 →
//       工作区登记分支 → 账本与报告落盘。
// HOME/USERPROFILE 被指向临时目录，不会碰到用户真实账本。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshDir = process.argv[2]
if (!dshDir || !existsSync(dshDir)) {
  console.error('用法：node test/integration.mjs <解压出来的 dsh 目录>')
  process.exit(2)
}

const realHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
const realDbPath = process.argv[3] ?? join(realHome, '.local', 'share', 'opencode', 'opencode.db')
const home = mkdtempSync(join(tmpdir(), 'oc-sync-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'oc-sync-store-'))
process.env.USERPROFILE = home
process.env.HOME = home

const configFile = join(home, '.dsh', 'opencode-session-sync.json')
mkdirSync(join(home, '.dsh'), { recursive: true })
writeFileSync(
  configFile,
  JSON.stringify(
    {
      autoSyncOnStart: false,
      importLimit: 3,
      titlePrefix: '[OC] ',
      dbPath: realDbPath,
    },
    null,
    2,
  ),
  'utf8',
)

const { Context } = await import(pathToFileURL(join(dshDir, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
const persistencePlugin = await import(
  pathToFileURL(join(dshDir, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href
)
const ctx = new Context()
await ctx.plugin(persistencePlugin.default, { root: scratch, compression: 'zstd' }).await()
const persistence = ctx.get('sessionPersistence')
assert.ok(persistence, 'sessionPersistence 未注册')

const { runSync, readStatus, summarizeSessions } = await import('../lib/sync.js')
const { loadConfig } = await import('../lib/ledger.js')

const config = loadConfig()
assert.equal(config.configFile, configFile)
assert.equal(config.importLimit, 3)

const attachments = []
const fakeWorkspaces = {
  list: () => [],
  create: async (path) => ({
    path,
    sessionIds: [],
    attachSession: async (id) => {
      attachments.push({ path, id })
    },
  }),
}

const summary = await summarizeSessions({ config, options: {} })
assert.ok(summary.total > 0, 'OpenCode 库应至少有一个会话')
console.log(`盘点：OpenCode 共 ${summary.total} 个会话，列出 ${summary.selected.length} 个`)

const first = await runSync({ persistence, workspaces: fakeWorkspaces, projections: null }, { limit: 2 })
assert.equal(first.ok, true, first.reason)
console.log(`第一次：导入 ${first.imported}、追加 ${first.appended}、已同步 ${first.upToDate}、跳过 ${first.skipped}、失败 ${first.failed}、事件 ${first.events}`)
assert.equal(first.failed, 0, JSON.stringify(first.sessions.filter((s) => s.status === 'failed'), null, 2))
assert.ok(first.imported > 0, '应至少导入一个会话')
assert.equal(first.workspace.created, first.imported, '每个新会话都应新建/登记工作区')

const buckets = readdirSync(scratch).filter((name) => name.startsWith('--'))
assert.ok(buckets.length > 0, '会话应落到按 cwd 命名的分桶目录')
console.log(`分桶目录：${buckets.join(' | ')}`)

const second = await runSync({ persistence, workspaces: fakeWorkspaces, projections: null }, { limit: 2 })
console.log(`第二次：导入 ${second.imported}、追加 ${second.appended}、已同步 ${second.upToDate}`)
assert.equal(second.imported, 0, '重复运行不应重复导入')
assert.equal(second.appended, 0, '源没有新增内容时不应追加')
assert.equal(second.upToDate, first.imported, '第二次应全部判定为已同步')

const dry = await runSync({ persistence, workspaces: fakeWorkspaces, projections: null }, { limit: 2, dryRun: true })
assert.equal(dry.imported, 0, 'dry-run 不应写盘')
assert.ok(dry.sessions.every((row) => row.status === 'up-to-date' || row.status === 'planned'))

const status = readStatus()
assert.equal(status.imported, first.imported)
assert.ok(status.lastRun !== null)
console.log(`账本：${status.imported} 个会话；最近一次：${JSON.stringify(status.lastRun)}`)

const stateRaw = JSON.parse(readFileSync(join(home, '.dsh', 'opencode-session-sync', 'state.json'), 'utf8'))
assert.equal(Object.keys(stateRaw.sessions).length, first.imported, '账本条目数应与导入数一致')

const attachedIds = new Set(attachments.map((row) => row.id))
for (const row of first.sessions.filter((item) => item.status === 'imported')) {
  assert.ok(attachedIds.has(row.dshSessionId), `会话 ${row.dshSessionId} 未登记进工作区`)
}

// 读回一个真实导入的会话，确认事件数一致
const sample = first.sessions.find((row) => row.status === 'imported')
const reader = await persistence.open(sample.dshSessionId, 'read')
const result = await reader.read(0, 10_000_000)
await reader.close()
assert.equal(result.events.length, sample.events, '读回事件数应与写入一致')
console.log(`读回校验：${sample.dshSessionId} → ${result.events.length} 个事件，前 6 个类型：${result.events.slice(0, 6).map((e) => e.type).join(',')}`)

await ctx.stop?.()
rmSync(home, { recursive: true, force: true })
rmSync(scratch, { recursive: true, force: true })
console.log('集成测试通过 ✅')
process.exit(0)
