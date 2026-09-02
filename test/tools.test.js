/** Unit tests for what the memory tools report back to the model. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyOps, emptyParsed } from '../lib/store.js'
import { registerMemoryTools } from '../lib/tools.js'

/**
 * Register the real tools against an in-memory store stub. memory_save only
 * needs `mutate` and one config field, so nothing here touches the filesystem.
 * @returns the registered tools by name.
 */
function registerTools(parsed, maxEntriesPerCategory) {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  const store = { mutate: async (cwd, mutator) => mutator(parsed) }
  registerMemoryTools(ctx, store, () => ({ maxEntriesPerCategory }))
  return tools
}

const exec = { agent: { session: { header: { cwd: '/tmp/tools-project' } } } }

test('memory_save reports what the per-category cap destroyed', async () => {
  const parsed = emptyParsed()
  applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'the oldest fact', source: 'manual' },
    { op: 'add', category: 'facts', text: 'the newer fact', source: 'manual' },
  ], { date: '2026-09-01', maxPerCategory: 2 })
  const save = registerTools(parsed, 2).get('memory_save')

  const value = await save.execute({ category: 'facts', content: 'the fact that overflows' }, exec)
  assert.equal(value.status, 'saved')
  assert.equal(value.evicted.length, 1)
  // The TEXT has to come back, not just the id: the entry is already gone, so
  // no later memory_list or memory_search can recover what it said. Flat
  // formatted strings, matching memory_list/memory_search.
  assert.equal(typeof value.evicted[0], 'string')
  assert.ok(value.evicted[0].includes('the oldest fact'))
  assert.ok(/^\[f-[0-9a-f]+\] /u.test(value.evicted[0]))

  const rendered = save.output.render({}, value)[0].text
  assert.ok(rendered.includes('PERMANENTLY DELETED'))
  assert.ok(rendered.includes('the oldest fact'), 'the lost text must be named')
  assert.ok(rendered.includes('memory_write_topic'), 'offer a lossless place to put it')
})

test('a save that fits reports exactly what it reported before', async () => {
  const save = registerTools(emptyParsed(), 50).get('memory_save')
  const value = await save.execute({ category: 'facts', content: 'a fact that fits' }, exec)
  assert.equal(value.status, 'saved')
  assert.equal(value.evicted, undefined, 'no eviction key on an ordinary save')
  const rendered = save.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].text, `Memory saved: [${value.id}] (facts)`)
})

test('memory_forget reports the excess it destroys along the way', async () => {
  // Lowering maxEntriesPerCategory (or hand-editing the file) leaves a section
  // ALREADY over its cap. The prune runs after every op, so a forget then takes
  // the rest of the excess with it — and used to report only the id it was
  // asked to remove.
  const parsed = emptyParsed()
  applyOps(parsed, [1, 2, 3, 4, 5].map((index) => (
    { op: 'add', category: 'facts', text: `entry ${index}`, source: 'manual' }
  )), { date: '2026-09-01', maxPerCategory: 50 })
  const target = parsed.sections.get('facts').entries[4].id
  const forget = registerTools(parsed, 2).get('memory_forget')

  const value = await forget.execute({ id: target }, exec)
  assert.equal(value.removed, true)
  assert.equal(value.text, 'entry 5')
  assert.equal(value.evicted.length, 2, 'the collateral deletions must be reported too')
  const rendered = forget.output.render({}, value)[0].text
  assert.ok(rendered.startsWith('Forgot: entry 5'))
  assert.ok(rendered.includes('PERMANENTLY DELETED'))
  assert.ok(rendered.includes('entry 1') && rendered.includes('entry 2'))
})

test('an ordinary forget reports exactly what it reported before', async () => {
  const parsed = emptyParsed()
  applyOps(parsed, [{ op: 'add', category: 'facts', text: 'a fact to drop', source: 'manual' }], { date: '2026-09-01' })
  const id = parsed.sections.get('facts').entries[0].id
  const forget = registerTools(parsed, 50).get('memory_forget')

  const value = await forget.execute({ id }, exec)
  assert.equal(value.evicted, undefined, 'no eviction key on an ordinary forget')
  assert.equal(forget.output.render({}, value)[0].text, 'Forgot: a fact to drop')
  // A miss still renders its own message, with no eviction section.
  const miss = await forget.execute({ id: 'f-000000' }, exec)
  assert.equal(miss.removed, false)
  assert.equal(forget.output.render({}, miss)[0].text, 'No memory entry found with that id.')
})
