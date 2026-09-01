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
 * 4. A live `memory` settings namespace (browser card in lib/client.js);
 *    every change applies to the next injection/distillation immediately.
 *
 * Host-plane row (see cordis.patch.yml): the settings namespace registers
 * once per process, the store is shared by every session, and root-scope
 * listeners observe every agent. Memory files are plugin-owned user data
 * under the DSH home — written directly with node:fs, like dsh-settings-file
 * and session persistence, not through the agent file sandbox.
 *
 * @module dsh-plugin-memory
 */

import Schema from '@deepseek-ai/schemastery'
import { MemoryStore } from './store.js'
import { registerInjection } from './inject.js'
import { registerDistillation } from './distill.js'
import { registerMemoryTools } from './tools.js'

const name = 'dsh-plugin-memory'
const inject = ['tools', 'llm', 'agents']

/** Settings namespace served to configuration surfaces. */
const SETTINGS_NS = 'memory'

const DEFAULTS = {
  enabled: true,
  autoDistill: false,
  memoryDir: '',
  injectBudgetChars: 4000,
  distillMinChars: 500,
  cooldownTurns: 1,
  distillProvider: '',
  distillModel: '',
  maxEntriesPerCategory: 50,
  topicIndexInInject: true,
  proactivity: 'conservative',
}

const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled)
    .description('Master switch: injection, distillation, and background work (tools stay registered).'),
  autoDistill: Schema.boolean().default(DEFAULTS.autoDistill)
    .description('Opt-in: additionally run a silent background distillation after completed turns. Default off — the conversation agent maintains memory itself (Claude Code-aligned).'),
  memoryDir: Schema.string().default(DEFAULTS.memoryDir)
    .description('Memory root directory; empty means <DSH home>/memory.'),
  injectBudgetChars: Schema.number().min(500).default(DEFAULTS.injectBudgetChars)
    .description('Character budget for the injected memory reminder.'),
  distillMinChars: Schema.number().min(0).default(DEFAULTS.distillMinChars)
    .description('Minimum new conversation characters before a distillation runs (smaller turns accumulate).'),
  cooldownTurns: Schema.number().min(0).default(DEFAULTS.cooldownTurns)
    .description('Minimum turns between distillation attempts in one session.'),
  distillProvider: Schema.string().default(DEFAULTS.distillProvider)
    .description('Provider route for distillation; empty follows the conversation model.'),
  distillModel: Schema.string().default(DEFAULTS.distillModel)
    .description('Model id for distillation; empty follows the conversation model.'),
  maxEntriesPerCategory: Schema.number().min(1).default(DEFAULTS.maxEntriesPerCategory)
    .description('Per-category entry cap; oldest auto-distilled entries are pruned first.'),
  topicIndexInInject: Schema.boolean().default(DEFAULTS.topicIndexInInject)
    .description('Append a one-line-per-file topic index to the injected reminder (topic bodies load on demand via memory_read).'),
  proactivity: Schema.union(['conservative', 'balanced', 'eager']).default(DEFAULTS.proactivity)
    .description('How eagerly the conversation agent saves memory: conservative (corrections/decisions/lessons only; when in doubt, do not save), balanced (durable knowledge as encountered), eager (record as you go, Claude-default-like).'),
})

/** Pick the known configuration keys out of a composition entry config. */
function pickKnown(config) {
  const picked = {}
  for (const key of Object.keys(DEFAULTS)) if (config?.[key] !== undefined) picked[key] = config[key]
  return picked
}

/**
 * Mount the memory capability.
 * @param {object} ctx - host plugin context carrying the injected services.
 * @param {object} [config] - composition entry config (schema-shaped subset).
 */
function apply(ctx, config = {}) {
  const base = pickKnown(config)
  const fallback = Object.freeze({ ...DEFAULTS, ...base })
  let current = fallback
  const getConfig = () => current

  // Live settings while a settings provider exists; composed fallback otherwise.
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(SETTINGS_NS, ConfigSchema, { base, applies: 'live' })
      current = { ...fallback, ...scope.get() }
      settingsCtx.effect(() => scope.watch((next) => {
        current = { ...fallback, ...next }
      }))
      settingsCtx.effect(() => () => {
        current = fallback
      })
    } catch (error) {
      ctx.logger.warn('memory settings registration failed (using composed defaults): %o', error)
    }
  })

  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort())

  const store = new MemoryStore({ getConfig, warn: (message) => ctx.logger.warn(message) })

  registerInjection(ctx, store, getConfig)
  registerDistillation(ctx, store, getConfig, lifecycle.signal)
  registerMemoryTools(ctx, store, getConfig)
}

export { name, inject, apply, ConfigSchema, DEFAULTS }
