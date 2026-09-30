/**
 * dsh-plugin-memory — host half.
 *
 * Cross-session project memory for DeepSeek Harness:
 *
 * 1. Agent-maintained memory (Claude Code-aligned): the injected reminder
 *    instructs the conversation model to record durable knowledge as it
 *    works, through seven global tools — memory_save / memory_search /
 *    memory_list / memory_forget / memory_read / memory_write_topic /
 *    memory_delete_topic — into `~/.dsh/memory/projects/<dir>/`
 *    (memories.md + topics/*.md).
 * 2. `agent/pre-step` injection of that Markdown as a digest-deduplicated,
 *    log-confirmed `<system-reminder>` (KV-cache friendly, first step of a
 *    turn only), with a progressive-disclosure index of topic files.
 * 3. Opt-in silent two-phase distillation on completed `turn/end`
 *    (`autoDistill`, off by default): zero-cost pre-checks, then one direct
 *    `ctx.llm.stream()` call — no tool cards, no conversation output.
 * 4. Live settings: every Config field is volatile, so the `memory` entry's
 *    page (lib/client.js, on the Plugins page) edits it in place and each
 *    change applies to the next injection/distillation immediately.
 *
 * Host-plane row (see cordis.patch.yml): the settings entry exists once
 * per process, the store is shared by every session, and root-scope
 * listeners observe every agent. Memory files are plugin-owned user data
 * under the DSH home — written directly with node:fs, like dsh-settings-file
 * and session persistence, not through the agent file sandbox.
 *
 * @module dsh-plugin-memory
 */

import Schema from '@deepseek-ai/schemastery'
import { MemoryStore } from './store.js'
import { DEFAULT_BUDGET_CHARS, registerInjection } from './inject.js'
import { registerDistillation } from './distill.js'
import { registerMemoryTools } from './tools.js'

const name = 'dsh-plugin-memory'
const inject = ['tools', 'llm', 'agents']

/** Composition entry id (cordis.patch.yml), which DSH >= 0.2 settings forms address. */
const SETTINGS_NS = 'memory'

const DEFAULTS = {
  enabled: true,
  autoDistill: false,
  memoryDir: '',
  // Sized for a modern context window: ~1.6% of a 1M-token one, showing ~150
  // typical entries, so a project near the 200-entry storage cap arrives mostly
  // loaded instead of 16% loaded. A CAP, not a floor — a small memory still
  // costs only what it renders. Owned by the renderer so the schema default and
  // its own fallback stay one value.
  injectBudgetChars: DEFAULT_BUDGET_CHARS,
  // distillMinChars and cooldownTurns multiply: at 500/1 almost every turn
  // bought another model call, which is the whole cost of auto-distillation.
  distillMinChars: 2500,
  cooldownTurns: 3,
  distillProvider: '',
  distillModel: '',
  maxEntriesPerCategory: 50,
  topicIndexInInject: true,
  proactivity: 'conservative',
}

// Every field is `.volatile()`: DSH >= 0.2 edits a plugin's settings as its own
// composition entry (id `memory`, see cordis.patch.yml), exposing only volatile
// fields to forms, and commits a volatile-only change into the running
// references instead of remounting the plugin.
const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled).volatile()
    .description('Master switch: injection, distillation, and background work (tools stay registered).'),
  autoDistill: Schema.boolean().default(DEFAULTS.autoDistill).volatile()
    .description('Opt-in: additionally run a silent background distillation after completed turns. Default off — the conversation agent maintains memory itself (Claude Code-aligned).'),
  memoryDir: Schema.string().default(DEFAULTS.memoryDir).volatile()
    .description('Memory root directory; empty means <DSH home>/memory.'),
  // A low structural minimum on purpose: the renderer floors small budgets
  // gracefully, whereas a stricter schema bound would refuse (or, in a
  // composed file, fail to load) a value that actually works.
  injectBudgetChars: Schema.number().min(500).default(DEFAULTS.injectBudgetChars).volatile()
    .description('Character budget for the WHOLE injected memory reminder: its fixed instruction preamble (~1KB) is paid first, and the entries plus topic index share the remainder. One entry per populated section is always kept, so below roughly 2600 the result exceeds the budget rather than dropping content.'),
  distillMinChars: Schema.number().min(0).default(DEFAULTS.distillMinChars).volatile()
    .description('Minimum new conversation characters before a distillation runs (smaller turns accumulate).'),
  cooldownTurns: Schema.number().min(0).default(DEFAULTS.cooldownTurns).volatile()
    .description('Minimum turns between distillation attempts in one session.'),
  distillProvider: Schema.string().default(DEFAULTS.distillProvider).volatile()
    .description('Provider route for distillation; empty follows the conversation model.'),
  distillModel: Schema.string().default(DEFAULTS.distillModel).volatile()
    .description('Model id for distillation; empty follows the conversation model.'),
  maxEntriesPerCategory: Schema.number().min(1).default(DEFAULTS.maxEntriesPerCategory).volatile()
    .description('Per-category entry cap; oldest auto-distilled entries are pruned first.'),
  topicIndexInInject: Schema.boolean().default(DEFAULTS.topicIndexInInject).volatile()
    .description('Append a one-line-per-file topic index to the injected reminder (topic bodies load on demand via memory_read).'),
  proactivity: Schema.union(['conservative', 'balanced', 'eager']).default(DEFAULTS.proactivity).volatile()
    .description('How eagerly the conversation agent saves memory: conservative (durable, non-obvious corrections/decisions/lessons/preferences/project facts; most turns record nothing; when in doubt, do not save), balanced (durable knowledge as encountered), eager (record as you go, Claude-default-like).'),
})

/** Whether a parsed config value is a volatile reference (cosmokit protocol). */
function isReference(value) {
  return typeof value === 'object' && value !== null && Symbol.for('cosmokit.volatile.write') in value
}

/**
 * Build a reader of the effective configuration. The loader hands `apply`
 * volatile references that it rewrites in place when the settings page saves,
 * so dereferencing on every call is what makes an edit apply to the very next
 * injection/distillation without a remount. Plain values (a direct `apply`
 * call, or a runtime that did not parse through `Config`) pass through.
 * @param {object} [config] - the parsed composition entry config.
 * @returns {() => typeof DEFAULTS} a fresh snapshot of the current values.
 */
function configReader(config) {
  return () => {
    const current = { ...DEFAULTS }
    for (const key of Object.keys(DEFAULTS)) {
      const raw = config?.[key]
      const value = isReference(raw) ? raw.get() : raw
      if (value !== undefined && value !== null) current[key] = value
    }
    return current
  }
}

/**
 * Mount the memory capability.
 * @param {object} ctx - host plugin context carrying the injected services.
 * @param {object} [config] - composition entry config parsed through `Config`.
 */
function apply(ctx, config = {}) {
  const getConfig = configReader(config)

  // This plugin ships its own page (lib/client.js on the Plugins page), so ask
  // Settings not to auto-generate one. Optional: without a Settings service
  // the plugin runs on its composed configuration.
  ctx.inject(['settings'], (settingsCtx) => {
    if (typeof settingsCtx.settings?.configure !== 'function') return
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })

  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort())

  const store = new MemoryStore({ getConfig, warn: (message) => ctx.logger.warn(message) })

  registerInjection(ctx, store, getConfig)
  registerDistillation(ctx, store, getConfig, lifecycle.signal)
  registerMemoryTools(ctx, store, getConfig)
}

export { name, inject, apply, Config, Config as ConfigSchema, DEFAULTS, SETTINGS_NS, configReader }
