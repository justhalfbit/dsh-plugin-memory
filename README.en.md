# dsh-plugin-memory

[中文](README.md) | English

A cross-session project memory plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness):
the conversation agent records durable knowledge (facts / decisions / lessons / preferences)
**as it works**, persists it as plain Markdown, and injects it back into every new session in
the same project. The mechanism is aligned with Claude Code's official auto memory — and goes
further on index freshness and structural guardrails.

## Features

- 🧠 **Two-layer memory**: a main memory file (auto-injected within a budget) plus topic files
  (progressive disclosure: only a one-line index is injected; bodies load on demand)
- ✍️ **Agent-maintained**: every write is a visible tool call; three proactivity levels
  (conservative / balanced / eager)
- 🤫 **Optional silent distillation** (off by default): a background pass after each completed
  turn — no tool cards, no conversation footprint; suited to unattended long runs
- 📁 **Per-project isolation**: keyed by the session working directory; directory names are a
  readable full-path encoding plus a collision-proof hash
- 📝 **Plain Markdown storage**: human-readable, hand-editable, git-friendly; unparseable lines
  survive every rewrite verbatim
- ⚙️ **Settings panel**: a browser card and `settings.yaml`, all hot-reloaded
- 🔒 **Guardrails everywhere**: content-hash dedupe, per-category caps, prune order (manual
  entries evicted last), injection budget, KV-cache-friendly digest dedupe

## Installation

Prerequisites: [DSH](https://github.com/deepseek-ai/deepseek-harness) installed and `pnpm` on PATH.

```sh
# Install from GitHub (no build step, so no allowBuilds configuration is needed)
dsh plugin --profile web add github:justhalfbit/dsh-plugin-memory

# Restart `dsh web` to take effect
```

`web` is the profile name behind `dsh web` (the browser UI); on another profile (e.g. `tui`),
substitute its name. `dsh plugin add` writes the dependency into the profile and appends it to
`dsh.profile.bundles` automatically — no manual editing.

Uninstall with `dsh plugin --profile web remove dsh-plugin-memory` and restart; memory data
stays under `~/.dsh/memory` for you to keep or delete.

For local development: clone, `pnpm install`, then
`dsh plugin --profile web add link:/absolute/path/dsh-plugin-memory`.

> Compatibility: developed against DSH `0.1.1-rc.x`; upstream APIs may still move during rc.

### Interface support

| Runtime | Memory core (injection / distillation / tools / storage) | Settings card |
|---|---|---|
| `dsh web` (browser GUI) | ✅ | ✅ |
| `tui` / `headless` | ✅ fully available | ❌ use `settings.yaml` (also hot-reloaded) |

The host half is UI-agnostic; the client half (the settings card) declares `platform: "web"`
and loads only in the browser UI.

## How it works

### Storage

```
~/.dsh/memory/projects/<encoded-full-path--hash>/
├── memories.md      # main file: four sections (Facts/Decisions/Lessons/Preferences)
└── topics/*.md      # topic files: free-form deep notes (debugging playbooks, API conventions…)
```

`memories.md` looks like this — ids derive from a content hash (natural dedupe); the trailing
comment records date and source (`auto` distilled / `manual` saved; auto entries pruned first):

```markdown
# Project Memory
<!-- dsh-memory v1 -->

## Facts
- [f-32e32a1b] host logs go to the terminal that launched dsh web; no --log-file option <!-- 2026-09-01 auto -->

## Decisions
- [d-8c4c11ee] memory stays plain Markdown instead of SQLite so it can be git-managed <!-- 2026-09-01 manual -->

## Lessons
## Preferences
```

Topic limits: 24 files per project, 64K chars per file, 16K chars per write.

### Memory writing (primary mechanism, Claude Code-aligned)

The injected prompt (default conservative wording) instructs the conversation agent to call `memory_save` when it learns
something durable and non-obvious: a correction from the user, a decision with its reason, a
hard-won lesson, a stable project fact — and to skip it when in doubt; to `memory_forget`
stale entries; and to organize substantial reusable knowledge into topic files with
`memory_write_topic` at natural stopping points. The `proactivity` setting switches only the
wording; the mechanism and guardrails are identical at every level.

### Injection

An `agent/pre-step` waterfall splices the memory into the step as a `<system-reminder>`:
main-file entries in full (4000-char budget by default, per-section balanced truncation keeping
the newest), topic files as one line each (name + size + date + first-line summary), bodies
loaded on demand via `memory_read`. Deduplicated by the SHA-1 of the rendered body — an
unchanged file injects once per session (KV-cache friendly); the digest only advances once the
injected message durably lands in the log, so a failed step self-heals with a re-injection;
resumed sessions recover the digest by scanning their log.

### Silent distillation (opt-in, off by default)

With `autoDistill` enabled, every completed `turn/end` adds a fully silent two-phase pass:
zero-cost prechecks (skip subagent sessions, turns without genuine user input, windows below
the character threshold, cooldown, repeated windows, in-flight runs), then one direct
`ctx.llm.stream()` call extracting strict-JSON entries — never through the tool pipeline, never
visible in the conversation. Model fallback mirrors compaction: configured model → the
session's latest routed request → the agent's own options.

## Model tools

| Tool | Purpose |
|---|---|
| `memory_save` | Save one entry (category + content); content-hash deduped; returns the id |
| `memory_search` | Keyword search (case-insensitive term matching with phrase boost) |
| `memory_list` | List all entries and the topic index, with the file path |
| `memory_forget` | Delete one wrong/stale entry by id |
| `memory_read` | Read one topic file in full, on demand |
| `memory_write_topic` | Create/append/rewrite a topic file (append / replace) |

## Settings

Edit via Settings → Plugins → Plugin configuration → the memory card, or the `memory:` section
of `~/.dsh/settings.yaml`. Everything applies live.

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch (tools stay queryable when off) |
| `proactivity` | `'conservative'` | How eagerly the agent saves: `conservative` / `balanced` / `eager` |
| `autoDistill` | `false` | Opt-in background distillation after completed turns |
| `memoryDir` | `''` | Memory root; empty = `<DSH home>/memory` |
| `injectBudgetChars` | `4000` | Injection budget (chars), per-section balanced truncation |
| `distillMinChars` | `500` | Minimum new chars before a distillation (smaller turns accumulate) |
| `cooldownTurns` | `1` | Minimum turns between distillations in one session |
| `distillProvider` / `distillModel` | `''` | Distillation model; empty follows the conversation |
| `maxEntriesPerCategory` | `50` | Per-category cap; oldest auto entries pruned first |
| `topicIndexInInject` | `true` | Append the topic index to the injected reminder |

## Design

**Why the host plane instead of an agent preset?** A DSH settings namespace registers once per
process (preset plugins instantiate per session — the second session would collide), and memory
is inherently cross-session, wanting one process-wide write queue. Root-context listeners on the
host plane observe every agent's events, tools register globally, and `session.header.cwd`
scopes everything per project — one instance serves every session with nothing lost.

**Versus Claude Code auto memory:**

| Aspect | Claude Code | This plugin |
|---|---|---|
| Writer | the conversation agent itself (visible tool calls) | ✅ same (`proactivity` adjustable) |
| Loading | first 200 lines of MEMORY.md | main file within a budget (4000 chars default) |
| Topic files | not auto-loaded; Read on demand | ✅ same (`memory_read`) |
| Index | hand-maintained in MEMORY.md; drifts stale | **generated from the directory at injection time; never stale** |
| Structure | free-form, unbounded growth | **four categories + content-hash dedupe + capped pruning** |
| Background distillation | none | provided as opt-in |

**Reliability**: per-file serialized write queues + a cross-process lock directory (stale locks
stealable after 5s, re-confirmed before stealing) + atomic temp-and-rename writes (failed writes
clean up their temp file); single-flight project-directory resolution against migration races;
log-confirmed injection digests; distillation watermarks advance at attempt start (failed
windows are not retried — deliberate cost control).

**Safety**: topic names are allowlist-validated (path traversal impossible by construction);
close-tag variants in injected content are escaped case-insensitively; the distillation prompt
forbids storing secrets/credentials/personal data; subagent sessions are neither injected into
nor distilled.

## Known limitations

- Cross-process concurrent writes to one project are last-write-wins (strictly serialized
  within a process);
- Failed distillation windows are not retried (deliberate cost control);
- Memory files are plugin-owned user data written host-side, outside the agent file sandbox.

## Development

```sh
pnpm install
pnpm test   # node --test test/, 23 unit tests
```

## License

[MIT](LICENSE)
