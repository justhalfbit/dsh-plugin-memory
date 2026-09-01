/**
 * dsh-plugin-memory — pre-step memory injection.
 *
 * Splices one `<system-reminder>` user message carrying the project's memory
 * into the step, exactly the way dsh-agent-instructions injects workspace
 * context: after `next()` resolves, after the last claimed inbox message.
 *
 * KV-cache friendly: the rendered body's SHA-1 is tracked per session, so an
 * unchanged file injects once per session and stays a stable prefix of the
 * durable log; a change appends a fresh reminder at the tail instead of
 * rewriting history. On process restart + resume the last injected digest is
 * recovered from the session log itself.
 *
 * Injection is limited to a turn's FIRST step, bounding the reminder to one
 * copy per turn even as the agent rewrites the memory it is reading.
 *
 * @module dsh-plugin-memory/inject
 */

import { randomUUID } from 'node:crypto'
import { CATEGORIES, MAX_TOPIC_FILES, sha1 } from './store.js'

export const PLUGIN_NAME = 'dsh-plugin-memory'

const REMINDER_CLOSE = '</system-reminder>'

/**
 * Keep the closing tag unforgeable inside plugin-owned reminder text —
 * case-insensitively and tolerating whitespace before `>`, so hand-edited
 * memory files cannot smuggle a variant closer past a lenient parser.
 */
function escapeReminder(text) {
  return text.replace(/<\/system-reminder\s*>/giu, '<\\/system-reminder>')
}

/**
 * Per-level memory-maintenance instructions. The user picks the level in
 * settings (`proactivity`); it only changes the injected wording — the
 * mechanism (visible tool calls, dedupe, caps) is identical at every level.
 */
export const PROACTIVITY_RULES = {
  /** High bar: corrections, decisions, hard lessons; silence by default. */
  conservative: {
    save:
      '- memory_save one entry when you learn something durable and non-obvious: a correction from the user, ' +
      'a decision made with its reason, a hard-won lesson, or a stable project fact. NEVER save ' +
      'session-specific trivia, restatements of the current task, or casual conversation — when in doubt, do not save.',
    topics:
      '- When a finished task leaves a substantial body of reusable knowledge (a debugging saga, an API ' +
      'convention set, a design walkthrough), organize it into a topic file with memory_write_topic at a ' +
      'natural stopping point; prefer extending an existing topic over creating fragmentary new ones.',
  },
  /** Middle: durable knowledge as encountered, trivia still excluded. */
  balanced: {
    save:
      '- memory_save an entry whenever you learn something durable: corrections from the user, decisions ' +
      'with their reasons, lessons, stable project facts, and clear user preferences. Skip ' +
      'session-specific trivia and restatements of the current task.',
    topics:
      '- At natural stopping points, organize substantial reusable knowledge (debugging sagas, API ' +
      'conventions, design walkthroughs) into topic files with memory_write_topic; prefer extending ' +
      'existing topics over creating fragmentary new ones.',
  },
  /** Claude-default-like: record as you go, err on the side of saving. */
  eager: {
    save:
      '- Actively record what you learn as you work with memory_save: corrections, decisions and their ' +
      'reasons, lessons, project facts, user preferences, and useful observations. Err on the side of ' +
      'saving — dedupe and per-category caps keep the file bounded — but still skip pure restatements ' +
      'of the current task.',
    topics:
      '- Proactively organize reusable knowledge into topic files with memory_write_topic as it ' +
      'accumulates — do not wait to be asked. Prefer extending existing topics, and review/refresh ' +
      'memory at task boundaries.',
  },
}

/**
 * Default character budget for the whole reminder. The renderer owns it and
 * the settings schema imports it, so the two cannot drift apart.
 */
export const DEFAULT_BUDGET_CHARS = 16000
/** Floor for the variable part, so a tiny budget still yields a usable reminder. */
const MIN_VARIABLE_CHARS = 600
/** Room a block reserves for the "… N omitted" line it may need to add. */
const OMISSION_RESERVE = 96
/** Heading of the progressive-disclosure topic index. */
const TOPIC_HEADING = '## Topic files (NOT loaded — call memory_read with the topic name when one becomes relevant)'

/**
 * Hand `total` characters to blocks by NEED (max-min fair): a block wanting
 * less than an equal share takes only what it needs and releases the rest to
 * the blocks that want more. An even split would strand budget in small
 * sections while a larger one truncated — dropping content that fits.
 * @param {number[]} needs - each block's full cost.
 * @param {number} total - characters available to share.
 * @returns the grant per block, summing to at most `total`.
 */
export function allocateBudget(needs, total) {
  const grants = needs.map(() => 0)
  let open = needs.map((_, index) => index)
  let remaining = total
  while (open.length > 0) {
    const share = Math.floor(remaining / open.length)
    const satisfied = open.filter((index) => needs[index] <= share)
    if (satisfied.length === 0) {
      for (const index of open) grants[index] = share
      break
    }
    for (const index of satisfied) {
      grants[index] = needs[index]
      remaining -= needs[index]
    }
    open = open.filter((index) => needs[index] > share)
  }
  return grants
}

/**
 * Render one block within its grant, keeping whichever end matters: the NEWEST
 * entries for a section, the first files for the topic index.
 */
function renderBlock({ heading, lines, grant, keepNewest, omissionLine }) {
  const full = heading.length + 1 + lines.reduce((sum, line) => sum + line.length + 1, 0)
  if (full <= grant) return `${heading}\n${lines.join('\n')}`
  // Only a block that will actually truncate pays for its omission line.
  const room = grant - OMISSION_RESERVE
  const kept = []
  let used = heading.length + 1
  let omitted = 0
  const order = keepNewest ? [...lines.keys()].reverse() : [...lines.keys()]
  for (const index of order) {
    if (used + lines[index].length + 1 > room && kept.length > 0) {
      omitted = keepNewest ? index + 1 : lines.length - index
      break
    }
    if (keepNewest) kept.unshift(lines[index])
    else kept.push(lines[index])
    used += lines[index].length + 1
  }
  if (omitted > 0) {
    if (keepNewest) kept.unshift(omissionLine(omitted))
    else kept.push(omissionLine(omitted))
  }
  return `${heading}\n${kept.join('\n')}`
}

/**
 * Render the reminder body for one parsed memory document, within a character
 * budget. Truncation is per-section balanced and keeps the NEWEST entries.
 * Topic files ride as a one-line-each index (progressive disclosure): they
 * are NOT loaded here; the model reads one on demand with memory_read.
 *
 * `budgetChars` governs the WHOLE reminder: the fixed preamble is paid first
 * and the entries and topic index share what remains.
 *
 * @returns the full reminder text, or undefined when there is nothing to say.
 */
export function renderMemoryReminder(parsed, { budgetChars = DEFAULT_BUDGET_CHARS, topics = [], proactivity = 'conservative' } = {}) {
  const populated = CATEGORIES.filter((category) => parsed.sections.get(category.key).entries.length > 0)
  const indexed = topics.slice(0, MAX_TOPIC_FILES)
  if (populated.length === 0 && indexed.length === 0) return undefined

  const rules = PROACTIVITY_RULES[proactivity] ?? PROACTIVITY_RULES.conservative
  const intro =
    'Long-term project memory for this working directory (maintained by dsh-plugin-memory; the user can ' +
    'edit the underlying Markdown files). Treat it as background knowledge: prefer what the CURRENT ' +
    'conversation says when they conflict. Maintain this memory yourself as you work:\n' +
    `${rules.save}\n` +
    '- memory_forget an entry only when THIS conversation gives you concrete evidence that it is wrong ' +
    'or obsolete — not merely because it reads oddly or you would have worded it differently. Other ' +
    'sessions in this project share these files.\n' +
    rules.topics +
    (indexed.length > 0
      ? '\n- Topic files are indexed below but NOT loaded: memory_read one when it becomes relevant.'
      : '')

  // Tags and block separators cost characters too; charge them before dividing.
  const blockCount = populated.length + (indexed.length > 0 ? 1 : 0)
  const structural = '<system-reminder>\n'.length + '\n\n'.length + '\n'.length + REMINDER_CLOSE.length
    + 2 * Math.max(0, blockCount - 1)
  const available = Math.max(MIN_VARIABLE_CHARS, budgetChars - intro.length - structural)

  // Describe every block first, then share the budget out by need. Splitting it
  // evenly up front stranded characters in blocks that did not want them while
  // another truncated — four entries could drop one inside a 4000 budget.
  const candidates = populated.map((category) => ({
    heading: `## ${category.heading}`,
    lines: parsed.sections.get(category.key).entries.map((entry) => `- [${entry.id}] ${entry.text}`),
    keepNewest: true,
    omissionLine: (n) => `- (… ${n} older ${category.heading.toLowerCase()} omitted; use memory_list to read them)`,
  }))
  if (indexed.length > 0) {
    candidates.push({
      heading: TOPIC_HEADING,
      lines: indexed.map((topic) =>
        `- ${topic.name} (${formatBytes(topic.bytes)}, ${topic.date})${topic.summary.length > 0 ? `: ${topic.summary}` : ''}`),
      keepNewest: false,
      omissionLine: (n) => `- (… ${n} more topic file(s); use memory_list to see them)`,
    })
  }
  const needs = candidates.map((c) => c.heading.length + 1 + c.lines.reduce((sum, line) => sum + line.length + 1, 0))
  const grants = allocateBudget(needs, available)
  const blocks = candidates.map((c, index) => renderBlock({ ...c, grant: grants[index] }))
  return `<system-reminder>\n${intro}\n\n${escapeReminder(blocks.join('\n\n'))}\n${REMINDER_CLOSE}`
}

/** Human-readable byte count for the topic index. */
function formatBytes(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`
}

/** Build the identified injected user message for one rendered reminder. */
export function buildReminderMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'instructions' },
  }
}

/** Extract the plain text of one logged message's blocks. */
export function messageText(message) {
  let text = ''
  for (const block of message?.content ?? []) if (block?.type === 'text') text += block.text
  return text
}

/**
 * Register the `agent/pre-step` injection waterfall.
 * @param {object} ctx - host plugin context (root scope: sees every agent).
 * @param {import('./store.js').MemoryStore} store - the shared memory store.
 * @param {() => object} getConfig - live resolved configuration.
 */
export function registerInjection(ctx, store, getConfig) {
  /**
   * Last LOG-CONFIRMED injected digest per live session. Advanced by the
   * `session/event` listener below (an injected reminder counts only once it
   * durably entered the log), never optimistically in pre-step — so a step
   * that fails before logging its messages self-heals with a re-injection.
   * @type {WeakMap<object, string>}
   */
  const lastDigest = new WeakMap()
  /** @type {WeakSet<object>} sessions whose replayed log was scanned once (resume/fork seeds emit no events). */
  const seeded = new WeakSet()

  const seedFromLog = (session) => {
    if (seeded.has(session)) return
    seeded.add(session)
    const events = session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'user/message') continue
      const message = event.data
      if (message?.source?.kind !== 'plugin' || message.source.plugin !== PLUGIN_NAME) continue
      lastDigest.set(session, sha1(messageText(message)))
      return
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const message = event.data
    if (message?.source?.kind !== 'plugin' || message.source.plugin !== PLUGIN_NAME) return
    lastDigest.set(session, sha1(messageText(message)))
    seeded.add(session)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    try {
      const config = getConfig()
      if (config.enabled !== true) return decision
      if (decision.kind === 'reject') return decision
      // First step only: the agent writes this memory itself, so re-rendering
      // mid-turn would hand it a fresh full reminder after every memory_save.
      if (step !== 1) return decision
      // An empty first step means the loop is about to complete the turn without
      // a model call. Splicing a reminder in would make that turn real and spend
      // a request to tell the agent something no one asked for.
      if (decision.messages.length === 0) return decision
      const header = agent.session.header
      if (header.origin === 'subagent') return decision
      const cwd = header.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return decision
      seedFromLog(agent.session)
      const { parsed } = await store.load(cwd)
      const topics = config.topicIndexInInject === false ? [] : await store.listTopics(cwd)
      if (signal.aborted) return decision
      const rendered = renderMemoryReminder(parsed, {
        budgetChars: config.injectBudgetChars,
        topics,
        proactivity: config.proactivity,
      })
      if (rendered === undefined) return decision
      const digest = sha1(rendered)
      // Compare against the log-confirmed digest only; the session/event
      // listener advances it once the spliced message durably lands.
      if (lastDigest.get(agent.session) === digest) return decision
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message))
      return {
        kind: 'enter',
        messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, buildReminderMessage(rendered)),
      }
    } catch (error) {
      ctx.logger.warn('memory injection failed: %o', error)
      return decision
    }
  })
}
