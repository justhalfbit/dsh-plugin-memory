/** Unit tests for distillation pure logic and the injection renderer. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDistillPrompt, extractWindow, parseDistillOutput, renderExisting, resolveTarget } from '../lib/distill.js'
import { SOURCE_KIND, allocateBudget, buildReminderMessage, registerInjection, renderMemoryReminder } from '../lib/inject.js'
import { applyOps, emptyParsed } from '../lib/store.js'

/**
 * Drive the real `agent/pre-step` waterfall against a stub store, so the gates
 * around the splice are covered without touching the filesystem.
 * @returns the decision the plugin returned for that step.
 */
async function runPreStep({ step = 1, claimed = [{ id: 'u1' }], entries = [{ category: 'facts', text: 'a stored fact' }], session } = {}) {
  const parsed = emptyParsed()
  if (entries.length > 0) {
    applyOps(parsed, entries.map((entry) => ({ op: 'add', ...entry, source: 'manual' })), { date: '2026-09-02' })
  }
  const store = { load: async () => ({ parsed }), listTopics: async () => [] }
  const handlers = new Map()
  const warnings = []
  const ctx = { on: (name, handler) => handlers.set(name, handler), logger: { warn: (...args) => warnings.push(args) } }
  registerInjection(ctx, store, () => ({
    enabled: true, injectBudgetChars: 4000, topicIndexInInject: false, proactivity: 'conservative',
  }))
  const agent = { session: session ?? fakeSession([]) }
  const payload = { agent, messages: claimed, step, signal: { aborted: false } }
  const decision = await handlers.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: [...claimed] }))
  return Object.assign(decision, { warnings, handlers, agent })
}

/**
 * A minimal stand-in for `dsh-session`'s Session (DSH >= 0.1.2): a header, the
 * log readers `eventAt(seq)` / `snapshotEvents()`, and the model-visible
 * `surface.nodes`. Events are renumbered by position; `shadowed` lists the
 * seqs a compaction `replace` removed from the surface while they stay in the
 * log — exactly the distinction the injection dedupe must respect.
 */
function fakeSession(events, { cwd = '/tmp/prestep-project', shadowed = [] } = {}) {
  const log = events.map((event, seq) => ({ ...event, seq }))
  const hidden = new Set(shadowed)
  return {
    header: { cwd },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => Object.freeze([...log]),
    surface: { nodes: Object.freeze(log.map((event) => event.seq).filter((seq) => !hidden.has(seq))) },
  }
}

/** Count plugin-authored reminders in a decision. */
const reminders = (decision) =>
  decision.messages.filter((message) => message.source?.kind === SOURCE_KIND).length

const userEvent = (text) => ({ type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const pluginEvent = (text, kind = 'plugin:x') => ({ type: 'user/message', seq: 0, time: 0, data: { id: 'p', role: 'user', content: [{ type: 'text', text }], source: { kind } } })
const assistantEvent = (text) => ({ type: 'assistant/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } } })

test('extractWindow keeps genuine user + assistant text only, from the watermark', () => {
  const events = [userEvent('old'), assistantEvent('old answer'), pluginEvent('<system-reminder>noise</system-reminder>'), userEvent('新问题'), assistantEvent('回答内容')]
  const window = extractWindow(events, 2)
  assert.deepEqual(window.lines, ['USER: 新问题', 'ASSISTANT: 回答内容'])
  assert.equal(window.sawUser, true)
  assert.equal(window.userChars, 3)
  const empty = extractWindow(events, 5)
  assert.equal(empty.sawUser, false)
  assert.equal(empty.totalChars, 0)
})

test('parseDistillOutput accepts strict, fenced, and prefixed JSON; rejects garbage', () => {
  const strict = parseDistillOutput('{"items":[{"op":"add","category":"facts","text":"项目用 pnpm 管理依赖"}]}')
  assert.equal(strict.length, 1)
  assert.deepEqual(strict[0], { op: 'add', category: 'facts', text: '项目用 pnpm 管理依赖', source: 'auto' })

  const fenced = parseDistillOutput('好的，输出如下：\n```json\n{"items":[{"op":"forget","id":"f-12345"},{"op":"update","category":"lessons","id":"l-abcde","text":"改后的教训"}]}\n```')
  assert.equal(fenced.length, 2)
  assert.deepEqual(fenced[0], { op: 'forget', id: 'f-12345' })
  assert.deepEqual(fenced[1], { op: 'update', category: 'lessons', text: '改后的教训', id: 'l-abcde', source: 'auto' })

  assert.deepEqual(parseDistillOutput('nothing to store'), [])
  assert.deepEqual(parseDistillOutput('{"items":[]}'), [])
  assert.deepEqual(parseDistillOutput('{"items":[{"op":"add","category":"bogus","text":"x"}]}'), [])
  assert.deepEqual(parseDistillOutput('{"items":"not an array"}'), [])
  // caps at 5 items
  const many = JSON.stringify({ items: Array.from({ length: 9 }, (_, index) => ({ op: 'add', category: 'facts', text: `t${index}` })) })
  assert.equal(parseDistillOutput(many).length, 5)
})

test('resolveTarget prefers configured, then request header, then agent options', () => {
  const agent = {
    session: { requestHeader: () => ({ config: { provider: 'hp', model: 'hm' } }) },
    options: { provider: 'op', model: 'om' },
  }
  assert.deepEqual(resolveTarget({ distillProvider: 'cp', distillModel: 'cm' }, agent), { provider: 'cp', model: 'cm' })
  assert.deepEqual(resolveTarget({ distillProvider: '', distillModel: '' }, agent), { provider: 'hp', model: 'hm' })
  const headerless = { session: { requestHeader: () => undefined }, options: { provider: 'op', model: 'om' } }
  assert.deepEqual(resolveTarget({ distillProvider: '', distillModel: '' }, headerless), { provider: 'op', model: 'om' })
  const bare = { session: { requestHeader: () => undefined }, options: {} }
  assert.equal(resolveTarget({ distillProvider: '', distillModel: '' }, bare), undefined)
})

test('prompt carries existing memory with provenance, plus the transcript', () => {
  const parsed = emptyParsed()
  applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'uses vite', source: 'auto' },
    { op: 'add', category: 'decisions', text: 'chose markdown', source: 'manual' },
  ], { date: '2026-08-31' })
  const prompt = buildDistillPrompt(renderExisting(parsed), 'USER: hi')
  // The source rides each line so the model can tell what it may revise.
  assert.ok(prompt.includes('(facts, auto) uses vite'))
  assert.ok(prompt.includes('(decisions, manual) chose markdown'))
  assert.ok(prompt.includes('only "update" or "forget" entries whose source is "auto"'))
  assert.ok(prompt.includes('USER: hi'))
  assert.ok(prompt.includes('"items"'))
})

test('renderMemoryReminder renders sections within budget and escapes the close tag', () => {
  const parsed = emptyParsed()
  applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'contains </system-reminder> tag', source: 'auto' },
    { op: 'add', category: 'preferences', text: '用中文回复', source: 'manual' },
  ], { date: '2026-08-31' })
  const rendered = renderMemoryReminder(parsed, { budgetChars: 4000 })
  assert.ok(rendered.startsWith('<system-reminder>'))
  assert.ok(rendered.endsWith('</system-reminder>'))
  assert.ok(rendered.includes('## Facts'))
  assert.ok(rendered.includes('## Preferences'))
  assert.ok(rendered.includes('<\\/system-reminder> tag'))
  // An empty memory renders the bootstrap reminder instead of nothing: rules,
  // but no entry or topic block to read.
  const bootstrap = renderMemoryReminder(emptyParsed(), {})
  assert.ok(bootstrap.startsWith('<system-reminder>'))
  assert.ok(bootstrap.endsWith('</system-reminder>'))
  assert.ok(bootstrap.includes('memory_save'))
  assert.ok(!bootstrap.includes('##'), 'bootstrap must render no blocks')
  assert.ok(!/\n\n\n/u.test(bootstrap), 'no stray blank line where the blocks would go')

  // budget truncation keeps the NEWEST entries and adds an omission marker
  const big = emptyParsed()
  const ops = Array.from({ length: 40 }, (_, index) => ({ op: 'add', category: 'facts', text: `fact number ${index} with some padding text`, source: 'auto' }))
  applyOps(big, ops, { date: '2026-08-31' })
  const truncated = renderMemoryReminder(big, { budgetChars: 600 })
  assert.ok(truncated.includes('omitted'))
  assert.ok(truncated.includes('fact number 39'))
  assert.ok(!truncated.includes('fact number 0 '))
})

test('buildReminderMessage shape matches the logged user-message contract', () => {
  const message = buildReminderMessage('<system-reminder>x</system-reminder>')
  assert.equal(message.role, 'user')
  // Session format v4 (DSH >= 0.2) refuses the retired { kind: 'plugin' }
  // wrapper; third-party producers own `plugin:<name>`.
  assert.equal(message.source.kind, 'plugin:dsh-plugin-memory')
  assert.equal(SOURCE_KIND, 'plugin:dsh-plugin-memory')
  assert.equal(Object.hasOwn(message.source, 'plugin'), false)
  assert.equal(message.content[0].type, 'text')
  assert.ok(typeof message.id === 'string' && message.id.length > 10)
})

test('renderMemoryReminder appends a topic index and renders topics-only reminders', () => {
  const topics = [{ name: 'debugging', bytes: 2048, date: '2026-08-31', summary: '调试手册' }]
  const withTopics = renderMemoryReminder(emptyParsed(), { topics })
  assert.ok(withTopics.includes('## Topic files'))
  assert.ok(withTopics.includes('- debugging (2.0KB, 2026-08-31): 调试手册'))
  assert.ok(withTopics.includes('memory_read'))
  const parsed = emptyParsed()
  applyOps(parsed, [{ op: 'add', category: 'facts', text: 'some fact', source: 'auto' }], { date: '2026-08-31' })
  const both = renderMemoryReminder(parsed, { topics })
  assert.ok(both.includes('## Facts') && both.includes('## Topic files'))
  // No entries and no topics: rules only, and no topic heading to mislead.
  const neither = renderMemoryReminder(emptyParsed(), { topics: [] })
  assert.ok(neither.includes('has no entries yet'))
  assert.ok(!neither.includes('## Topic files'))
  assert.ok(!neither.includes('memory_read'), 'nothing to read, so do not advertise it')
})

test('pre-step injects on a turn\'s first step only', async () => {
  assert.equal(reminders(await runPreStep({ step: 1 })), 1)
  // Later steps carry no copy, so N memory_saves in a turn cannot stack up.
  for (const step of [2, 3, 9]) assert.equal(reminders(await runPreStep({ step })), 0)
})

test('pre-step uses the real Session surface (DSH >= 0.1.2) and never warns', async () => {
  // Regression: the plugin used to read `session.events`, a getter DSH removed
  // in 0.1.2. On a real Session that threw inside pre-step, the catch swallowed
  // it, and every session's FIRST turn silently went without its reminder.
  const decision = await runPreStep({ step: 1 })
  assert.equal(reminders(decision), 1)
  assert.deepEqual(decision.warnings, [], 'a real Session surface must not trip the injection catch')
})

/** The reminder a fresh first step would render, wrapped as a logged event. */
async function loggedReminder() {
  const probe = await runPreStep({ step: 1 })
  const injected = probe.messages.find((message) => message.source?.kind === SOURCE_KIND)
  return { type: 'user/message', seq: 0, time: 0, data: injected }
}

test('pre-step dedupes against the newest reminder the model can still see', async () => {
  // A resumed/forked session replays its log without emitting session/event,
  // so the plugin cannot rely on state it accumulated in-process: the newest
  // reminder on the visible surface is the only ground truth. Here it matches
  // the current render, so nothing is re-injected.
  const older = pluginEvent('<system-reminder>stale reminder</system-reminder>', SOURCE_KIND)
  const resumed = fakeSession([userEvent('hi'), older, userEvent('again'), await loggedReminder(), assistantEvent('ok')])
  const decision = await runPreStep({ step: 1, session: resumed })
  assert.equal(reminders(decision), 0, 'the newest visible reminder matches the render, so nothing is re-injected')
  assert.deepEqual(decision.warnings, [])
})

test('pre-step re-injects after compaction shadows the reminder', async () => {
  // Compaction replaces a surface range with an LLM-written summary that does
  // not carry the reminder's text. The reminder stays in the LOG, but the
  // model can no longer see it — so "already in the log" is the wrong test,
  // and a session that outlives one compaction would otherwise lose its memory
  // (and the memory_save rules) for the rest of its life.
  const logged = await loggedReminder()
  const summary = pluginEvent('<compacted-summary>earlier chat</compacted-summary>', 'compact-basic')
  // seqs: 0 user, 1 reminder, 2 assistant, 3 checkpoint summary (replaced 0..2)
  const compacted = fakeSession([userEvent('hi'), logged, assistantEvent('ok'), summary], { shadowed: [0, 1, 2] })
  const decision = await runPreStep({ step: 1, session: compacted })
  assert.equal(reminders(decision), 1, 'the shadowed reminder is invisible, so the step re-injects one copy')
  assert.deepEqual(decision.warnings, [])
})

test('pre-step stays quiet when compaction keeps the reminder in the visible tail', async () => {
  // Compaction retains a verbatim tail. A reminder inside that tail is still
  // model-visible, so re-injecting would duplicate it.
  const logged = await loggedReminder()
  const summary = pluginEvent('<compacted-summary>earlier chat</compacted-summary>', 'compact-basic')
  // seqs: 0 user, 1 assistant, 2 user, 3 reminder, 4 assistant, 5 summary (replaced 0..1 only)
  const compacted = fakeSession([userEvent('old'), assistantEvent('old'), userEvent('hi'), logged, assistantEvent('ok'), summary], { shadowed: [0, 1] })
  const decision = await runPreStep({ step: 1, session: compacted })
  assert.equal(reminders(decision), 0)
})

test('pre-step re-injects when the newest visible reminder is stale', async () => {
  // The memory changed since the visible reminder was written (or an older
  // reminder is the newest one left visible): the render differs, inject.
  const stale = pluginEvent('<system-reminder>stale reminder</system-reminder>', SOURCE_KIND)
  const session = fakeSession([userEvent('hi'), stale, assistantEvent('ok')])
  assert.equal(reminders(await runPreStep({ step: 1, session })), 1)
})

test('pre-step leaves an empty first step empty', async () => {
  // The loop completes a turn that produces no messages without calling the
  // model. Splicing a reminder in would make that turn real and spend a
  // request on something no one asked for.
  const decision = await runPreStep({ step: 1, claimed: [] })
  assert.equal(reminders(decision), 0)
  assert.equal(decision.messages.length, 0)
})

test('pre-step bootstraps an empty memory rather than staying silent', async () => {
  // This inverts an earlier deliberate invariant ("stay out of the way when
  // there is nothing to say"). Staying silent was self-sealing: the save rules
  // ship only inside this reminder, so a project whose memory starts empty
  // never learned to write its first entry and stayed empty forever.
  const decision = await runPreStep({ step: 1, entries: [] })
  assert.equal(reminders(decision), 1)
  const text = decision.messages.find((message) => message.source?.kind === SOURCE_KIND).content[0].text
  assert.ok(text.includes('has no entries yet'))
  assert.ok(text.includes('memory_save'))
  assert.ok(!text.includes('##'), 'an empty memory must not render an empty block')
})

test('the bootstrap reminder keeps the caller\'s bar and hands off on the first entry', () => {
  // Bootstrapping must not quietly promote a conservative project to eager.
  const conservative = renderMemoryReminder(emptyParsed(), { proactivity: 'conservative' })
  const eager = renderMemoryReminder(emptyParsed(), { proactivity: 'eager' })
  assert.notEqual(conservative, eager)
  assert.ok(conservative.includes('NEVER save'))
  assert.ok(eager.includes('Err on the side of'))
  // ...and it tells the model not to manufacture entries just to fill the file.
  assert.ok(conservative.includes('Do not save anything merely to fill'))
  // An unrecognized level falls back instead of throwing.
  assert.ok(renderMemoryReminder(emptyParsed(), { proactivity: 'bogus' }).includes('memory_save'))
  // A fixed cost, never budget-negotiated: a tiny budget trimming it away
  // would restore the very deadlock this reminder exists to break.
  assert.ok(renderMemoryReminder(emptyParsed(), { budgetChars: 10 }).includes('memory_save'))

  // One entry is enough to leave bootstrap mode for good.
  const parsed = emptyParsed()
  applyOps(parsed, [{ op: 'add', category: 'facts', text: 'the first fact', source: 'manual' }], { date: '2026-09-03' })
  const populated = renderMemoryReminder(parsed, {})
  assert.ok(populated.includes('## Facts'))
  assert.ok(populated.includes('the first fact'))
  assert.ok(!populated.includes('has no entries yet'), 'bootstrap text must not leak into a populated reminder')
  assert.ok(!populated.includes('merely to fill'))
})

test('content that fits inside the budget is never truncated', () => {
  // The regression: an even split stranded characters in blocks that did not
  // want them, so four short entries lost one inside a 4000 budget.
  const parsed = emptyParsed()
  applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'f'.repeat(280), source: 'manual' },
    { op: 'add', category: 'decisions', text: 'd'.repeat(410), source: 'manual' },
    { op: 'add', category: 'lessons', text: 'l'.repeat(320), source: 'manual' },
    { op: 'add', category: 'lessons', text: 'm'.repeat(310), source: 'manual' },
  ], { date: '2026-09-02' })
  const topics = [{ name: 'review-process', bytes: 3570, date: '2026-09-02', summary: '一份复盘' }]
  const rendered = renderMemoryReminder(parsed, { budgetChars: 4000, topics })
  assert.ok(!rendered.includes('omitted'), 'nothing should be dropped when it all fits')
  assert.ok(!rendered.includes('more topic file'), 'the topic index should not be trimmed either')
  assert.ok(rendered.length <= 4000)
  for (const entry of parsed.sections.get('lessons').entries) assert.ok(rendered.includes(entry.id))
})

test('a budget exactly equal to the need does not truncate', () => {
  // Sizing a block as one newline per line overstates it by one, so at the
  // boundary the allocator believed the content did not fit when it did.
  const parsed = emptyParsed()
  for (const category of ['facts', 'decisions', 'lessons', 'preferences']) {
    applyOps(parsed, [
      { op: 'add', category, text: `${category} one `.repeat(9), source: 'manual' },
      { op: 'add', category, text: `${category} two `.repeat(7), source: 'manual' },
    ], { date: '2026-09-02' })
  }
  const topics = [{ name: 'a-topic', bytes: 2048, date: '2026-09-02', summary: 'summary' }]
  const exact = renderMemoryReminder(parsed, { budgetChars: 999999, topics }).length
  for (const budgetChars of [exact, exact + 1, exact + 8]) {
    const rendered = renderMemoryReminder(parsed, { budgetChars, topics })
    assert.ok(!/omitted|more topic file/u.test(rendered), `truncated at budget ${budgetChars} needing ${exact}`)
    assert.ok(rendered.length <= budgetChars)
  }
})

test('allocateBudget hands surplus to the blocks that need it', () => {
  // Small blocks take only what they need; the rest flows to the big one.
  assert.deepEqual(allocateBudget([100, 100, 700], 900), [100, 100, 700])
  // Genuinely over budget: the greedy ones share what the small ones released.
  const grants = allocateBudget([50, 500, 500], 450)
  assert.equal(grants[0], 50, 'a block under its share gets exactly its need')
  assert.equal(grants[1] + grants[2], 400, 'the surplus is redistributed, not stranded')
  assert.ok(grants.reduce((a, b) => a + b, 0) <= 450, 'never over-allocates')
  // Degenerate inputs stay sane.
  assert.deepEqual(allocateBudget([], 100), [])
  assert.deepEqual(allocateBudget([10], 4), [4])
})

test('renderMemoryReminder keeps the WHOLE reminder inside the budget', () => {
  const parsed = emptyParsed()
  for (const category of ['facts', 'decisions', 'lessons', 'preferences']) {
    applyOps(parsed, Array.from({ length: 50 }, (_, index) => ({
      op: 'add', category, text: `padding entry ${index} ${'y'.repeat(120)}`, source: 'auto',
    })), { date: '2026-09-01' })
  }
  const topics = Array.from({ length: 24 }, (_, index) => ({
    name: `topic-${index}`, bytes: 2048, date: '2026-09-01', summary: 'z'.repeat(80),
  }))
  // The preamble, headings, omission lines and topic index used to sit OUTSIDE
  // the budget, so a 4000-char budget rendered ~7.8K of reminder.
  //
  // The tightest probe sits just above the IRREDUCIBLE FLOOR — the preamble
  // plus one kept entry per populated section, which no budget can compress.
  // Grow the preamble and the floor rises with it, so raise this probe rather
  // than assuming the allocator broke: adding the conservative cadence line
  // moved the floor from 2432 to 2540.
  for (const budgetChars of [2600, 4000, 8000, 12000]) {
    for (const withTopics of [topics, []]) {
      const rendered = renderMemoryReminder(parsed, { budgetChars, topics: withTopics })
      assert.ok(rendered.length <= budgetChars, `budget ${budgetChars} produced ${rendered.length} chars`)
    }
  }
  // The topic index is bounded too, and says what it left out.
  const tight = renderMemoryReminder(parsed, { budgetChars: 2500, topics })
  assert.ok(tight.includes('more topic file(s)'))
  assert.ok(tight.includes('omitted; use memory_list'))
  // Below the schema minimum an irreducible floor binds — the preamble plus one
  // entry per populated section — but the result stays bounded and usable.
  const floored = renderMemoryReminder(parsed, { budgetChars: 1, topics })
  assert.ok(floored.includes('## Facts'))
  assert.ok(floored.length < 2600, `floored reminder was ${floored.length} chars`)

  // Worst case: max-length entries in every section plus a max-length topic
  // index. The floor can exceed a near-minimum budget, but by a bounded margin
  // (it was ~9.5x before the budget covered the preamble and index at all).
  const fat = emptyParsed()
  for (const category of ['facts', 'decisions', 'lessons', 'preferences']) {
    applyOps(fat, [{ op: 'add', category, text: 'x'.repeat(300), source: 'auto' }], { date: '2026-09-01' })
  }
  const fatTopics = Array.from({ length: 24 }, () => ({
    name: 't'.repeat(48), bytes: 999999, date: '2026-09-01', summary: 's'.repeat(80),
  }))
  const worst = renderMemoryReminder(fat, { budgetChars: 2500, topics: fatTopics })
  assert.ok(worst.length < 2500 * 1.35, `worst-case overshoot too large: ${worst.length}`)
  // And a comfortable budget is honoured exactly, even for that content.
  assert.ok(renderMemoryReminder(fat, { budgetChars: 3500, topics: fatTopics }).length <= 3500)
})

test('renderMemoryReminder gives the topic index the whole budget when no entries exist', () => {
  const topics = Array.from({ length: 6 }, (_, index) => ({
    name: `topic-${index}`, bytes: 1024, date: '2026-09-01', summary: 'summary text',
  }))
  const rendered = renderMemoryReminder(emptyParsed(), { budgetChars: 4000, topics })
  assert.ok(rendered.length <= 4000)
  for (const topic of topics) assert.ok(rendered.includes(topic.name), `${topic.name} should fit`)
})

test('renderMemoryReminder requires conversation evidence before a delete', () => {
  const parsed = emptyParsed()
  applyOps(parsed, [{ op: 'add', category: 'facts', text: 'some fact', source: 'auto' }], { date: '2026-09-01' })
  const rendered = renderMemoryReminder(parsed, {})
  assert.ok(rendered.includes('concrete evidence'))
  assert.ok(rendered.includes('Other sessions in this project share these files'))
})

test('renderMemoryReminder proactivity levels switch the maintenance rules', () => {
  const parsed = emptyParsed()
  applyOps(parsed, [{ op: 'add', category: 'facts', text: 'some fact', source: 'auto' }], { date: '2026-09-01' })
  const conservative = renderMemoryReminder(parsed, {})
  assert.ok(conservative.includes('when in doubt, do not save'))
  const eager = renderMemoryReminder(parsed, { proactivity: 'eager' })
  assert.ok(eager.includes('Err on the side of saving'))
  assert.ok(eager.includes('do not wait to be asked'))
  assert.ok(!eager.includes('when in doubt, do not save'))
  const balanced = renderMemoryReminder(parsed, { proactivity: 'balanced' })
  assert.ok(balanced.includes('whenever you learn something durable'))
  const fallback = renderMemoryReminder(parsed, { proactivity: 'bogus' })
  assert.ok(fallback.includes('when in doubt, do not save'))
})
