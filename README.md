<div align="center">

# DSH OpenCode Session Sync

**Bring OpenCode desktop chat history into DeepSeek Harness as native sessions — filed under the workspace each session came from, and kept up to date as those sessions grow.**

[简体中文](README.zh-CN.md) · [Installation](#installation) · [Usage](#usage) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Changelog](CHANGELOG.md) · [MIT](LICENSE)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/forwardzz/dsh-opencode-session-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/forwardzz/dsh-opencode-session-sync/actions/workflows/ci.yml)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

> DSH OpenCode Session Sync is a community-maintained DeepSeek Harness plugin, not an official DeepSeek AI product. It reads the OpenCode desktop database (read-only) and writes sessions into DSH through DSH's own session persistence, so imported sessions are native: they land in the workspace matching their original working directory, and they can be reopened and continued.

## Features

- **Read-only on the OpenCode side** — opens `opencode.db` to read and never writes it.
- **Native sessions, not a side file** — writes through DSH's own `sessionPersistence` (`create` → `append` → `flush`), so DSH validates the format and the cross-event relationships. The plugin never assembles log bytes itself.
- **Filed under the right workspace** — a session's original directory becomes its `cwd`, which is how DSH files sessions; the matching workspace is registered automatically, and created if that directory has no workspace yet.
- **Incremental sync** — after the first import, turns you add in OpenCode later are appended to the same DSH session, with `turn` and `seq` continuing the existing log. `dryRun` shows what a sync would do without writing anything.
- **Idempotent** — the DSH session id is derived from the OpenCode session id, and the log itself records which source rows are already in it, so re-running never duplicates. A deleted ledger does not cause duplicates either.
- **Refuses unsafe appends** — if the source session was rewound or rewritten, the plugin reports `diverged` with the reason instead of appending a garbled transcript.
- **Automatic or on demand** — syncs shortly after DSH starts, and exposes an agent tool (`opencode_sync`) with `list`, `import` and `status`.
- **Keeps what matters** — title, creation time, model and provider, token usage, reasoning blocks, and tool calls with their outputs and errors.
- **Zero runtime dependencies** — Node built-ins only. The OpenCode database is read with `node:sqlite`, the same module DSH uses for its own session index.

## Prerequisites

- DeepSeek Harness installed and starting normally, with a host that provides the `tools` and `sessionPersistence` services. `workspaceRegistry` and `sessionProjectionCache` are used when present and skipped when not.
- Node.js 22.5 or newer, for `node:sqlite`.
- OpenCode desktop on the same machine, with its local database (default paths under [Configuration](#configuration)).
- Verified against DSH `0.2.0-rc.2` on Windows.

## Installation

### Ask an agent to install it (recommended)

Send this to an agent that can run commands on your machine. Replace `desktop` with your profile name.

```text
Install the DeepSeek Harness plugin from https://github.com/forwardzz/dsh-opencode-session-sync into my desktop profile:
1. clone it into a directory of your choice;
2. in ~/.dsh/profiles/desktop/package.json add a link: dependency pointing at that directory and append the package name to dsh.profile.bundles;
3. create the link at ~/.dsh/profiles/desktop/node_modules/dsh-opencode-session-sync pointing at the clone;
4. run `node tools/verify-install.mjs` in the clone and tell me whether it reports success.
Do not restart DSH yourself — I will do that.
```

### Install from a clone

Windows (a directory junction needs no admin rights):

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

git clone https://github.com/forwardzz/dsh-opencode-session-sync.git "$env:USERPROFILE\.dsh\plugins\dsh-opencode-session-sync"
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-opencode-session-sync" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-opencode-session-sync"
```

Then edit `~/.dsh/profiles/desktop/package.json`:

<details>
<summary>Profile edits, and the macOS / Linux equivalents</summary>

```jsonc
{
  "dependencies": {
    "dsh-opencode-session-sync": "link:/absolute/path/to/dsh-opencode-session-sync"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // … existing bundles …
        "dsh-opencode-session-sync"
      ]
    }
  }
}
```

macOS / Linux: replace the junction step with a symlink, and use the same `link:` path spelled for your platform.

```sh
git clone https://github.com/forwardzz/dsh-opencode-session-sync.git ~/.dsh/plugins/dsh-opencode-session-sync
ln -s ~/.dsh/plugins/dsh-opencode-session-sync ~/.dsh/profiles/desktop/node_modules/dsh-opencode-session-sync
```

Running `pnpm install` in the profile directory is equivalent: it materializes the link from the `link:` declaration. If your installation provides the `dsh` CLI, `dsh plugin --profile desktop add link:<absolute path>` is the same three steps in one command.

</details>

### Reload and Verify

Plugins are mounted at startup, so **restart DeepSeek Harness**. Adding a plugin or editing its config is not hot-reloaded.

From the clone, check the installation end to end (dependency, bundles entry, link target, patch file, entry module):

```sh
node tools/verify-install.mjs
```

It only reads. A passing run means DSH will find and load the plugin; it does not prove the plugin has already loaded.

## Usage

### Automatic sync (default)

About 4 seconds after startup the plugin imports once, then appends anything new on each later start. No action needed.

Two files record what happened:

| File | Contents |
| --- | --- |
| `~/.dsh/opencode-session-sync/last-run.json` | Full report of the most recent sync, per session, with reasons |
| `~/.dsh/opencode-session-sync/state.json` | Ledger: OpenCode session id → DSH session id, plus the last source row imported |

### Manual sync: the `opencode_sync` tool

The plugin registers one agent tool. Ask in conversation, or call it directly:

| `action` | What it does | Main parameters |
| --- | --- | --- |
| `list` | **Read-only** inventory: which OpenCode sessions exist, what workspace each maps to, and how many rows are still pending | `workspace`, `limit`, `includeChildren` |
| `import` | Syncs: new sessions are imported, existing ones get their new turns appended | `dryRun`, `workspace`, `sessionIds`, `limit`, `includeChildren` |
| `status` | Ledger and the last run | — |

Things you can say:

- "List the OpenCode sessions that are not in DSH yet."
- "Dry-run a sync and show me what it would do."
- "Sync only the sessions from `my-project`."

`list` reads both sides, so its status column tells you exactly what an `import` would do: `待导入` (will be created), `有新内容` with a pending count (will be appended), `已同步`, or `无正文`.

### Command line self-check

Convert and validate without starting DSH (read-only, writes nothing):

```sh
node tools/selfcheck.mjs              # inventory + convert + structural checks
node tools/selfcheck.mjs --limit 5    # only the 5 most recently updated
node tools/selfcheck.mjs --all        # include subagent child sessions
node tools/selfcheck.mjs --db <path>  # point at a specific OpenCode database
```

Exit codes: `0` passed, `1` problems found (listed individually), `2` environment not satisfied (for example, no OpenCode database on this machine).

## Configuration

Configuration lives in `~/.dsh/opencode-session-sync.json`. Defaults are written on first run; changes take effect after a restart.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | When `false` the plugin does nothing at all: no tool, no sync |
| `dbPath` | empty (default location) | OpenCode database path |
| `autoSyncOnStart` | `true` | Sync once after startup |
| `autoSyncDelayMs` | `4000` | Delay before that first sync, to stay out of the startup path |
| `includeChildren` | `false` | Also import subagent child sessions |
| `importLimit` | `200` | At most this many sessions per run, newest first |
| `titlePrefix` | `"[OC] "` | Prefix added to imported titles; set `""` for none |
| `agentPreset` | `"standard"` | Agent preset recorded on imported sessions |
| `includeReasoning` | `true` | Keep reasoning blocks |
| `includeToolCalls` | `true` | Keep tool calls |
| `maxToolResultChars` | `200000` | Per-block character cap; longer blocks are truncated and marked |
| `createMissingWorkspaces` | `true` | Create a workspace when the target directory has none |
| `onlyExistingDirectories` | `false` | Skip sessions whose directory does not exist on this machine |

Default OpenCode database location:

- Windows: `%USERPROFILE%\.local\share\opencode\opencode.db`
- macOS / Linux: `~/.local/share/opencode/opencode.db`

## How sessions map to workspaces

| OpenCode | DSH | Notes |
| --- | --- | --- |
| `session_v2.directory` | `SessionHeader.cwd` | Decides the workspace, e.g. `C:/Users/me/proj` → workspace `C:\Users\me\proj` |
| (from `cwd`) | workspace registry | The session is registered in that workspace's list; the workspace is created if the directory has none |
| `session_v2.title` | `session/title` event | Prefixed by default so imported sessions stand out |
| `session_v2.time_created` | `SessionHeader.createdAt` | Original creation time is kept, so the list sorts by real time |
| `session_message` (`user`) | `user/message` | User text |
| `session_message` (`assistant`) | `assistant/message` + `tool/call` + `tool/result` | Reasoning, text and tool blocks are mapped separately; tool inputs and outputs are kept |
| `session_message` (`idle`) | `turn/end` | OpenCode's idle rows are what split turns |
| model info | `assistant/message.source` | `providerID` / `model.id` preserved |
| `tokens` | `usage` | Input, output, cache and reasoning tokens |

### What incremental sync appends

Already-imported sessions are recognised from the DSH log itself — the plugin writes the OpenCode row ids into the message ids, so it can tell which source rows are already present. A sync then:

1. checks that already-imported rows are still a prefix of the source (otherwise `diverged`, see [Troubleshooting](#troubleshooting));
2. cuts the source after the last imported row, keeping the `idle` rows that delimit turns;
3. builds events that continue the existing log — `seq` continues from the last event, `turn` numbers continue from the last turn;
4. appends them with `open(id, 'write')`, then refreshes the projection cache with the complete log.

Only the tail is ever appended. History already written to a DSH session is never rewritten.

## Troubleshooting

**`verify-install.mjs` reports a missing dependency or bundles entry.** The profile edit did not land, or you edited a different profile. Check that `dependencies` and `dsh.profile.bundles` both name `dsh-opencode-session-sync` in the profile you actually run.

**The plugin is installed, but DSH does not seem to load it.** Plugins mount at startup. Restart the app, then look for an `[opencode-session-sync]` line in its output. A bundle that fails to resolve is skipped with a warning instead of failing the boot, so a silent skip is possible — `verify-install.mjs` is what tells the two cases apart.

**Nothing was imported.** Check `last-run.json` first. Common reasons: the database path is wrong (`dbPath`), `enabled` is `false`, the session has no rows in `session_message` (see below), or the directory does not exist locally and `onlyExistingDirectories` is `true`.

**A session was skipped as "legacy-only".** That session has rows only in the older `message` / `part` tables and none in `session_message`. This plugin does not parse that layout; it reports the session instead of guessing.

**Sessions were imported, but the workspace list does not show them.** The workspace gets the session registered at sync time. If the registration failed (a `unattached` warning in the report), restarting DSH makes the workspace registry adopt every session whose `cwd` is under it.

**Rows appear without titles.** The list reads a persisted projection cache for cold sessions, which the plugin refreshes after each write. If that refresh failed it is recorded as a warning in the report, and the title appears once you open the session.

**A session reports `diverged`.** The source session was rewound or rewritten (or a ledger from an earlier import no longer matches), so appending would produce a transcript that never existed. The plugin skips it. To import the new shape, delete the corresponding DSH session and sync again — see [Uninstall](#uninstall) for the file layout.

**I upgraded the plugin and want to re-import an old session.** DSH's session persistence has no delete API, so the plugin cannot rewrite an existing session. Stop DSH, delete that session directory under `~/.dsh/sessions/--<workspace>--/` (the id is in `last-run.json` and `state.json`), then start DSH again.

## Execution Boundaries

The plugin only reads the OpenCode database and only writes through DSH's session persistence. It does not modify `opencode.db`, the OpenCode config, or any file outside `~/.dsh`.

**The import is one-way and text-only.** There is no reverse export back into OpenCode. Imported sessions are a faithful record, not a resumable execution state: tool calls are replayed to the model as history and are never re-executed.

**Subagent child sessions are not imported by default.** Reproducing OpenCode's parent/child nesting in DSH needs `subagent/catalog` facts written into the parent log, which this plugin does not do. `includeChildren: true` imports them as independent sessions and loses the nesting.

**Rewind detection needs the ledger.** The log alone proves which rows were imported, so a missing ledger still cannot cause duplicates. It can, however, miss a source that was rewound *and* extended on a different branch; that ledger entry (`lastRowId`) is what turns that case into `diverged`. Keep `state.json`.

<details>
<summary>Event mapping details, the projection cache, and what is not imported</summary>

**Not imported.** OpenCode rows of type `system` (tool-change notices), `synthetic` (harness reminders such as plan mode) and `compaction` (summaries) have no faithful DSH equivalent here, so they are skipped. `agent-switched` and `location-switched` are skipped as well. Every skipped type is counted in the report's `skippedEvents`, so nothing disappears silently.

**Turn and step structure.** OpenCode's `idle` rows delimit turns; within a turn, a user message and the assistant reply share one step, and a further user message opens the next step. That matches the shape DSH itself writes, which is what the checks in `lib/validate.js` assert.

**Why go through DSH's own writer.** `sessionPersistence.create()` / `open(id, 'write')` validate every event and the relationships between them, and the backend owns the framing (a log is a series of independent zstd frames). Writing bytes directly would break on the next session-format change; going through the writer means the plugin does not carry a format implementation at all.

**Why the projection cache is refreshed.** A session written straight to storage is a *cold* session. DSH's session list serves cold rows from a persisted projection cache, so a newly imported session would otherwise appear without its title. After each write the plugin calls `sessionProjectionCache.coldSnapshot(header, 0, log)` with the complete log, which folds and persists the record. This step is fail-soft: a failure is recorded as a warning and costs only the title hint until the session is opened.

**Truncation.** Blocks longer than `maxToolResultChars` are truncated with a marker appended (`[已截断 N 个字符，原始长度 M]`) and counted in the report, so an oversized tool output cannot quietly distort the record.

</details>

## Uninstall

1. Remove `dsh-opencode-session-sync` from `dependencies` and from `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json`.
2. Delete the link at `~/.dsh/profiles/<profile>/node_modules/dsh-opencode-session-sync` (deleting a link never touches the clone).
3. Restart DSH.

Imported sessions stay where they are. To remove them too, delete the relevant `~/.dsh/sessions/--<workspace>--/session-*/session.v4.jsonl.zstd` directories — the ids are listed in `~/.dsh/opencode-session-sync/state.json`. Uninstalling does not undo anything the plugin already imported.

## Development

```sh
npm test                          # unit tests (fixtures; no OpenCode database needed)
node tools/selfcheck.mjs          # convert a real OpenCode database and validate the result
node tools/verify-install.mjs     # check that the plugin is wired into a profile
```

Unit tests cover event sequence and numbering, turn/step splitting, tool calls and error results, duplicate call ids, reasoning and truncation switches, title fallback and title changes, directory normalisation, model fallback, and the incremental-append rules (seq and turn continuation, idle-delimited turns, no-op appends). Every case also runs the structural and cross-event checks in `lib/validate.js`.

Three stronger suites need the DSH application unpacked as a real dependency tree (`resources/app.asar` → an extractor is included in the workspace that hosts this plugin):

```sh
node test/integration.mjs <dshDir> <opencodeDb>   # full sync flow, idempotency, ledger, buckets
node test/host-apply.mjs  <dshDir> <opencodeDb>   # loads the plugin in a real Cordis context and calls the tool
node test/incremental.mjs <dshDir>                # import → grow → append → no-op → rewind, against a synthetic OpenCode database
```

`test/incremental.mjs` builds its own `opencode.db` with the real schema, so it can grow the source mid-test, which a real database cannot do.

CI runs on Ubuntu and Windows across Node 22 and 24: syntax checks over every file, the unit tests, and a behavioural check that `selfcheck.mjs` exits `2` with a clear message when no OpenCode database exists.

| Path | Responsibility |
| --- | --- |
| `lib/opencode-db.js` | Read-only SQLite access to `opencode.db` |
| `lib/convert.js` | Session rows → DSH events; first-import and append planning |
| `lib/validate.js` | Structural and cross-event checks shared by tests and self-check |
| `lib/sync.js` | Orchestration: read the existing log, decide, write, attach workspace, warm cache |
| `lib/ledger.js` | Config, ledger and run report on disk |
| `lib/index.js` | Plugin entry: registers `opencode_sync`, runs the startup sync |
| `tools/`, `test/` | Self-checks and the test suites above |

## License

[MIT](LICENSE) © forwardzz
