// dsh-opencode-session-sync —— DSH 宿主插件
//
// 把一个 agent 可调用的工具 `opencode_sync` 注册进 DSH，并（可配置地）在启动后
// 自动跑一次导入：
//
//   list   —— 只读盘点：OpenCode 有哪些会话、会落到哪个 DSH 工作区、是否已导入
//   import —— 真正导入（默认幂等：已存在的会话跳过；dryRun 只做计划不写盘）
//   status —— 账本与最近一次同步结果
//
// 写入完全交给 DSH 的 sessionPersistence，因此生成的是 DSH 原生 V4 会话，
// 会出现在对应工作区的会话列表里，可以直接继续对话。

import { loadConfig } from './ledger.js'
import { readDshSession, readStatus, runSync, summarizeSessions } from './sync.js'
import { resolveDbPath } from './opencode-db.js'

export const name = 'opencode-session-sync'
export const inject = ['tools', 'sessionPersistence']

const ACTIONS = ['list', 'import', 'status']

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'list=只读盘点；import=导入（默认幂等）；status=账本与上次结果。默认 list。',
    },
    dryRun: { type: 'boolean', description: 'import 时只生成计划不写盘，用来先看会导入什么。' },
    workspace: { type: 'string', description: '只处理目录里包含该子串的会话，例如 dsh_ws。' },
    sessionIds: {
      type: 'array',
      items: { type: 'string' },
      description: '只处理这些 OpenCode 会话 id（ses_...）。',
    },
    includeChildren: { type: 'boolean', description: '是否连子会话（subagent 子会话）一起导入。默认否。' },
    limit: { type: 'number', description: '本次最多处理的会话数（按最近更新优先）。' },
  },
  required: [],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    reason: { type: 'string' },
  },
  additionalProperties: true,
}

function fmtTime(value) {
  if (!Number.isFinite(value) || value <= 0) return '—'
  try {
    return new Date(value).toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return String(value)
  }
}

function shortId(value) {
  const text = String(value ?? '')
  return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text
}

/** 把工具返回值渲染成给模型看的 Markdown。 */
function render(args, value) {
  if (value === null || typeof value !== 'object') {
    return [{ type: 'text', text: `opencode_sync: ${String(value)}` }]
  }
  if (value.ok === false) {
    return [{ type: 'text', text: `opencode_sync 未能执行：${value.reason ?? '未知原因'}` }]
  }
  if (value.action === 'status') {
    const lines = [
      '## OpenCode → DSH 会话同步状态',
      '',
      `- 插件启用：${value.enabled ? '是' : '否'}`,
      `- OpenCode 数据库：\`${value.dbPath}\``,
      `- 配置：\`${value.configFile}\``,
      `- 账本：\`${value.stateFile}\`（已记录 ${value.imported} 个会话）`,
      `- 启动自动同步：${value.autoSyncOnStart ? '开' : '关'}；子会话：${value.includeChildren ? '导入' : '不导入'}`,
      `- 标题前缀：\`${value.titlePrefix}\``,
    ]
    if (value.lastRun !== null) {
      lines.push(
        '',
        `最近一次同步：${value.lastRun.at ?? '—'}${value.lastRun.dryRun ? '（dry-run）' : ''} —— ` +
          `新导入 ${value.lastRun.imported}、追加更新 ${value.lastRun.appended ?? 0}、已同步 ${value.lastRun.upToDate ?? 0}、` +
          `跳过 ${value.lastRun.skipped}、失败 ${value.lastRun.failed}`,
      )
    } else {
      lines.push('', '还没有跑过同步。')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (value.action === 'list') {
    const rows = Array.isArray(value.selected) ? value.selected : []
    const lines = [
      `## OpenCode 会话盘点（共 ${value.total} 个，本次列出 ${rows.length} 个）`,
      '',
      `数据库：\`${value.dbPath}\``,
      '',
      '| 状态 | OpenCode 会话 | 标题 | 工作区目录 | 正文 | 更新时间 |',
      '|---|---|---|---|---|---|',
    ]
    const label = { new: '待导入', 'has-new': '有新内容', 'in-sync': '已同步', 'no-transcript': '无正文' }
    for (const row of rows) {
      const badge = label[row.state] ?? row.state
      const pending = row.state === 'has-new' ? `（待追加 ${row.pendingRows} 条）` : ''
      lines.push(
        `| ${badge}${pending} | \`${shortId(row.openCodeId)}\` | ${(row.title ?? '—').replace(/\|/g, '\\|')} | ` +
          `\`${row.cwd ?? row.directory ?? '—'}\` | ${row.messageCount} 条（${row.messageSource}） | ${fmtTime(row.updatedAt)} |`,
      )
    }
    if (rows.length === 0) lines.push('| — | — | — | — | — | — |')
    lines.push(
      '',
      '状态说明：**待导入**=会新建 DSH 会话；**有新内容**=DSH 里已有该会话，会把这期间新增的回合追加进去；' +
        '**已同步**=没有新内容；**无正文**=该会话没有可解析的消息。',
    )
    if (Array.isArray(value.warnings) && value.warnings.length > 0) {
      lines.push('', '警告：', ...value.warnings.map((item) => `- ${item}`))
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  // import
  const lines = [
    value.dryRun ? '## 同步计划（dry-run，未写盘）' : '## OpenCode → DSH 同步完成',
    '',
    `扫描 ${value.scanned} 个 OpenCode 会话，处理 ${value.considered} 个：` +
      `新导入 **${value.imported}**、追加更新 **${value.appended}**、已同步 ${value.upToDate}、` +
      `源已回退 ${value.diverged ?? 0}、跳过 ${value.skipped}、失败 ${value.failed}`,
    `写入 DSH 事件 ${value.events} 条；工作区：命中 ${value.workspace.matched}、新建 ${value.workspace.created}、未登记 ${value.workspace.unattached}`,
    '',
  ]
  const detail = (value.sessions ?? []).filter((row) => row.status !== 'up-to-date')
  if (detail.length > 0) {
    lines.push('| 结果 | 标题 | 工作区 | 事件 | 说明 |', '|---|---|---|---|---|')
    for (const row of detail) {
      const note = row.reason ?? row.workspaceReason ?? row.workspaceAction ?? ''
      lines.push(
        `| ${row.status} | ${(row.title ?? '—').replace(/\|/g, '\\|')} | \`${row.workspace ?? '—'}\` | ` +
          `${row.events ?? 0} | ${String(note).replace(/\|/g, '\\|')} |`,
      )
    }
  }
  if (value.upToDate > 0) lines.push('', `${value.upToDate} 个会话已是最新，未做改动。`)
  const skippedNote = (value.sessions ?? []).filter((row) => row.status === 'skipped')
  if (skippedNote.length > 0) {
    lines.push('', `跳过 ${skippedNote.length} 个（无正文 / 目录缺失 / 旧格式），理由见上表「说明」列。`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', '警告：', ...value.warnings.map((item) => `- ${item}`))
  }
  if (!value.dryRun && value.imported > 0) {
    lines.push(
      '',
      '> 导入的会话会出现在对应工作区的会话列表中；如果列表没立刻刷新，重启一次 DeepSeek Harness 即可（工作区注册表在启动时也会自动收纳）。',
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function toJsonValue(value) {
  return JSON.parse(JSON.stringify(value))
}

export default {
  name,
  inject,
  apply(ctx) {
    const log = (message) => {
      try {
        console.log(`[opencode-session-sync] ${message}`)
      } catch {
        /* 忽略日志失败 */
      }
    }

    // 配置在插件挂载时读一次（改配置需重启，与 DSH 其它配置一致）。
    // enabled=false 时插件完全不动：不注册工具，也不自动同步。
    const config = loadConfig()
    if (!config.enabled) {
      log(`已在配置里禁用（${config.configFile}），不注册工具、不自动同步`)
      return
    }

    ctx.tools.register({
      name: 'opencode_sync',
      description:
        '把 OpenCode 桌面端（opencode.db）的历史会话同步进 DeepSeek Harness：' +
        '按会话原本的工作目录写成 DSH 原生会话，出现在对应工作区的会话列表里。' +
        'action=list 只读盘点（不改任何东西）、import 执行导入（幂等，已导入的跳过）、status 看账本。',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render,
      },
      timeoutMs: 600000,
      async execute(args) {
        const params = args !== null && typeof args === 'object' ? args : {}
        const action = ACTIONS.includes(params.action) ? params.action : 'list'
        try {
          if (action === 'status') {
            return toJsonValue({ ok: true, action, ...readStatus() })
          }
          if (action === 'list') {
            const config = loadConfig()
            if (config.dbPath.trim() === '') config.dbPath = resolveDbPath('')
            const summary = await summarizeSessions({
              config,
              options: {
                workspace: params.workspace,
                sessionIds: params.sessionIds,
                includeChildren: params.includeChildren,
                limit: params.limit,
              },
              importedIdsFor: async (dshSessionId) => {
                const existing = await readDshSession(ctx.sessionPersistence, dshSessionId)
                return existing === null ? null : existing.importedRowIds
              },
            })
            const warnings = []
            if (summary.selected.some((row) => row.messageSource === 'legacy-only')) {
              warnings.push('存在只有旧格式（message/part）正文的会话，本插件暂不解析这类正文。')
            }
            return toJsonValue({ ok: true, action, dbPath: summary.dbPath, total: summary.total, selected: summary.selected, warnings })
          }
          const report = await runSync(
            {
              persistence: ctx.sessionPersistence,
              workspaces: ctx.get('workspaceRegistry') ?? null,
              projections: ctx.get('sessionProjectionCache') ?? null,
            },
            {
              dryRun: params.dryRun === true,
              workspace: params.workspace,
              sessionIds: params.sessionIds,
              includeChildren: params.includeChildren,
              limit: params.limit,
            },
          )
          if (report.ok === false) return toJsonValue({ ok: false, action, reason: report.reason })
          return toJsonValue({ ok: true, action, ...report })
        } catch (error) {
          return toJsonValue({
            ok: false,
            action,
            reason: String(error?.stack ?? error?.message ?? error),
          })
        }
      },
    })

    if (!config.autoSyncOnStart) {
      log(`已注册 opencode_sync 工具；自动同步关闭（配置 ${config.configFile}）`)
      return
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const report = await runSync(
            {
              persistence: ctx.sessionPersistence,
              workspaces: ctx.get('workspaceRegistry') ?? null,
              projections: ctx.get('sessionProjectionCache') ?? null,
            },
            {},
          )
          if (report.ok === false) {
            log(`启动自动同步跳过：${report.reason}`)
            return
          }
          log(
            `启动自动同步：扫描 ${report.scanned}、新导入 ${report.imported}、追加更新 ${report.appended}、` +
              `已同步 ${report.upToDate}、跳过 ${report.skipped}、失败 ${report.failed}`,
          )
        } catch (error) {
          log(`启动自动同步失败：${String(error?.message ?? error)}`)
        }
      })()
    }, config.autoSyncDelayMs)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => clearTimeout(timer))
  },
}
