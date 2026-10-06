// 同步编排层：把 OpenCode 会话按工作区写进 DSH 的会话持久化。
//
// 写入走 DSH 自己的 sessionPersistence（create → append → flush → close），
// 因此 V4 格式与跨事件关系校验由 DSH 本体负责，本插件不拼字节。
// 会话按 header.cwd 落到对应工作区分桶；随后再用 workspaceRegistry 把会话
// 登记进该工作区的 sessionIds，列表里立刻就对应上。

import { readFileSync, statSync } from 'node:fs'
import { openStore, resolveDbPath } from './opencode-db.js'
import { buildSessionPlan, dshSessionIdFor, normalizeCwd } from './convert.js'
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

/** 列出候选会话（不构造事件、不写盘），供 `list` 动作与自检使用。 */
export async function summarizeSessions({ config, options = {} }) {
  if (typeof config.dbPath !== 'string' || config.dbPath.trim() === '') config.dbPath = resolveDbPath('')
  const store = await openStore(config.dbPath)
  try {
    const sessions = store.listSessions()
    const selected = filterSessions(sessions, options, config)
    return {
      dbPath: store.path,
      total: sessions.length,
      selected: selected.map((session) => {
        const { rows, source } = store.listMessages(session.id)
        const counts = {}
        for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1
        return {
          openCodeId: session.id,
          dshSessionId: dshSessionIdFor(session.id),
          title: session.title,
          directory: session.directory,
          cwd: normalizeCwd(session.directory),
          parentId: session.parentId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          archived: session.archivedAt !== null,
          model: session.model,
          messageSource: source,
          messageCount: rows.length,
          messageTypes: counts,
        }
      }),
    }
  } finally {
    store.close()
  }
}

/**
 * 执行一次同步。
 *
 * @param {object} deps  { persistence, workspaces }
 * @param {object} options { dryRun, force, sessionIds, workspace, limit, includeChildren }
 */
export async function runSync(deps, options = {}) {
  const config = loadConfig()
  const persistence = deps.persistence
  const workspaces = deps.workspaces ?? null
  if (!config.enabled && options.force !== true) {
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
    existing: 0,
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

      let plan
      try {
        plan = buildSessionPlan({
          session,
          rows,
          options: {
            titlePrefix: config.titlePrefix,
            agentPreset: config.agentPreset,
            includeReasoning: config.includeReasoning,
            includeToolCalls: config.includeToolCalls,
            maxToolResultChars: config.maxToolResultChars,
          },
        })
      } catch (error) {
        entry.status = 'failed'
        entry.reason = `转换失败：${String(error?.message ?? error)}`
        report.failed += 1
        continue
      }
      entry.events = plan.events.length
      entry.messages = plan.stats.userMessages + plan.stats.assistantMessages
      entry.toolCalls = plan.stats.toolCalls
      entry.title = plan.events.at(-1)?.data?.title ?? entry.title
      if (plan.warnings.length > 0) entry.warnings = plan.warnings

      const exists = options.force !== true && (await persistence.stat(dshSessionId)) !== undefined
      if (exists) {
        entry.status = 'existing'
        report.existing += 1
      } else if (dryRun) {
        entry.status = 'planned'
      } else {
        try {
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
        } catch (error) {
          entry.status = 'failed'
          entry.reason = `写入失败：${String(error?.message ?? error)}`
          report.failed += 1
          continue
        }
      }

      // 补写投影缓存：导入的会话不是「活会话」，列表读的是持久投影缓存，
      // 不补这一步侧边栏会缺标题（`coldSnapshot` 会把刷新后的检查点写回，失败仅告警）。
      if (!dryRun && entry.status === 'imported' && deps.projections !== null && deps.projections !== undefined) {
        if (typeof deps.projections.coldSnapshot === 'function') {
          try {
            deps.projections.coldSnapshot(plan.header, 0, plan.events)
            entry.projection = 'warmed'
          } catch (error) {
            entry.projection = 'failed'
            report.warnings.push(`会话 ${entry.dshSessionId} 的投影缓存未写入：${String(error?.message ?? error)}`)
          }
        }
      }

      // 登记进对应工作区（dry-run 下会话并不存在，不能登记）
      if (!dryRun && (entry.status === 'imported' || entry.status === 'existing') && workspaces !== null && cwd !== null) {
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
      } else {
        if (!dryRun && (entry.status === 'imported' || entry.status === 'existing')) {
          report.workspace.unattached += 1
          entry.workspaceAction = 'unattached'
          entry.workspaceReason = cwd === null ? '目录不是绝对路径' : '工作区注册表不可用'
        }
      }

      if (!dryRun && entry.status === 'imported') {
        state.sessions[session.id] = {
          dshSessionId,
          title: entry.title ?? null,
          cwd,
          events: plan.events.length,
          messages: entry.messages ?? 0,
          importedAt: new Date().toISOString(),
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

async function attachToWorkspace(workspaces, workspaceList, cwd, dshSessionId, config, report) {
  const target = cwd
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
          existing: lastRun.existing ?? 0,
          skipped: lastRun.skipped ?? 0,
          failed: lastRun.failed ?? 0,
        },
  }
}

function statePathForStatus() {
  return statePath()
}
