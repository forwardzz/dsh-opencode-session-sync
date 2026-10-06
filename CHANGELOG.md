# Changelog

## 0.1.0

首个版本。

- 只读 OpenCode 桌面端的 `opencode.db`，把会话按各自原本的工作目录导入成 DSH 原生会话。
- 写入走 DSH 自己的 `sessionPersistence`，格式与跨事件关系由 DSH 校验；写入后刷新投影缓存，让列表立刻有标题。
- 首次导入后支持增量同步：源会话新增的回合会按 `idle` 边界追加进同一个 DSH 会话，`seq` 与 `turn` 号接续既有日志；`dryRun` 可只看计划。
- 幂等：DSH 会话 id 由 OpenCode 会话 id 派生，日志本身记录已导入的源行，重复运行不会产生副本。
- 源会话被回退或改写时报 `diverged` 并跳过，不拼出错误记录。
- 注册 agent 工具 `opencode_sync`（`list` / `import` / `status`），并在启动后自动同步一次。
- 零运行时依赖：只用 Node 内置模块，SQLite 走 `node:sqlite`。
