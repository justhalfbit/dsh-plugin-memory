/** Unit tests for distillation pure logic and the injection renderer. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDistillPrompt, extractWindow, parseDistillOutput, renderExisting, resolveTarget } from '../lib/distill.js'
import { buildReminderMessage, renderMemoryReminder } from '../lib/inject.js'
import { applyOps, emptyParsed } from '../lib/store.js'

const userEvent = (text) => ({ type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const pluginEvent = (text) => ({ type: 'user/message', seq: 0, time: 0, data: { id: 'p', role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'x' } } })
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
  assert.equal(renderMemoryReminder(emptyParsed(), {}), undefined)

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
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-plugin-memory')
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
  assert.equal(renderMemoryReminder(emptyParsed(), { topics: [] }), undefined)
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
  for (const budgetChars of [2500, 4000, 8000, 12000]) {
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
