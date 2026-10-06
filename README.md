# dsh-opencode-session-sync

把 **OpenCode 桌面端**的历史会话按「原本的工作目录」导入成 **DeepSeek Harness 原生会话**，
让它们在 DSH 对应工作区的会话列表里出现，并且可以直接接着对话。

- OpenCode 侧只读：只打开 `opencode.db` 读，从不写。
- 写入交给 DSH 自己的会话持久化层（`ctx.sessionPersistence`），生成的是标准 V4 会话日志，
  格式与跨事件关系由 DSH 本体校验，插件不拼字节。
- 幂等：已存在的会话按 id 跳过；重复运行不会产生副本。

---

## 现在装好了吗

已安装到 `desktop` profile：

| 位置 | 内容 |
|---|---|
| `C:\Users\ZJY\Desktop\dsh_ws\dsh-opencode-session-sync` | 插件源码（本目录） |
| `~/.dsh/profiles/desktop/package.json` | `dependencies` + `dsh.profile.bundles` 已登记（`link:` 到本目录） |
| `~/.dsh/profiles/desktop/node_modules/dsh-opencode-session-sync` | junction → 本目录 |

> **插件在 DSH 启动时才会加载。** 重启一次 DeepSeek Harness 后生效；启动约 4 秒后会自动跑一次
> 导入，之后每次启动都会自动补齐新会话（已导入的跳过）。不想重启也行，但那样它不会起作用。

重启后可以这样确认：

```
~/.dsh/opencode-session-sync/last-run.json      最近一次导入报告（含每个会话的结果）
~/.dsh/opencode-session-sync/state.json         已导入账本
```

或者在任意 DSH 会话里让我调用工具 `opencode_sync`（`action: "status"`）。

---

## 怎么用

### 1. 自动（默认）

启动后自动导入，无需操作：

```jsonc
// ~/.dsh/opencode-session-sync.json
{ "autoSyncOnStart": true, "autoSyncDelayMs": 4000, "importLimit": 200 }
```

### 2. 手动：`opencode_sync` 工具

插件给 agent 注册了一个工具 `opencode_sync`，三个动作：

| action | 作用 | 主要参数 |
|---|---|---|
| `list` | **只读**盘点：OpenCode 有哪些会话、会落到哪个 DSH 工作区、是否已导入 | `workspace`、`limit`、`includeChildren` |
| `import` | 执行导入（默认幂等） | `dryRun`（只看计划不写盘）、`force`、`workspace`、`sessionIds`、`limit`、`includeChildren` |
| `status` | 账本与最近一次结果 | — |

对话里直接说就行，例如：

- 「列出 opencode 里有但 DSH 里还没有的会话」
- 「把 `dsh_ws` 相关的 OpenCode 会话导进来」
- 「先 dry-run 看一下会导入什么」

### 3. 命令行自检（不开 DSH 也能跑）

```powershell
node tools\selfcheck.mjs                 # 盘点 + 转换 + 结构/关系校验（只读）
node tools\selfcheck.mjs --limit 3        # 只看最近 3 个会话
node tools\selfcheck.mjs --all            # 连子会话一起转换
node tools\verify-install.mjs             # 检查安装是否完好
```

---

## 它是怎么对应的

| OpenCode | DSH | 说明 |
|---|---|---|
| `session_v2.directory` | `SessionHeader.cwd` | 会话落在按 cwd 命名的存储分桶里，例如 `C:/Users/ZJY/Desktop/dsh_ws` → `sessions/--C-Users-ZJY-Desktop-dsh_ws--/` |
| （cwd 决定归属） | 工作区注册表 `sessionIds` | 写入后用 `workspaceRegistry` 把会话登记进该目录对应的工作区；目标目录还没有工作区时会自动创建一个 |
| `session_v2.title` | `session/title` 事件 | 默认加 `[OC] ` 前缀便于与原生会话区分，可用 `titlePrefix` 关掉 |
| `session_v2.time_created` | `SessionHeader.createdAt` | 保留原始创建时间，列表按真实时间排序 |
| `session_message(type=user)` | `user/message` | 用户消息正文 |
| `session_message(type=assistant)` | `assistant/message` + `tool/call` + `tool/result` | 推理/正文/tool 块分别映射；工具入参与输出进 `tool/call`/`tool/result` |
| `session_message(type=idle)` | `turn/end` | 用 OpenCode 的 idle 事件切分回合 |
| 模型信息 | `assistant/message.source` | `providerID`/`model.id` 原样保留 |
| `tokens` | `usage` | 输入/输出/缓存/推理 token |

会话 id 由 OpenCode 会话 id 经 SHA-256 派生（`session-<uuid>`），所以**同一个 OpenCode 会话永远对应同一个 DSH 会话**，重复导入天然幂等。

---

## 配置

`~/.dsh/opencode-session-sync.json`（首次运行自动写出默认值，改完重启生效）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册工具、不自动同步 |
| `dbPath` | 空 = `~/.local/share/opencode/opencode.db` | OpenCode 数据库位置 |
| `autoSyncOnStart` | `true` | 启动后自动导入 |
| `autoSyncDelayMs` | `4000` | 自动导入的延迟，避开启动高峰 |
| `includeChildren` | `false` | 是否导入 subagent 子会话 |
| `importLimit` | `200` | 单次最多处理多少个会话（按最近更新优先） |
| `titlePrefix` | `"[OC] "` | 标题前缀，设 `""` 就不加 |
| `agentPreset` | `"standard"` | 导入会话的 agent preset |
| `includeReasoning` | `true` | 是否保留推理块 |
| `includeToolCalls` | `true` | 是否保留工具调用 |
| `maxToolResultChars` | `200000` | 单个工具输出/文本块的最大字符数，超出截断并标注 |
| `createMissingWorkspaces` | `true` | 目标目录没有工作区时自动创建 |
| `onlyExistingDirectories` | `false` | 只导入目录在本机存在的会话 |

---

## 边界（说清楚的限制）

- **只做 OpenCode → DSH 单向导入。** 没有反向导出：那需要写 OpenCode 自己的 `opencode.db`，风险高且你没要求。
- **子会话默认不导入。** OpenCode 的 subagent 子会话在 DSH 里要变成「父会话下的子会话」还需要往父日志写 `subagent/catalog` 等事实，本版没做；`includeChildren: true` 会把它们当独立会话导入（会丢父子嵌套）。
- **旧格式正文不解析。** 如果某个会话只有 `message`/`part` 表、`session_message` 里没有行，会被标记为 `legacy-only` 并跳过（本机 36 个会话全部有新格式行，不受影响）。
- **这些 OpenCode 事件不导入**：`system`（工具变更通知）、`synthetic`（plan mode 等系统提醒）、`compaction`（压缩摘要）、`agent-switched`、`location-switched`。它们会在报告的 `skippedEvents` 里逐类计数，不静默丢失。
- **目录不存在或不是绝对路径**：会话仍会导入，但不会登记到任何工作区（报告里 `workspaceAction: unattached`）；也可以设 `onlyExistingDirectories: true` 直接跳过。
- **导入的会话是「冷会话」**：DSH 列表对冷会话只读持久化的投影缓存，所以插件写完日志后会补写一次 `sessionProjectionCache.coldSnapshot`，让侧边栏立刻拿到标题。这一步是 fail-soft 的，失败只会记警告（列表里仍是那一行，只是标题要等打开会话后才出现）。
- 导入的是**文本记录**，不是「可继续执行的现场」：工具调用会作为历史消息回放给模型，不会重新执行。
- 导入时间戳与 turn/step 结构是按 OpenCode 的 idle 边界重建的，`turn/end` 一律记为 `completed`。

---

## 依据

事件类别、字段与跨事件关系来自 DSH 自带包的**已发布规范**，不是猜的：

- `@deepseek-ai/dsh-session-format-v3-to-v4`（V4 接纳规则、表面事件、工具结果、`session/title`）
- `@deepseek-ai/dsh-session`（`SessionEventMap`、`invariant` 里的 turn/step 与 tool 调用关系校验）
- `@deepseek-ai/dsh-session-persistence` / `-jsonl`（`create`/`append`/`flush`/`close`、分桶目录、多帧 zstd）
- `@deepseek-ai/dsh-session-projection-cache`（`coldSnapshot` 的 fold 语义）
- `@deepseek-ai/dsh-workspace`（`attachSession`、`bootstrap` 的按 cwd 收纳）
- OpenCode 侧：本机 `opencode.db` 的 `session_v2` / `session_message` / `message` / `part` 表实测结构

另外用**真实 DSH 会话日志**（`~/.dsh/sessions/**/session.v4.jsonl.zstd`）反查了事件顺序模板：
`turn/start → step/start → user/message → assistant/message → tool/call → tool/result → step/end → turn/end`。

---

## 验证证据

三条测试都是可复现的命令（需要把 DSH 的 `app.asar` 解压到临时目录当「真实依赖树」）：

```powershell
$python = "C:\Users\ZJY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$node   = "C:\Users\ZJY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$dsh    = "$env:TEMP\dsh-asar\dsh"
& $python "C:\Users\ZJY\Desktop\dsh_ws\.oc-sync-tools\asar_extract.py" extract "dsh/" "$env:TEMP\dsh-asar"

node tools\selfcheck.mjs --all --e2e $dsh          # 离线转换 + 真实 DSH 写入/读回
node test\integration.mjs $dsh                      # 插件同步全流程 + 幂等 + 账本
node test\host-apply.mjs $dsh                       # 真实 Cordis 上下文里加载插件并调用工具
```

本机实测结果（2026-10-06，OpenCode 库 36 个会话）：

| 测试 | 结果 |
|---|---|
| `selfcheck --all --e2e` | 36/36 会话转换成功，7792 个事件；用**真实** DSH 持久化层全部写入并读回一致；结构 + 跨事件关系校验 0 问题 |
| `test/integration.mjs` | 第一次导入 2/2 成功、第二次全部判为已存在（幂等）、dry-run 不写盘、账本与报告落盘、读回事件数一致 |
| `test/host-apply.mjs` | 插件在真实 Cordis 上下文加载成功，工具 `opencode_sync` 注册成功，`list`/`import`/`status` 三个动作跑通，启动自动同步定时器触发 |
| `tools/verify-install.mjs` | profile 依赖、bundles、junction、patch、入口全部就位 |

---

## 卸载

1. 从 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `dsh-opencode-session-sync`（备份见 `package.json.bak-before-opencode-sync`）。
2. 删除 `~/.dsh/profiles/desktop/node_modules/dsh-opencode-session-sync`（junction，删除不会动源码）。
3. 重启 DSH。
4. 想连导入的会话一起清掉，就到对应工作区的 `~/.dsh/sessions/--<目录名>--/session-*/` 删除那些 `session.v4.jsonl.zstd`（id 记在 `~/.dsh/opencode-session-sync/state.json`）。

---

## 目录结构

```
lib/opencode-db.js   OpenCode SQLite 只读层
lib/convert.js       OpenCode 会话 → DSH V4 事件（纯函数，无宿主依赖）
lib/ledger.js        配置 / 账本 / 报告落盘
lib/sync.js          同步编排：写持久化 + 登记工作区 + 补投影缓存
lib/index.js         插件入口：注册 opencode_sync 工具 + 启动自动同步
tools/selfcheck.mjs  离线盘点 + 转换 + 结构校验（--e2e 用真实 DSH 层端到端）
tools/verify-install.mjs  安装自检
test/integration.mjs 同步全流程集成测试
test/host-apply.mjs  宿主装配测试（真实 Cordis + 真实持久化）
```
