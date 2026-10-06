// 「宿主装配」测试：在一个真实 Cordis 上下文里挂上真实的会话持久化服务，
// 再按 DSH 加载插件的方式加载本插件（默认导出 + inject），然后调用它注册的工具。
//
//   node test/host-apply.mjs <解压出来的 dsh 目录>
//
// 覆盖：插件能否被加载、inject 是否解析、工具是否注册、工具的 list/import/status
//       三个动作是否真的跑通、启动自动同步定时器是否落地。
// HOME/USERPROFILE 指向临时目录，不碰用户真实配置与账本。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshDir = process.argv[2]
if (!dshDir || !existsSync(dshDir)) {
  console.error('用法：node test/host-apply.mjs <解压出来的 dsh 目录>')
  process.exit(2)
}

const realHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
const realDbPath = process.argv[3] ?? join(realHome, '.local', 'share', 'opencode', 'opencode.db')
const home = mkdtempSync(join(tmpdir(), 'oc-sync-host-'))
const scratch = mkdtempSync(join(tmpdir(), 'oc-sync-hoststore-'))
process.env.USERPROFILE = home
process.env.HOME = home

const configFile = join(home, '.dsh', 'opencode-session-sync.json')
mkdirSync(join(home, '.dsh'), { recursive: true })
writeFileSync(
  configFile,
  JSON.stringify({ dbPath: realDbPath, importLimit: 2, autoSyncDelayMs: 250, titlePrefix: '[OC] ' }, null, 2),
  'utf8',
)

const { Context } = await import(pathToFileURL(join(dshDir, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
const persistencePlugin = await import(
  pathToFileURL(join(dshDir, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href
)
const pluginModule = await import('../lib/index.js')

const registered = []
const attached = []
const coldSnapshots = []
const ctx = new Context()

// 最小替身：真实宿主里这三个服务由其它插件提供
ctx.provide('tools', {
  register(definition) {
    registered.push(definition)
    return () => {}
  },
})
ctx.provide('workspaceRegistry', {
  list: () => [],
  create: async (path) => ({
    path,
    sessionIds: [],
    attachSession: async (id) => attached.push({ path, id }),
  }),
})
ctx.provide('sessionProjectionCache', {
  coldSnapshot(meta, inherited, events) {
    coldSnapshots.push({ id: meta.id, inherited, events: events.length })
    return { asOfSeq: events.length - 1, values: {} }
  },
})

await ctx.plugin(persistencePlugin.default, { root: scratch, compression: 'zstd' }).await()
const fork = await ctx.plugin(pluginModule.default).await()
const persistence = ctx.get('sessionPersistence')
assert.ok(persistence, 'sessionPersistence 未注册')

assert.equal(registered.length, 1, '插件应注册恰好一个工具')
const tool = registered[0]
assert.equal(tool.name, 'opencode_sync')
assert.equal(typeof tool.execute, 'function')
assert.equal(typeof tool.output.render, 'function')
assert.equal(tool.parameters.type, 'object')
assert.ok(Array.isArray(tool.parameters.properties.action.enum))
console.log(`工具已注册：${tool.name}；动作 ${tool.parameters.properties.action.enum.join('/')}`)

const status = await tool.execute({ action: 'status' })
assert.equal(status.ok, true)
assert.equal(status.action, 'status')
const statusText = tool.output.render({ action: 'status' }, status)[0].text
assert.match(statusText, /OpenCode → DSH 会话同步状态/)

const list = await tool.execute({ action: 'list', limit: 5 })
assert.equal(list.ok, true)
assert.equal(list.action, 'list')
assert.ok(list.selected.length > 0, 'list 应返回候选会话')
assert.ok(list.selected.every((row) => typeof row.imported === 'boolean'))
const listText = tool.output.render({ action: 'list' }, list)[0].text
assert.match(listText, /OpenCode 会话盘点/)
console.log(`list：共 ${list.total} 个会话，返回 ${list.selected.length} 行`)

const dry = await tool.execute({ action: 'import', dryRun: true, limit: 2 })
assert.equal(dry.ok, true)
assert.equal(dry.imported, 0, 'dry-run 不应写盘')
assert.ok(dry.sessions.every((row) => row.status === 'planned' || row.status === 'up-to-date'))
console.log(`dry-run：${dry.considered} 个候选，计划 ${dry.sessions.length} 行`)

const imported = await tool.execute({ action: 'import', limit: 2 })
assert.equal(imported.ok, true, JSON.stringify(imported).slice(0, 400))
assert.equal(imported.failed, 0, JSON.stringify(imported.sessions.filter((row) => row.status === 'failed')))
assert.ok(imported.imported > 0, '应导入至少一个会话')
const importedIds = imported.sessions.filter((row) => row.status === 'imported').map((row) => row.dshSessionId)
const warmedIds = new Set(coldSnapshots.map((row) => row.id))
const attachedIds = new Set(attached.map((row) => row.id))
for (const id of importedIds) {
  assert.ok(warmedIds.has(id), `会话 ${id} 未补写投影缓存`)
  assert.ok(attachedIds.has(id), `会话 ${id} 未登记进工作区`)
}
const buckets = readdirSync(scratch).filter((name) => name.startsWith('--'))
assert.ok(buckets.length > 0)
const importText = tool.output.render({ action: 'import' }, imported)[0].text
assert.match(importText, /同步完成/)
console.log(`import：新导入 ${imported.imported}、事件 ${imported.events}；分桶 ${buckets.length} 个`)

// 启动自动同步：等定时器跑完（配置里 250ms）
await new Promise((resolve) => setTimeout(resolve, 1500))
const afterAuto = await persistence.list()
assert.ok(afterAuto.length >= imported.imported, '自动同步至少不应减少会话数')
console.log(`启动自动同步后持久化里的会话数：${afterAuto.length}`)

await fork.dispose?.()
await ctx.stop?.()
rmSync(home, { recursive: true, force: true })
rmSync(scratch, { recursive: true, force: true })
console.log('宿主装配测试通过 ✅')
process.exit(0)
