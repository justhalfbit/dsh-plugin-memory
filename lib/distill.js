/**
 * dsh-plugin-memory — two-phase silent distillation on `turn/end`.
 *
 * Phase 1 (zero cost, pure CPU): per-session watermark over the append-only
 * session log; skip turns that are cancelled/errored, subagent sessions,
 * turns without a genuine user message, windows below the character
 * threshold (they accumulate into the next window), cooldown violations,
 * repeats of the last attempted window, and sessions with an in-flight run.
 *
 * Phase 2 (background, fire-and-forget): one direct `ctx.llm.stream()` call —
 * the dsh-compaction-basic pattern — that never touches the tool pipeline,
 * produces no cards, and writes nothing into the conversation. The model
 * returns strict JSON ops which are merged into the project's memories.md.
 *
 * Being silent, this pass is deliberately weaker than the in-conversation
 * tools: it writes with `protectManual` (see applyOps).
 *
 * Model fallback chain (same as compaction): configured distill model →
 * the session's latest routed request header → the agent's own options.
 *
 * @module dsh-plugin-memory/distill
 */

import { randomUUID } from 'node:crypto'
import { CATEGORY_KEYS, applyOps, projectDirName, sha1 } from './store.js'
import { PLUGIN_NAME, messageText } from './inject.js'

const MAX_ITEMS_PER_TURN = 5
const MAX_ITEM_CHARS = 300
const MAX_TRANSCRIPT_CHARS = 8000
const MAX_EXISTING_CHARS = 3000
const MAX_OUTPUT_TOKENS = 800

/**
 * Extract the distillation window from `events[from..]`: genuine user text and
 * assistant text, in order, tagged by speaker.
 * @returns `{ lines, userChars, totalChars, sawUser }`
 */
export function extractWindow(events, from) {
  const lines = []
  let userChars = 0
  let totalChars = 0
  let sawUser = false
  for (let index = from; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const text = messageText(event.data).trim()
      if (text.length === 0) continue
      sawUser = true
      userChars += text.length
      totalChars += text.length
      lines.push(`USER: ${text}`)
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message).trim()
      if (text.length === 0) continue
      totalChars += text.length
      lines.push(`ASSISTANT: ${text}`)
    }
  }
  return { lines, userChars, totalChars, sawUser }
}

/**
 * Compact existing entries for the prompt, newest last, within a budget.
 * Lines carry their provenance so the model does not spend ops on `manual`
 * entries, whose revision applyOps refuses anyway.
 */
export function renderExisting(parsed, budget = MAX_EXISTING_CHARS) {
  const lines = []
  for (const [categoryKey, section] of parsed.sections) {
    for (const entry of section.entries) lines.push(`[${entry.id}] (${categoryKey}, ${entry.source}) ${entry.text}`)
  }
  let used = 0
  const kept = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (used + lines[index].length + 1 > budget) break
    kept.unshift(lines[index])
    used += lines[index].length + 1
  }
  return kept.join('\n')
}

/** Build the single-user-message distillation prompt. */
export function buildDistillPrompt(existing, transcript) {
  return [
    'You are a memory distillation engine for a coding assistant. From the conversation excerpt below,',
    'extract durable project knowledge worth remembering across future sessions in the same project.',
    '',
    'Categories:',
    '- facts: stable project facts (architecture, paths, commands, constraints, versions)',
    '- decisions: technical decisions made and their reasons',
    '- lessons: pitfalls hit and how they were resolved',
    '- preferences: the user\'s coding/workflow/communication preferences',
    '',
    'Rules:',
    `- At most ${MAX_ITEMS_PER_TURN} items; each item one self-contained sentence under ${MAX_ITEM_CHARS} characters, in the user's language.`,
    '- Only durable, project-relevant knowledge. NO session-specific trivia, NO restating the task itself.',
    '- NEVER store secrets, credentials, tokens, or personal data.',
    '- Do not repeat anything already covered by EXISTING MEMORY. To revise a stale entry, use op "update" with its id; to delete a wrong entry, use op "forget" with its id.',
    '- Each existing entry is tagged (category, source). You may only "update" or "forget" entries whose source is "auto" — your own earlier output. Entries marked "manual" were written deliberately through a visible tool call, so leave them alone; such ops are refused.',
    '- If nothing is worth remembering, return {"items":[]}.',
    '',
    'Output STRICT JSON only, no markdown fences, matching:',
    '{"items":[{"op":"add|update|forget","category":"facts|decisions|lessons|preferences","text":"...","id":"only for update/forget"}]}',
    '',
    '=== EXISTING MEMORY ===',
    existing.length === 0 ? '(empty)' : existing,
    '',
    '=== CONVERSATION EXCERPT ===',
    transcript,
  ].join('\n')
}

/**
 * Leniently parse the model output into validated ops.
 * @returns an array of clean ops (possibly empty); never throws.
 */
export function parseDistillOutput(text) {
  let raw = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw)
  if (fenced !== null) raw = fenced[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return []
  let data
  try {
    data = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(data?.items)) return []
  const ops = []
  for (const item of data.items.slice(0, MAX_ITEMS_PER_TURN)) {
    if (item === null || typeof item !== 'object') continue
    const op = item.op === 'update' || item.op === 'forget' ? item.op : 'add'
    if (op === 'forget') {
      if (typeof item.id === 'string' && item.id.length > 0) ops.push({ op, id: item.id })
      continue
    }
    if (typeof item.text !== 'string' || item.text.trim().length === 0) continue
    if (!CATEGORY_KEYS.includes(item.category)) continue
    ops.push({
      op,
      category: item.category,
      text: item.text.trim().slice(0, MAX_ITEM_CHARS),
      ...op === 'update' && typeof item.id === 'string' ? { id: item.id } : {},
      source: 'auto',
    })
  }
  return ops
}

/** Resolve the distillation provider/model (compaction-basic fallback chain). */
export function resolveTarget(config, agent) {
  const provider = (config.distillProvider ?? '').trim()
  const model = (config.distillModel ?? '').trim()
  if (provider.length > 0 && model.length > 0) return { provider, model }
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined
    && typeof latest.provider === 'string' && latest.provider.length > 0
    && typeof latest.model === 'string' && latest.model.length > 0) {
    return { provider: latest.provider, model: latest.model }
  }
  const options = agent.options
  if (typeof options.provider === 'string' && options.provider.length > 0 && typeof options.model === 'string' && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  return undefined
}

/** Run one llm.stream call and assemble its text; throws on error/aborted finishes. */
async function streamText(ctx, { target, prompt, sessionId, signal }) {
  let text = ''
  const options = {
    provider: target.provider,
    model: target.model,
    messages: [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    }],
    maxTokens: MAX_OUTPUT_TOKENS,
    sessionId,
    signal,
  }
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(`distillation request ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'unknown'}`)
    }
  }
  return text
}

/**
 * Register the `turn/end` distillation listener.
 * @param {object} ctx - host plugin context.
 * @param {import('./store.js').MemoryStore} store - the shared memory store.
 * @param {() => object} getConfig - live resolved configuration.
 * @param {AbortSignal} lifecycleSignal - aborted when the plugin unloads.
 */
export function registerDistillation(ctx, store, getConfig, lifecycleSignal) {
  /** @type {WeakMap<object, { watermark: number, lastTurn: number, lastTryDigest: string, inflight: boolean }>} */
  const state = new WeakMap()

  const run = async (session, turn) => {
    const config = getConfig()
    if (config.enabled !== true || config.autoDistill !== true) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const header = session.header
    if (header.origin === 'subagent') return
    const cwd = header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return

    let st = state.get(session)
    if (st === undefined) {
      // Seeded history (resume/fork) was distilled by earlier processes; start live.
      st = { watermark: session.firstLiveSeq, lastTurn: -Infinity, lastTryDigest: '', inflight: false }
      state.set(session, st)
    }
    if (st.inflight) return
    if (turn - st.lastTurn < config.cooldownTurns) return

    const window = extractWindow(session.events, st.watermark)
    if (!window.sawUser) {
      // Keep the watermark: an autonomous (assistant-only) stretch is not
      // distilled on its own, but it stays in the window so a later turn
      // with genuine user input distills WITH that context instead of
      // permanently losing it. Re-extraction is CPU-only and linear.
      return
    }
    if (window.totalChars < config.distillMinChars) return // accumulate into the next window
    const digest = sha1(window.lines.join('\n'))
    if (digest === st.lastTryDigest) return

    // Advance at attempt start: a failed window is not retried (cost control).
    st.inflight = true
    st.lastTryDigest = digest
    st.watermark = session.seq
    st.lastTurn = turn
    try {
      const target = resolveTarget(config, agent)
      if (target === undefined) return
      const existing = await store.load(cwd)
      let transcript = window.lines.join('\n')
      if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`
      const prompt = buildDistillPrompt(renderExisting(existing.parsed), transcript)
      const output = await streamText(ctx, { target, prompt, sessionId: session.id, signal: lifecycleSignal })
      const ops = parseDistillOutput(output)
      if (ops.length === 0) return
      const result = await store.mutate(cwd, (parsed) =>
        applyOps(parsed, ops, { maxPerCategory: config.maxEntriesPerCategory, protectManual: true }))
      if (result.applied.length > 0) {
        ctx.logger.info(`memory: distilled ${result.applied.length} change(s) for ${projectDirName(cwd)} (turn ${turn})`)
      }
    } finally {
      st.inflight = false
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (event.data?.reason?.kind !== 'completed') return
    if (lifecycleSignal.aborted) return
    void run(session, event.data.turn).catch((error) => {
      if (!lifecycleSignal.aborted) ctx.logger.warn('memory distillation failed: %o', error)
    })
  })
}
