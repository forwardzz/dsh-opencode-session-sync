<div align="center">

# DSH OpenCode Session Sync

**把 OpenCode 桌面端的聊天记录导入 DeepSeek Harness，成为原生会话：按会话原本的工作目录归位，并随着源会话继续增长而保持同步。**

[English](README.md) · [安装](#安装) · [使用](#使用) · [配置](#配置) · [常见问题](#常见问题) · [更新日志](CHANGELOG.md) · [MIT](LICENSE)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/forwardzz/dsh-opencode-session-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/forwardzz/dsh-opencode-session-sync/actions/workflows/ci.yml)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

> 本插件是社区维护的 DeepSeek Harness 插件，不是 DeepSeek 官方产品。它只读 OpenCode 的本地数据库，并通过 DSH 自己的会话持久化层写入，因此导入后就是原生会话：出现在与其原始工作目录对应的工作区里，可以打开、继续对话。

## 功能

- **OpenCode 侧只读** —— 只打开 `opencode.db` 读，从不写它。
- **原生会话，不是旁挂文件** —— 写入走 DSH 自己的 `sessionPersistence`（`create` → `append` → `flush`），格式与跨事件关系由 DSH 校验；插件不自己拼日志字节。
- **按工作区归位** —— 会话原本的目录成为它的 `cwd`（DSH 正是按 `cwd` 归档会话），插件会把会话登记进对应工作区；该目录还没有工作区时会自动创建。
- **增量同步** —— 首次导入之后，你在 OpenCode 里继续产生的回合会被**追加**进同一个 DSH 会话，`turn` 与 `seq` 都接在既有日志之后；`dryRun` 可以只看计划不写盘。
- **幂等** —— DSH 会话 id 由 OpenCode 会话 id 派生，日志本身也记录了哪些源行已经在里面，所以重复运行不会产生副本；账本丢了也不会。
- **拒绝不安全的追加** —— 源会话若被回退或改写，插件报 `diverged` 并说明原因，而不是拼出一份错乱的记录。
- **自动或手动** —— DSH 启动后自动同步一次；同时注册 agent 工具 `opencode_sync`（`list` / `import` / `status`）。
- **保留关键信息** —— 标题、创建时间、模型与提供方、token 用量、推理块、工具调用及其输出与报错。
- **零运行时依赖** —— 只用 Node 内置模块；读 SQLite 用 `node:sqlite`，与 DSH 自己的会话索引同一个模块。

## 前置条件

- 已安装并能正常启动的 DeepSeek Harness，且宿主提供 `tools` 与 `sessionPersistence` 服务（`workspaceRegistry` 与 `sessionProjectionCache` 有就用、没有就跳过）。
- Node.js 22.5 或更新（`node:sqlite`）。
- 同机的 OpenCode 桌面端，且本地数据库存在（默认路径见[配置](#配置)）。
- 已在 Windows + DSH `0.2.0-rc.2` 上验证。

## 安装

### 让 agent 帮你装（推荐）

把下面这段发给能执行命令的 agent，把 `desktop` 换成你的 profile 名。

```text
把 DeepSeek Harness 插件 https://github.com/forwardzz/dsh-opencode-session-sync 装进我的 desktop profile：
1. 克隆到你选的目录；
2. 在 ~/.dsh/profiles/desktop/package.json 里加一条指向该目录的 link: 依赖，并把包名追加到 dsh.profile.bundles；
3. 在 ~/.dsh/profiles/desktop/node_modules/dsh-opencode-session-sync 建好指向该克隆目录的链接；
4. 在克隆目录里执行 `node tools/verify-install.mjs`，告诉我是否通过。
不要自己重启 DSH，我来重启。
```

### 从克隆安装

Windows（目录联接不需要管理员权限）：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

git clone https://github.com/forwardzz/dsh-opencode-session-sync.git "$env:USERPROFILE\.dsh\plugins\dsh-opencode-session-sync"
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-opencode-session-sync" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-opencode-session-sync"
```

然后编辑 `~/.dsh/profiles/desktop/package.json`：

<details>
<summary>profile 里要改什么，以及 macOS / Linux 的等价做法</summary>

```jsonc
{
  "dependencies": {
    "dsh-opencode-session-sync": "link:/克隆目录的绝对路径"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …已有的 bundles…
        "dsh-opencode-session-sync"
      ]
    }
  }
}
```

macOS / Linux 把联接换成软链接，`link:` 路径按平台写法填：

```sh
git clone https://github.com/forwardzz/dsh-opencode-session-sync.git ~/.dsh/plugins/dsh-opencode-session-sync
ln -s ~/.dsh/plugins/dsh-opencode-session-sync ~/.dsh/profiles/desktop/node_modules/dsh-opencode-session-sync
```

在该 profile 目录里执行 `pnpm install` 等价：它会按 `link:` 声明生成链接。如果你的安装带 `dsh` CLI，`dsh plugin --profile desktop add link:<绝对路径>` 就是这三步的合并写法。

</details>

### 重启并验证

插件在启动时挂载，所以**重启一次 DeepSeek Harness**；加插件或改配置都不会热加载。

在克隆目录里做一次端到端检查（依赖声明、bundles、链接指向、patch 文件、入口模块）：

```sh
node tools/verify-install.mjs
```

它只读。通过说明 DSH 能找到并加载这个插件，但不代表它此刻已经加载。

## 使用

### 自动同步（默认）

启动约 4 秒后自动导入一次，之后每次启动把新增内容追加进去。不需要任何操作。

结果记在两个文件里：

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/opencode-session-sync/last-run.json` | 最近一次同步的完整报告，逐会话带结果与原因 |
| `~/.dsh/opencode-session-sync/state.json` | 账本：OpenCode 会话 id → DSH 会话 id，以及最后导入的源行 |

### 手动同步：`opencode_sync` 工具

插件注册了一个 agent 工具，在对话里说就行：

| `action` | 作用 | 主要参数 |
| --- | --- | --- |
| `list` | **只读**盘点：有哪些 OpenCode 会话、各自对应哪个工作区、还有多少条待同步 | `workspace`、`limit`、`includeChildren` |
| `import` | 执行同步：新会话导入，已有会话追加新回合 | `dryRun`、`workspace`、`sessionIds`、`limit`、`includeChildren` |
| `status` | 账本与最近一次结果 | — |

可以直接这样说：

- 「列出 OpenCode 里有、但 DSH 里还没有的会话」
- 「先 dry-run 看一下这次会做什么」
- 「只同步 `my-project` 相关的会话」

`list` 会把两边都读一遍，所以它的状态列就等于 `import` 会做的事：`待导入`（会新建）、`有新内容`（会追加，带条数）、`已同步`、`无正文`。

### 命令行自检

不启动 DSH 也能转换并校验（只读，不写任何东西）：

```sh
node tools/selfcheck.mjs              # 盘点 + 转换 + 结构校验
node tools/selfcheck.mjs --limit 5    # 只看最近更新的 5 个
node tools/selfcheck.mjs --all        # 连 subagent 子会话一起
node tools/selfcheck.mjs --db <路径>  # 指定 OpenCode 数据库
```

退出码：`0` 通过 / `1` 发现问题（逐条列出） / `2` 环境不满足（例如本机没有 OpenCode 数据库）。

## 配置

配置写在 `~/.dsh/opencode-session-sync.json`，首次运行自动生成默认值，改完重启生效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 后插件完全不动：不注册工具、不同步 |
| `dbPath` | 空（用默认位置） | OpenCode 数据库路径 |
| `autoSyncOnStart` | `true` | 启动后同步一次 |
| `autoSyncDelayMs` | `4000` | 首次同步的延迟，避开启动高峰 |
| `includeChildren` | `false` | 是否同时导入 subagent 子会话 |
| `importLimit` | `200` | 单次最多处理多少个会话（按最近更新优先） |
| `titlePrefix` | `"[OC] "` | 标题前缀，设 `""` 就不加 |
| `agentPreset` | `"standard"` | 导入会话记录的 agent preset |
| `includeReasoning` | `true` | 是否保留推理块 |
| `includeToolCalls` | `true` | 是否保留工具调用 |
| `maxToolResultChars` | `200000` | 单个块的字符上限，超出截断并标注 |
| `createMissingWorkspaces` | `true` | 目标目录没有工作区时自动创建 |
| `onlyExistingDirectories` | `false` | 目录在本机不存在的会话直接跳过 |

OpenCode 数据库默认位置：

- Windows：`%USERPROFILE%\.local\share\opencode\opencode.db`
- macOS / Linux：`~/.local/share/opencode/opencode.db`

## 会话与工作区怎么对应

| OpenCode | DSH | 说明 |
| --- | --- | --- |
| `session_v2.directory` | `SessionHeader.cwd` | 决定归到哪个工作区，例如 `C:/Users/me/proj` → 工作区 `C:\Users\me\proj` |
| （由 `cwd` 决定） | 工作区注册表 | 会话被登记进该工作区的列表；目录没有工作区就创建 |
| `session_v2.title` | `session/title` 事件 | 默认加前缀，便于与原生会话区分 |
| `session_v2.time_created` | `SessionHeader.createdAt` | 保留原始创建时间，列表按真实时间排序 |
| `session_message`（`user`） | `user/message` | 用户正文 |
| `session_message`（`assistant`） | `assistant/message` + `tool/call` + `tool/result` | 推理、正文、工具块分别映射；工具入参与输出都保留 |
| `session_message`（`idle`） | `turn/end` | OpenCode 的 idle 行正是切分回合的依据 |
| 模型信息 | `assistant/message.source` | `providerID` / `model.id` 原样保留 |
| `tokens` | `usage` | 输入 / 输出 / 缓存 / 推理 token |

### 增量同步到底追加什么

已导入会话从 DSH 日志本身识别：插件把 OpenCode 的行 id 写进了消息 id，因此能判断哪些源行已经在日志里。一次同步会：

1. 检查已导入的行是否仍是源的前缀（不是就判 `diverged`，见[常见问题](#常见问题)）；
2. 从最后一条已导入的行之后切开源，同时保留用于切分回合的 `idle` 行；
3. 构造接续事件——`seq` 从既有日志的最后一条往下排，`turn` 号从最后一个回合往下排；
4. 用 `open(id, 'write')` 追加，然后用完整日志刷新投影缓存。

只会追加尾部，已经写进 DSH 会话的历史不会被改写。

## 常见问题

**`verify-install.mjs` 报缺少依赖或 bundles 条目。** profile 没改到，或者改的是另一个 profile。确认你实际运行的 profile 里，`dependencies` 与 `dsh.profile.bundles` 都写了 `dsh-opencode-session-sync`。

**装好了，但看起来 DSH 没有加载。** 插件在启动时挂载，请重启应用，然后在输出里找 `[opencode-session-sync]` 开头的行。解析失败的 bundle 会被跳过并告警，不会让启动失败，所以「静默跳过」是可能的——`verify-install.mjs` 正是用来区分这两种情况的。

**什么都没导入。** 先看 `last-run.json`。常见原因：数据库路径不对（`dbPath`）、`enabled` 为 `false`、该会话在 `session_message` 里没有行（见下条）、目录在本机不存在且开了 `onlyExistingDirectories`。

**某个会话被跳过并标记为 legacy-only。** 它只有旧格式（`message` / `part` 表）的正文，`session_message` 里没有行。本插件不解析那种布局，会选择如实报告而不是猜。

**会话导入成功，但工作区列表里没有。** 工作区登记发生在同步时。如果登记失败（报告里有 `unattached` 警告），重启 DSH——工作区注册表启动时会收纳所有 `cwd` 落在它下面的会话。

**列表里有行但没有标题。** 列表对冷会话读的是持久投影缓存，插件每次写入后都会刷新它。若刷新失败会在报告里记一条警告，打开该会话后标题就会出现。

**某个会话报 `diverged`。** 源会话被回退或改写（或旧账本与当前不一致），此时追加会拼出一份从未存在过的记录，插件选择跳过。要导入新的形态，请删掉对应的 DSH 会话再同步一次——文件位置见[卸载](#卸载)。

**升级插件后想重新导入老会话。** DSH 的会话持久化没有删除接口，插件无法改写已存在的会话。请停止 DSH，删掉 `~/.dsh/sessions/--<工作区>--/` 下那个会话目录（id 在 `last-run.json` 与 `state.json` 里），再启动 DSH。

## 执行边界

插件只读 OpenCode 数据库，只通过 DSH 的会话持久化写入；不会改动 `opencode.db`、OpenCode 配置，或 `~/.dsh` 之外的任何文件。

**导入是单向的、纯文本的。** 没有回写 OpenCode 的反向导出。导入结果是忠实记录，不是可继续执行的现场：工具调用只作为历史回放给模型，不会重新执行。

**subagent 子会话默认不导入。** 要在 DSH 里还原 OpenCode 的父子嵌套，需要往父日志写 `subagent/catalog` 等事实，本插件不做。`includeChildren: true` 会把它们当独立会话导入，父子嵌套会丢失。

**回退检测依赖账本。** 仅凭日志就能知道哪些行已导入，所以账本丢了也不会重复导入；但「源被回退、又在新分支上继续增长」这种情况只有账本里的 `lastRowId` 能识别。请保留 `state.json`。

<details>
<summary>事件映射细节、投影缓存，以及哪些内容不导入</summary>

**不导入的内容。** OpenCode 的 `system`（工具变更通知）、`synthetic`（plan mode 之类的系统提醒）、`compaction`（压缩摘要）在这里没有忠实的 DSH 等价物，因此跳过；`agent-switched`、`location-switched` 同样跳过。每一类跳过都会计入报告的 `skippedEvents`，不会静默消失。

**回合与步骤结构。** OpenCode 的 `idle` 行划出回合边界；一个回合内，用户消息与助手回复同属一个 step，再出现用户消息则开下一个 step。这与 DSH 自己写出的形状一致，也是 `lib/validate.js` 里那些检查所断言的。

**为什么走 DSH 自己的写入器。** `sessionPersistence.create()` / `open(id, 'write')` 会校验每个事件以及事件之间的关系，并且由后端负责物理分帧（一份日志是一串独立的 zstd 帧）。直接写字节会在下一次会话格式变更时失效；走写入器意味着插件完全不携带格式实现。

**为什么要刷投影缓存。** 直接写进存储的会话是**冷会话**。DSH 的会话列表对冷会话是从持久投影缓存里取的，不刷就会缺标题。插件每次写入后用完整日志调用一次 `sessionProjectionCache.coldSnapshot(header, 0, log)`，由它折叠并落盘。这一步是 fail-soft 的：失败只记一条警告，代价是打开该会话之前没有标题。

**截断。** 超过 `maxToolResultChars` 的块会被截断并附上标记（`[已截断 N 个字符，原始长度 M]`）且计入报告，避免过大的工具输出悄悄扭曲记录。

</details>

## 卸载

1. 从 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-opencode-session-sync`。
2. 删掉 `~/.dsh/profiles/<profile>/node_modules/dsh-opencode-session-sync` 这个链接（删链接不会动克隆出来的源码）。
3. 重启 DSH。

已导入的会话会留在原处。若也要清掉，删除相应的 `~/.dsh/sessions/--<工作区>--/session-*/session.v4.jsonl.zstd` 目录——id 列在 `~/.dsh/opencode-session-sync/state.json` 里。卸载不会撤销插件已经导入的内容。

## 开发

```sh
npm test                          # 单元测试（fixture 驱动，不需要 OpenCode 数据库）
node tools/selfcheck.mjs          # 对着真实 OpenCode 库转换并校验
node tools/verify-install.mjs     # 检查插件是否已装进某个 profile
```

单元测试覆盖：事件序列与编号、turn/step 切分、工具调用与报错结果、重复 call id、推理块与截断开关、标题回退与改名、目录规范化、模型信息回退，以及增量追加规则（seq 与 turn 接续、idle 决定轮边界、空追加）。每个用例都额外跑一遍 `lib/validate.js` 的结构与跨事件关系检查。

三个更强的套件需要把 DSH 应用解压出来当真实依赖树（`resources/app.asar`，本插件所在工作区里有解压脚本）：

```sh
node test/integration.mjs <dshDir> <opencodeDb>   # 完整同步流程、幂等、账本、分桶
node test/host-apply.mjs  <dshDir> <opencodeDb>   # 在真实 Cordis 上下文里加载插件并调用工具
node test/incremental.mjs <dshDir>                # 导入 → 增长 → 追加 → 无变化 → 回退（合成库）
```

`test/incremental.mjs` 自己按真实表结构建一个 `opencode.db`，因此能在测试中途让源会话增长——真实库做不到这一点。

CI 在 Ubuntu 与 Windows、Node 22 与 24 上跑：全文件语法检查、单元测试，以及「本机没有 OpenCode 数据库时自检脚本应给出提示并退出 2」的行为检查。

| 路径 | 职责 |
| --- | --- |
| `lib/opencode-db.js` | 只读访问 `opencode.db` |
| `lib/convert.js` | 会话行 → DSH 事件；首次导入与追加两种计划 |
| `lib/validate.js` | 结构 + 跨事件关系校验，测试与自检共用 |
| `lib/sync.js` | 编排：读既有日志、决策、写入、登记工作区、刷缓存 |
| `lib/ledger.js` | 配置、账本、运行报告落盘 |
| `lib/index.js` | 插件入口：注册 `opencode_sync`、跑启动同步 |
| `tools/`、`test/` | 自检脚本与上面的测试套件 |

## 许可

[MIT](LICENSE) © forwardzz
