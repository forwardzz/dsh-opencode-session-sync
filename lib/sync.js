// 同步编排层：把 OpenCode 会话按工作区写进 DSH 的会话持久化。
//
// 写入走 DSH 自己的 sessionPersistence（create → append → flush → close），
// 因此 V4 格式与跨事件关系校验由 DSH 本体负责，本插件不拼字节。
// 会话按 header.cwd 落到对应工作区分桶；随后再用 workspaceRegistry 把会话
// 登记进该工作区的 sessionIds，列表里立刻就对应上。

import { readFileSync, statSync } from 'node:fs'
import { openStore, resolveDbPath } from './opencode-db.js'
import { buildAppendPlan, buildSessionPlan, dshSessionIdFor, normalizeCwd } from './convert.js'
import { loadConfig, loadState, reportPath, saveReport, saveState, statePath } from './ledger.js'

function normPath(value) {
  return String(value ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function isDirectory(value) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function filterSessions(sessions, options, config) {
  const only = Array.isArray(options.sessionIds) && options.sessionIds.length > 0
    ? new Set(options.sessionIds.map((id) => String(id)))
    : null
  const workspace = typeof options.workspace === 'string' && options.workspace.trim() !== ''
    ? normPath(options.workspace)
    : null
  return sessions.filter((session) => {
    if (only !== null && !only.has(session.id)) return false
    if (!only && config.includeChildren !== true && session.parentId !== null && session.parentId !== undefined) return false
    if (workspace !== null) {
      const cwd = normalizeCwd(session.directory)
      if (cwd === null) return false
      if (!normPath(cwd).includes(workspace)) return false
    }
    return true
  })
}

/**
 * 列出候选会话（不构造事件、不写盘），供 `list` 动作与自检使用。
 *
 * @param {object} input
 * @param {(dshSessionId: string) => Promise<Set<string>|null>} [input.importedIdsFor]
 *        给定时会读回 DSH 侧日志，据此算出每个会话「还有多少条新内容」；
 *        返回 null 表示 DSH 里还没有这个会话。
 */
export async function summarizeSessions({ config, options = {}, importedIdsFor = null }) {
  if (typeof config.dbPath !== 'string' || config.dbPath.trim() === '') config.dbPath = resolveDbPath('')
  const store = await openStore(config.dbPath)
  try {
    const sessions = store.listSessions()
    const selected = filterSessions(sessions, options, config)
    const rows = []
    for (const session of selected) {
      const { rows: messages, source } = store.listMessages(session.id)
      const counts = {}
      for (const row of messages) counts[row.type] = (counts[row.type] ?? 0) + 1
      const importable = messages.filter((row) => row.type === 'user' || row.type === 'assistant')
      const dshSessionId = dshSessionIdFor(session.id)
      let importedIds = null
      if (importedIdsFor !== null) {
        try {
          importedIds = await importedIdsFor(dshSessionId)
        } catch {
          importedIds = null
        }
      }
      const pendingRows = importedIds === null
        ? importable.length
        : importable.filter((row) => !importedIds.has(String(row.id))).length
      rows.push({
        openCodeId: session.id,
        dshSessionId,
        title: session.title,
        directory: session.directory,
        cwd: normalizeCwd(session.directory),
        parentId: session.parentId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: session.archivedAt !== null,
        model: session.model,
        messageSource: source,
        messageCount: messages.length,
        messageTypes: counts,
        imported: importedIds !== null,
        pendingRows,
        state: source !== 'session_message'
          ? 'no-transcript'
          : importedIds === null
            ? 'new'
            : pendingRows === 0
              ? 'in-sync'
              : 'has-new',
      })
    }
    return { dbPath: store.path, total: sessions.length, selected: rows }
  } finally {
    store.close()
  }
}

/**
 * 执行一次同步。
 *
 * @param {object} deps  { persistence, workspaces }
 * @param {object} options { dryRun, sessionIds, workspace, limit, includeChildren }
 */
export async function runSync(deps, options = {}) {
  const config = loadConfig()
  const persistence = deps.persistence
  const workspaces = deps.workspaces ?? null
  if (!config.enabled) {
    return { ok: false, reason: '插件已在配置里禁用（~/.dsh/opencode-session-sync.json 的 enabled=false）' }
  }
  if (persistence === undefined || persistence === null) {
    return { ok: false, reason: 'DSH 会话持久化服务不可用（sessionPersistence 缺失）' }
  }
  if (config.dbPath.trim() === '') config.dbPath = resolveDbPath('')

  const dryRun = options.dryRun === true
  const state = loadState()
  const report = {
    ok: true,
    dryRun,
    dbPath: config.dbPath,
    startedAt: new Date().toISOString(),
    configFile: config.configFile,
    scanned: 0,
    considered: 0,
    imported: 0,
    appended: 0,
    upToDate: 0,
    diverged: 0,
    skipped: 0,
    failed: 0,
    events: 0,
    workspace: { matched: 0, created: 0, unattached: 0, skippedNoDir: 0 },
    sessions: [],
    warnings: [],
  }

  const store = await openStore(config.dbPath)
  try {
    const sessions = store.listSessions()
    report.scanned = sessions.length
    let candidates = filterSessions(sessions, options, config)
    if (Number.isFinite(options.limit) && Number(options.limit) > 0) {
      candidates = candidates
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Math.trunc(options.limit))
    } else if (Number.isFinite(config.importLimit) && candidates.length > config.importLimit) {
      candidates = candidates
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, config.importLimit)
    }
    report.considered = candidates.length

    // 工作区索引（entity 带 attachSession）
    let workspaceList = []
    if (workspaces !== null && typeof workspaces.list === 'function') {
      try {
        workspaceList = workspaces.list()
      } catch (error) {
        report.warnings.push(`读取工作区注册表失败：${String(error?.message ?? error)}`)
      }
    }

    for (const session of candidates) {
      const dshSessionId = dshSessionIdFor(session.id)
      const entry = {
        openCodeId: session.id,
        dshSessionId,
        title: session.title,
        cwd: normalizeCwd(session.directory),
        status: 'pending',
      }
      report.sessions.push(entry)

      const cwd = normalizeCwd(session.directory)
      if (config.onlyExistingDirectories === true && (cwd === null || !isDirectory(cwd))) {
        entry.status = 'skipped'
        entry.reason = '目录在本机不存在，按配置跳过'
        report.skipped += 1
        report.workspace.skippedNoDir += 1
        continue
      }

      const { rows, source } = store.listMessages(session.id)
      if (rows.length === 0) {
        entry.status = 'skipped'
        entry.reason = source === 'legacy-only'
          ? '只有旧格式（message/part）正文，本插件暂不解析'
          : '没有可导入的正文'
        report.skipped += 1
        continue
      }

      const baseOptions = {
        titlePrefix: config.titlePrefix,
        agentPreset: config.agentPreset,
        includeReasoning: config.includeReasoning,
        includeToolCalls: config.includeToolCalls,
        maxToolResultChars: config.maxToolResultChars,
      }

      // 已有 DSH 会话就把它读回来：既用于判断「已经导到哪一步」，也用于增量追加。
      const existing = await readDshSession(persistence, dshSessionId)

      // 回退检测：账本记着上次导入的最后一行；它若已不在源会话里，说明用户在
      // OpenCode 侧回退或改写过历史，此时追加会拼出一份错乱的记录，宁可跳过并说明。
      const ledgerRow = state.sessions[session.id]
      if (existing !== null && typeof ledgerRow?.lastRowId === 'string' && ledgerRow.lastRowId !== '') {
        if (!rows.some((row) => String(row.id) === ledgerRow.lastRowId)) {
          entry.status = 'diverged'
          entry.reason = `源会话已回退或改写（上次导入的最后一行 ${ledgerRow.lastRowId} 已不在源会话里），跳过以免拼出错误记录`
          report.diverged += 1
          continue
        }
      }

      // 结构一致性：已导入的行必须仍然是源里的一个前缀。中间被删改会让后面的
      // 已导入行跑到「新行」之后，此时追加会拼出错乱记录，直接判为 diverged。
      if (existing !== null) {
        const importedRows = new Set(existing.importedRowIds)
        let seenNew = false
        let outOfOrder = null
        for (const row of rows) {
          if (row.type !== 'user' && row.type !== 'assistant') continue
          const isImported = importedRows.has(String(row.id))
          if (!isImported) seenNew = true
          else if (seenNew) {
            outOfOrder = String(row.id)
            break
          }
        }
        if (outOfOrder !== null) {
          entry.status = 'diverged'
          entry.reason = `源会话的历史被改写过（已导入的 ${outOfOrder} 出现在新内容之后），跳过以免拼出错误记录`
          report.diverged += 1
          continue
        }
      }

      let projection = null
      let ledgerRows = null
      try {
        if (existing === null) {
          // ---------- 首次导入 ----------
          const plan = buildSessionPlan({ session, rows, options: baseOptions })
          entry.events = plan.events.length
          entry.messages = plan.stats.userMessages + plan.stats.assistantMessages
          entry.toolCalls = plan.stats.toolCalls
          entry.title = plan.events.at(-1)?.data?.title ?? entry.title
          if (plan.warnings.length > 0) entry.warnings = plan.warnings
          if (dryRun) {
            entry.status = 'planned'
          } else {
            const handle = await persistence.create(plan.header)
            try {
              await handle.append(plan.events)
              await handle.flush()
            } finally {
              await handle.close()
            }
            entry.status = 'imported'
            report.imported += 1
            report.events += plan.events.length
            projection = { header: plan.header, events: plan.events }
          }
          ledgerRows = rows
        } else {
          // ---------- 增量追加 ----------
          // 已导入的内容是源会话的一个前缀；从最后一条已导入的正文行之后切开，
          // 顺手吃掉紧随其后的 idle 行（它只表示上一轮的收尾）。
          // 必须带上 idle 等结构行，否则相邻两轮会被并成一整轮。
          const importedRows = new Set(existing.importedRowIds)
          let lastImported = -1
          for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i]
            if ((row.type === 'user' || row.type === 'assistant') && importedRows.has(String(row.id))) lastImported = i
          }
          let cut = lastImported + 1
          while (cut < rows.length && rows[cut].type === 'idle') cut += 1
          const newRows = lastImported < 0 ? rows : rows.slice(cut)
          const hasNewContent = newRows.some((row) => row.type === 'user' || row.type === 'assistant')
          if (!hasNewContent) {
            entry.status = 'up-to-date'
            report.upToDate += 1
          } else {
            const plan = buildAppendPlan({
              session,
              rows: newRows,
              options: {
                ...baseOptions,
                startSeq: existing.nextSeq,
                startTurn: existing.maxTurn + 1,
                baseTime: existing.lastTime,
                currentTitle: existing.currentTitle,
              },
            })
            entry.turns = plan.stats.turns
            entry.messages = plan.stats.userMessages + plan.stats.assistantMessages
            entry.titleChanged = plan.titleChanged === true
            if (plan.events.length === 0) {
              entry.status = 'up-to-date'
              report.upToDate += 1
            } else if (dryRun) {
              entry.status = 'planned'
              entry.events = plan.events.length
            } else {
              const handle = await persistence.open(dshSessionId, 'write')
              try {
                await handle.append(plan.events)
                await handle.flush()
              } finally {
                await handle.close()
              }
              entry.status = 'appended'
              entry.events = plan.events.length
              entry.toolCalls = plan.stats.toolCalls
              report.appended += 1
              report.events += plan.events.length
              projection = { header: existing.header, events: [...existing.events, ...plan.events] }
            }
            ledgerRows = newRows
          }
        }
      } catch (error) {
        entry.status = 'failed'
        entry.reason = `写入失败：${String(error?.message ?? error)}`
        report.failed += 1
        continue
      }

      // 补写投影缓存：导入/追加后的会话不是「活会话」，列表读的是持久投影缓存，
      // 不补这一步侧边栏会缺标题或停在旧标题（失败仅告警）。
      if (projection !== null && deps.projections !== null && deps.projections !== undefined) {
        if (typeof deps.projections.coldSnapshot === 'function') {
          try {
            deps.projections.coldSnapshot(projection.header, 0, projection.events)
            entry.projection = 'warmed'
          } catch (error) {
            entry.projection = 'failed'
            report.warnings.push(`会话 ${entry.dshSessionId} 的投影缓存未写入：${String(error?.message ?? error)}`)
          }
        }
      }

      // 登记进对应工作区（dry-run 下会话并不存在，不能登记）
      const attachable = entry.status === 'imported' || entry.status === 'appended' || entry.status === 'up-to-date'
      if (!dryRun && attachable && workspaces !== null && cwd !== null) {
        try {
          const outcome = await attachToWorkspace(workspaces, workspaceList, cwd, dshSessionId, config, report)
          entry.workspace = outcome.workspacePath ?? null
          entry.workspaceAction = outcome.action
          report.workspace[outcome.action] = (report.workspace[outcome.action] ?? 0) + 1
          if (outcome.workspacePath !== null) workspaceList = workspaces.list()
        } catch (error) {
          entry.workspaceAction = 'unattached'
          entry.workspaceReason = String(error?.message ?? error)
          report.workspace.unattached += 1
          report.warnings.push(`会话 ${entry.dshSessionId} 未能登记到工作区：${String(error?.message ?? error)}`)
        }
      } else if (!dryRun && attachable) {
        report.workspace.unattached += 1
        entry.workspaceAction = 'unattached'
        entry.workspaceReason = cwd === null ? '目录不是绝对路径' : '工作区注册表不可用'
      }

      if (!dryRun && ledgerRows !== null) {
        const previous = state.sessions[session.id]
        const lastRow = [...ledgerRows].reverse().find((row) => row.type === 'user' || row.type === 'assistant') ?? null
        const added = entry.status === 'imported' || entry.status === 'appended' ? entry.events ?? 0 : 0
        state.sessions[session.id] = {
          dshSessionId,
          title: entry.title ?? previous?.title ?? session.title ?? null,
          cwd,
          events: (existing === null ? 0 : existing.events.length) + added,
          messages: (previous?.messages ?? 0) + (entry.messages ?? 0),
          toolCalls: (previous?.toolCalls ?? 0) + (entry.toolCalls ?? 0),
          lastRowId: lastRow === null ? previous?.lastRowId ?? null : String(lastRow.id),
          lastRowCreatedAt: lastRow?.createdAt ?? previous?.lastRowCreatedAt ?? null,
          importedAt: previous?.importedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      }
    }

    if (!dryRun) {
      saveState(state)
    }
  } finally {
    store.close()
  }

  report.finishedAt = new Date().toISOString()
  if (!dryRun) saveReport(report)
  return report
}

async function attachToWorkspace(workspaces, workspaceList, cwd, dshSessionId, config, report) {  const target = cwd
  let entity = workspaceList.find((workspace) => normPath(workspace.path) === normPath(target)) ?? null
  if (entity === null) {
    if (config.createMissingWorkspaces !== true) return { action: 'unattached', workspacePath: null }
    if (!isDirectory(target)) {
      report.warnings.push(`目录不存在，未创建工作区：${target}`)
      return { action: 'unattached', workspacePath: null }
    }
    entity = await workspaces.create(target)
    if (typeof entity?.attachSession !== 'function') return { action: 'unattached', workspacePath: null }
    await entity.attachSession(dshSessionId)
    return { action: 'created', workspacePath: entity.path }
  }
  if (typeof entity.attachSession !== 'function') return { action: 'unattached', workspacePath: null }
  if (typeof entity.sessionIds?.includes === 'function' && entity.sessionIds.includes(dshSessionId)) {
    return { action: 'matched', workspacePath: entity.path }
  }
  await entity.attachSession(dshSessionId)
  return { action: 'matched', workspacePath: entity.path }
}

/** 一次读取的数；按批读到短批为止，避免依赖某个固定的长度语义。 */
const READ_CHUNK = 2000
/** 单个会话日志的安全上限，防止异常数据把内存吃满。 */
const READ_MAX_EVENTS = 1_000_000

/**
 * 读回一份已存在的 DSH 会话日志；不存在或读不动时返回 null。
 *
 * 返回的坐标（nextSeq / maxTurn / lastTime / currentTitle）是增量追加的落点，
 * `importedRowIds` 是日志里已经出现过的 OpenCode 行 id —— 幂等判断因此不依赖账本，
 * 账本丢了也只会退化成「多读一次日志」，不会重复导入。
 */
export async function readDshSession(persistence, id) {
  let handle
  try {
    handle = await persistence.open(id, 'read')
  } catch {
    return null
  }
  try {
    const events = []
    let offset = 0
    for (;;) {
      const chunk = await handle.read(offset, READ_CHUNK)
      const batch = Array.isArray(chunk?.events) ? chunk.events : []
      events.push(...batch)
      if (batch.length < READ_CHUNK || events.length >= READ_MAX_EVENTS) break
      offset += batch.length
    }
    return deriveDshState(handle.header, events)
  } catch {
    return null
  } finally {
    try {
      await handle.close()
    } catch {
      /* 关闭失败不影响已读到的内容 */
    }
  }
}

/** 从既有日志推导出增量追加需要的坐标与已导入的行 id。 */
function deriveDshState(header, events) {
  const importedRowIds = new Set()
  let maxTurn = 0
  let nextSeq = 0
  let lastTime = Number.isFinite(header?.createdAt) ? header.createdAt : 0
  let currentTitle = null
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq)) nextSeq = Math.max(nextSeq, event.seq + 1)
    if (Number.isSafeInteger(event?.time)) lastTime = Math.max(lastTime, event.time)
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      maxTurn = Math.max(maxTurn, event.data.turn)
    }
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
      currentTitle = event.data.title
    }
    const messageId = event?.type === 'user/message'
      ? event.data?.id
      : event?.type === 'assistant/message' || event?.type === 'tool/result'
        ? event.data?.message?.id
        : undefined
    if (typeof messageId === 'string' && messageId !== '') {
      // tool/result 的消息 id 形如 `<源行 id>:tool:<n>`，还原成源行 id
      importedRowIds.add(event.type === 'tool/result' ? messageId.replace(/:tool:\d+$/, '') : messageId)
    }
  }
  return { header, events, importedRowIds, maxTurn, nextSeq, lastTime, currentTitle }
}

/** 账本 + 最近一次报告，供 `status` 动作使用。 */
export function readStatus() {
  const config = loadConfig()
  const state = loadState()
  let lastRun = null
  try {
    lastRun = JSON.parse(readFileSync(reportPath(), 'utf8'))
  } catch {
    lastRun = null
  }
  return {
    enabled: config.enabled,
    configFile: config.configFile,
    dbPath: config.dbPath === '' ? resolveDbPath('') : config.dbPath,
    autoSyncOnStart: config.autoSyncOnStart,
    titlePrefix: config.titlePrefix,
    includeChildren: config.includeChildren,
    imported: Object.keys(state.sessions).length,
    updatedAt: state.updatedAt,
    stateFile: statePathForStatus(),
    lastRun: lastRun === null || typeof lastRun !== 'object'
      ? null
      : {
          at: lastRun.finishedAt ?? lastRun.startedAt ?? null,
          dryRun: lastRun.dryRun === true,
          imported: lastRun.imported ?? 0,
          appended: lastRun.appended ?? 0,
          upToDate: lastRun.upToDate ?? 0,
          skipped: lastRun.skipped ?? 0,
          failed: lastRun.failed ?? 0,
        },
  }
}

function statePathForStatus() {
  return statePath()
}
