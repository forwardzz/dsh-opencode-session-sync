# dsh-opencode-session-sync

[![CI](https://github.com/forwardzz/dsh-opencode-session-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/forwardzz/dsh-opencode-session-sync/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg)](https://nodejs.org)

**把 OpenCode 桌面端的历史会话，按各自原本的工作目录，导入成 DeepSeek Harness 的原生会话。**

导入后的会话会出现在 DSH 对应工作区的会话列表里，带原标题、原时间、原模型和完整对话内容，
可以直接打开查看、继续追问。

- **OpenCode 侧只读** —— 只打开 `opencode.db` 读，从不写它。
- **生成的是原生会话** —— 写入交给 DSH 自己的会话持久化层，格式与跨事件关系由 DSH 本体校验。
- **自动归位到工作区** —— 会话按它原本的工作目录落到对应工作区；那个目录还没有工作区时会自动建一个。
- **幂等** —— 同一个 OpenCode 会话永远映射到同一个 DSH 会话，重复运行不会产生副本。

---

## 安装

需要 DSH（DeepSeek Harness）已装好并能正常启动，Node.js ≥ 22.5（DSH 能跑就满足）。

**方式一：插件管理命令（如果你的 DSH 版本支持）**

```sh
git clone https://github.com/forwardzz/dsh-opencode-session-sync.git
dsh plugin --profile desktop add link:<clone 出来的绝对路径>
```

**方式二：手工三步（等价，Windows 用目录联接）**

1. 克隆到任意目录，并在 profile 的 `node_modules` 下建好链接：

   ```powershell
   git clone https://github.com/forwardzz/dsh-opencode-session-sync.git "$env:USERPROFILE\.dsh\plugins\dsh-opencode-session-sync"
   New-Item -ItemType Junction `
     -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-opencode-session-sync" `
     -Target "$env:USERPROFILE\.dsh\plugins\dsh-opencode-session-sync"
   ```

   macOS / Linux 把最后一步换成 `ln -s <clone 路径> ~/.dsh/profiles/desktop/node_modules/dsh-opencode-session-sync`。

2. 编辑 `~/.dsh/profiles/desktop/package.json`，加依赖：

   ```json
   "dependencies": {
     "dsh-opencode-session-sync": "link:<clone 出来的绝对路径>"
   }
   ```

   也可以直接在该 profile 目录里执行 `pnpm install`，由 `link:` 声明生成链接。

3. 把 `"dsh-opencode-session-sync"` 加到同一个文件的 `dsh.profile.bundles` 数组末尾。

装完 **重启 DeepSeek Harness** 生效（插件在启动时挂载，加插件或改配置都不会热加载）。

不确定装好没有？在插件目录里跑一次安装自检，它会逐项检查依赖声明、bundles、链接、patch 和入口：

```sh
node tools/verify-install.mjs
```

---

## 使用

### 自动同步（默认）

插件在 DSH 启动约 4 秒后自动导入一次，之后每次启动只补齐新会话，已导入的跳过。不需要任何操作。

想确认结果，看这两个文件：

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/opencode-session-sync/last-run.json` | 最近一次导入的完整报告（每个会话的结果与原因） |
| `~/.dsh/opencode-session-sync/state.json` | 已导入账本（OpenCode 会话 id → DSH 会话 id） |

### 手动同步：`opencode_sync` 工具

插件给 agent 注册了一个工具 `opencode_sync`，直接在对话里说就行：

| action | 作用 | 主要参数 |
| --- | --- | --- |
| `list` | **只读**盘点：OpenCode 有哪些会话、会落到哪个工作区、是否已导入 | `workspace`、`limit`、`includeChildren` |
| `import` | 执行导入（默认幂等） | `dryRun`、`force`、`workspace`、`sessionIds`、`limit`、`includeChildren` |
| `status` | 账本与最近一次结果 | — |

可以直接这样说：

- 「列出 OpenCode 里有、但 DSH 里还没有的会话」
- 「先 dry-run 看一下会导入什么」
- 「只把 `dsh_ws` 相关的 OpenCode 会话导进来」
- 「把某个指定会话重新导一遍」（`force: true`）

### 命令行自检

不启动 DSH 也能检查转换结果（只读，不写任何东西）：

```sh
node tools/selfcheck.mjs              # 盘点 + 转换 + 结构校验
node tools/selfcheck.mjs --limit 5    # 只看最近 5 个会话
node tools/selfcheck.mjs --all        # 连子会话一起转换
node tools/selfcheck.mjs --db <路径>  # 指定 OpenCode 数据库
```

退出码：`0` 通过 / `1` 发现问题（逐条列出） / `2` 环境不满足（比如本机没有 OpenCode 数据库）。

---

## 配置

配置写在 `~/.dsh/opencode-session-sync.json`，首次运行自动生成默认值，改完重启生效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册工具、不自动同步 |
| `dbPath` | 空（用默认位置） | OpenCode 数据库路径 |
| `autoSyncOnStart` | `true` | 启动后自动导入一次 |
| `autoSyncDelayMs` | `4000` | 自动导入的延迟，避开启动高峰 |
| `includeChildren` | `false` | 是否导入 subagent 子会话 |
| `importLimit` | `200` | 单次最多处理多少个会话（按最近更新优先） |
| `titlePrefix` | `"[OC] "` | 标题前缀，设 `""` 就不加 |
| `agentPreset` | `"standard"` | 导入会话使用的 agent preset |
| `includeReasoning` | `true` | 是否保留推理块 |
| `includeToolCalls` | `true` | 是否保留工具调用 |
| `maxToolResultChars` | `200000` | 单个工具输出/文本块的最大字符数，超出会截断并标注 |
| `createMissingWorkspaces` | `true` | 目标目录还没有工作区时自动创建 |
| `onlyExistingDirectories` | `false` | 只导入目录在本机存在的会话 |

默认的 OpenCode 数据库位置：

- Windows：`%USERPROFILE%\.local\share\opencode\opencode.db`
- macOS / Linux：`~/.local/share/opencode/opencode.db`

---

## 会话与工作区怎么对应

| OpenCode | DSH | 说明 |
| --- | --- | --- |
| `session_v2.directory` | `SessionHeader.cwd` | 决定会话落在哪个工作区，例如 `C:/Users/me/proj` → 工作区 `C:\Users\me\proj` |
| （由 cwd 决定） | 工作区注册表 | 写入后把会话登记进该目录对应的工作区；目录没有工作区就新建一个 |
| `session_v2.title` | `session/title` 事件 | 默认加 `[OC] ` 前缀，便于和 DSH 原生会话区分 |
| `session_v2.time_created` | `SessionHeader.createdAt` | 保留原始创建时间，列表按真实时间排序 |
| `session_message`（user） | `user/message` | 用户消息正文 |
| `session_message`（assistant） | `assistant/message` + `tool/call` + `tool/result` | 推理、正文、工具调用分别映射；工具入参和输出一并保留 |
| `session_message`（idle） | `turn/end` | 用 OpenCode 的 idle 事件切分回合 |
| 模型信息 | `assistant/message.source` | `providerID` / `model.id` 原样保留 |
| `tokens` | `usage` | 输入 / 输出 / 缓存 / 推理 token |

会话 id 由 OpenCode 会话 id 经 SHA-256 派生，所以对应关系稳定，重复导入天然幂等。

---

## 实现要点

- **不拼字节**：写入调用 DSH 的 `ctx.sessionPersistence`（`create` → `append` → `flush` → `close`），
  事件类别、字段和跨事件关系（turn/step 顺序、工具调用结算、表面事件语义）全部由 DSH 本体校验。
  这样即使 DSH 升级会话格式，插件也不需要跟着改字节。
- **归位靠 `cwd`**：DSH 的会话存储本身就按 cwd 分桶，所以只要 header 的 `cwd` 正确，
  会话就会落进对应工作区的目录；再用 `workspaceRegistry` 把 id 登记进该工作区的账目。
- **补写投影缓存**：导入的会话是「冷会话」，DSH 列表对冷会话只读持久化的投影缓存，
  所以写完日志后会补写一次 `sessionProjectionCache.coldSnapshot`，让侧边栏立刻就有标题。

---

## 限制

- **只做单向导入**（OpenCode → DSH）。没有反向导出：那需要写 OpenCode 自己的数据库，风险高。
- **子会话默认不导入**。OpenCode 的 subagent 子会话要在 DSH 里还原成「父会话下的子会话」，
  还需要往父日志写 `subagent/catalog` 等事实，本版没做；`includeChildren: true` 会把它们当独立会话导入（会丢父子嵌套）。
- **旧格式正文不解析**。如果某个会话只有 `message` / `part` 表、`session_message` 里没有行，会被标记为
  `legacy-only` 并在报告里跳过。
- **这些 OpenCode 事件不导入**：`system`（工具变更通知）、`synthetic`（系统提醒）、
  `compaction`（压缩摘要）、`agent-switched`、`location-switched`。
  它们会在报告的 `skippedEvents` 里逐类计数，不会静默消失。
- **目录不存在或不是绝对路径**时，会话仍会被导入，但不会登记到任何工作区（报告里记为 `unattached`）；
  也可以设 `onlyExistingDirectories: true` 直接跳过这类会话。
- **导入的是文本记录，不是可继续执行的现场**：工具调用会作为历史消息回放给模型，不会重新执行。

---

## 开发与测试

```sh
npm test                          # 单元测试（fixture 驱动，不需要 OpenCode 数据库）
node tools/selfcheck.mjs          # 对着本机真实的 OpenCode 库做一次转换 + 结构校验
node tools/verify-install.mjs     # 检查插件是否装好（依赖、bundles、链接、patch、入口）
```

单元测试覆盖：事件序列与编号、turn/step 切分、工具调用与报错结果、重复 callId 改写、
空助手行跳过、推理块开关、超长输出截断、标题回退、目录规范化、模型信息回退等；
每个用例都额外跑一遍 `lib/validate.js` 的结构 + 跨事件关系校验。

`test/integration.mjs` 与 `test/host-apply.mjs` 是更强的端到端测试，需要把 DSH 的
`resources/app.asar` 解压出来当「真实依赖树」：前者用 DSH 真实的会话持久化层跑完整同步流程
（含幂等与账本），后者在真实的 Cordis 上下文里加载插件并调用工具。用法见文件头部注释。

CI 在 Ubuntu 与 Windows、Node 22 与 24 上跑：全部文件语法检查、单元测试，
以及「本机没有 OpenCode 数据库时自检脚本应给出提示并退出 2」的行为检查。

---

## 卸载

1. 从 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `dsh-opencode-session-sync`。
2. 删掉 `~/.dsh/profiles/<profile>/node_modules/dsh-opencode-session-sync` 这个链接（删链接不会动克隆出来的源码）。
3. 重启 DSH。

想连导入的会话一起清掉：删掉对应工作区里那些 `~/.dsh/sessions/--<目录名>--/session-*/session.v4.jsonl.zstd`，
会话 id 记在 `~/.dsh/opencode-session-sync/state.json` 里。

---

## 许可

[MIT](./LICENSE) © forwardzz
