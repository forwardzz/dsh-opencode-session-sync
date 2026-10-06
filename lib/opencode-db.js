// OpenCode 桌面端本地存储读取层（只读）。
//
// OpenCode 把会话放在单个 SQLite 库里：
//   Windows : %USERPROFILE%\.local\share\opencode\opencode.db
//   其它    : ~/.local/share/opencode/opencode.db
//
// 两张表都可能承载正文：
//   session_message —— 当前格式（type=user/assistant/idle/system/synthetic/compaction/...）
//   message + part  —— 旧格式（迁移前的存储）
// 本模块只读不写，且优先使用 session_message；旧格式仅在 session_message 为空时
// 被识别为「legacy-only」并向上报告（不猜测其结构）。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认的 OpenCode 数据库位置。 */
export function defaultDbPath() {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

/** 解析配置里的数据库路径（支持 ~ 前缀）。 */
export function resolveDbPath(configured) {
  if (typeof configured !== 'string' || configured.trim() === '') return defaultDbPath()
  const raw = configured.trim()
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/**
 * OpenCode 只读存储句柄。
 *
 * 首次打开优先用 `readOnly: true`；若 WAL 侧无法只读打开（-shm 缺失等），
 * 退化为可写句柄但本模块从不执行写语句。
 */
export class OpenCodeStore {
  #db
  #tables
  #messageTable
  #sessionTable

  constructor(dbPath) {
    if (!existsSync(dbPath)) {
      throw new Error(`找不到 OpenCode 数据库：${dbPath}`)
    }
    this.path = dbPath
    this.#db = openDatabase(dbPath)
    this.#tables = new Set(
      this.#db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all()
        .map((row) => String(row.name)),
    )
    this.#sessionTable = this.#tables.has('session_v2') ? 'session_v2' : this.#tables.has('session') ? 'session' : null
    this.#messageTable = this.#tables.has('session_message') ? 'session_message' : null
    if (this.#sessionTable === null) {
      throw new Error(`${dbPath} 里没有 session/session_v2 表，可能不是 OpenCode 数据库`)
    }
  }

  get hasNewMessageTable() {
    return this.#messageTable !== null
  }

  get hasLegacyTables() {
    return this.#tables.has('message') && this.#tables.has('part')
  }

  /** 全部会话（按创建时间升序），已解析 model JSON。 */
  listSessions() {
    const rows = this.#db
      .prepare(
        `SELECT id, project_id, parent_id, directory, title, agent, model,
                time_created, time_updated, time_archived, cost, tokens_input, tokens_output
         FROM ${this.#sessionTable}
         ORDER BY time_created`,
      )
      .all()
    return rows.map((row) => ({
      id: String(row.id),
      projectId: row.project_id ?? null,
      parentId: row.parent_id ?? null,
      directory: typeof row.directory === 'string' ? row.directory : null,
      title: typeof row.title === 'string' ? row.title : null,
      agent: row.agent ?? null,
      model: parseJson(row.model, null),
      createdAt: Number(row.time_created ?? 0),
      updatedAt: Number(row.time_updated ?? 0),
      archivedAt: row.time_archived === null || row.time_archived === undefined ? null : Number(row.time_archived),
      cost: typeof row.cost === 'number' ? row.cost : null,
      tokensInput: typeof row.tokens_input === 'number' ? row.tokens_input : null,
      tokensOutput: typeof row.tokens_output === 'number' ? row.tokens_output : null,
    }))
  }

  /**
   * 一个会话的正文行（新格式），按 (time_created, seq) 升序。
   * @returns {{rows: object[], source: 'session_message'|'legacy-only'|'empty'}}
   */
  listMessages(sessionId) {
    if (this.#messageTable !== null) {
      const rows = this.#db
        .prepare(
          `SELECT id, type, seq, time_created, time_updated, data
           FROM ${this.#messageTable}
           WHERE session_id = ?
           ORDER BY time_created, seq`,
        )
        .all(sessionId)
        .map((row) => ({
          id: String(row.id),
          type: String(row.type),
          seq: Number(row.seq ?? 0),
          createdAt: Number(row.time_created ?? 0),
          updatedAt: Number(row.time_updated ?? 0),
          data: parseJson(row.data, {}),
        }))
      if (rows.length > 0) return { rows, source: 'session_message' }
      if (this.hasLegacyTables && this.#legacyCount(sessionId) > 0) return { rows: [], source: 'legacy-only' }
      return { rows: [], source: 'empty' }
    }
    if (this.hasLegacyTables && this.#legacyCount(sessionId) > 0) return { rows: [], source: 'legacy-only' }
    return { rows: [], source: 'empty' }
  }

  #legacyCount(sessionId) {
    try {
      const row = this.#db.prepare('SELECT COUNT(*) AS c FROM message WHERE session_id = ?').get(sessionId)
      return Number(row?.c ?? 0)
    } catch {
      return 0
    }
  }

  close() {
    try {
      this.#db.close()
    } catch {
      /* 关闭失败不影响调用方 */
    }
  }
}

function openDatabase(dbPath) {
  if (sqliteModule === undefined) {
    throw new Error('node:sqlite 尚未加载：请先 await primeSqlite() 或用 openStore() 打开')
  }
  const { DatabaseSync } = sqliteModule
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    // WAL 侧无法只读打开时退化；本模块不会执行任何写语句。
    try {
      return new DatabaseSync(dbPath)
    } catch {
      throw error
    }
  }
}

// node:sqlite 只在 ESM 里异步可用；缓存一次之后 OpenCodeStore 就能同步构造。
let sqliteModule

/** 加载并缓存 node:sqlite。所有打开存储的入口都会先调用它。 */
export async function primeSqlite() {
  if (sqliteModule === undefined) {
    sqliteModule = await import('node:sqlite')
    if (typeof sqliteModule.DatabaseSync !== 'function') {
      sqliteModule = undefined
      throw new Error('当前运行时的 node:sqlite 没有 DatabaseSync（需要 Node 22.5+）')
    }
  }
  return sqliteModule
}

/** 打开一个只读存储；调用方负责 close()。 */
export async function openStore(configuredPath) {
  await primeSqlite()
  return new OpenCodeStore(resolveDbPath(configuredPath))
}
