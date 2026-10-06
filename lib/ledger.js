// 配置与账本（幂等记录）的落盘层。
//
//   ~/.dsh/opencode-session-sync.json          配置（首次运行自动写出默认值）
//   ~/.dsh/opencode-session-sync/state.json    已导入会话账本
//   ~/.dsh/opencode-session-sync/last-run.json 最近一次同步报告
//
// 账本只是「更快更可读」的记录；判断是否已导入以 DSH 会话持久化里的实际存在为准，
// 所以账本丢失不会造成重复导入。

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULTS = {
  enabled: true,
  dbPath: '',
  autoSyncOnStart: true,
  autoSyncDelayMs: 4000,
  includeChildren: false,
  importLimit: 200,
  titlePrefix: '[OC] ',
  agentPreset: 'standard',
  includeReasoning: true,
  includeToolCalls: true,
  maxToolResultChars: 200000,
  createMissingWorkspaces: true,
  onlyExistingDirectories: false,
}

export function configPath() {
  return join(homedir(), '.dsh', 'opencode-session-sync.json')
}

export function statePath() {
  return join(homedir(), '.dsh', 'opencode-session-sync', 'state.json')
}

export function reportPath() {
  return join(homedir(), '.dsh', 'opencode-session-sync', 'last-run.json')
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** 原子写：先写同目录临时文件再 rename，避免半截 JSON。 */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function normalizeConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
  const number = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(min, Math.min(max, Math.trunc(parsed)))
  }
  merged.enabled = merged.enabled !== false
  merged.autoSyncOnStart = merged.autoSyncOnStart !== false
  merged.includeChildren = merged.includeChildren === true
  merged.includeReasoning = merged.includeReasoning !== false
  merged.includeToolCalls = merged.includeToolCalls !== false
  merged.createMissingWorkspaces = merged.createMissingWorkspaces !== false
  merged.onlyExistingDirectories = merged.onlyExistingDirectories === true
  merged.autoSyncDelayMs = number(merged.autoSyncDelayMs, DEFAULTS.autoSyncDelayMs, 0, 600000)
  merged.importLimit = number(merged.importLimit, DEFAULTS.importLimit, 1, 5000)
  merged.maxToolResultChars = number(merged.maxToolResultChars, DEFAULTS.maxToolResultChars, 0, 5000000)
  if (typeof merged.dbPath !== 'string') merged.dbPath = DEFAULTS.dbPath
  if (typeof merged.titlePrefix !== 'string') merged.titlePrefix = DEFAULTS.titlePrefix
  if (typeof merged.agentPreset !== 'string') merged.agentPreset = DEFAULTS.agentPreset
  return merged
}

/** 读取用户配置；不存在时写出默认配置，方便直接编辑。 */
export function loadConfig() {
  const file = configPath()
  const raw = readJson(file, null)
  if (raw === null) {
    try {
      writeJsonAtomic(file, DEFAULTS)
    } catch {
      /* 写不出默认配置不算致命 */
    }
    return { ...DEFAULTS, configFile: file, wroteDefaults: true }
  }
  return { ...normalizeConfig(raw), configFile: file, wroteDefaults: false }
}

export function loadState() {
  const state = readJson(statePath(), null)
  if (state === null || typeof state.sessions !== 'object' || state.sessions === null) {
    return { version: 1, updatedAt: null, sessions: {} }
  }
  return { version: 1, updatedAt: state.updatedAt ?? null, sessions: { ...state.sessions } }
}

export function saveState(state) {
  const next = { version: 1, updatedAt: new Date().toISOString(), sessions: state.sessions }
  writeJsonAtomic(statePath(), next)
  return next
}

export function saveReport(report) {
  try {
    writeJsonAtomic(reportPath(), report)
  } catch {
    /* 报告落盘失败不影响同步结果 */
  }
}
