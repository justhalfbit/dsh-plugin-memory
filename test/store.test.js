/** Unit tests for the Markdown memory store (pure logic + MemoryStore I/O). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Workspace-local scratch root (system tmp is outside the sandbox). */
const scratch = join(import.meta.dirname, '.tmp')
await mkdir(scratch, { recursive: true })
test.after(async () => {
  await rm(scratch, { recursive: true, force: true })
})
import {
  MemoryStore,
  applyOps,
  countEntries,
  emptyParsed,
  entryId,
  findEntry,
  parseMemories,
  projectDirName,
  projectSlug,
  sanitizeTopicName,
  searchEntries,
  serializeMemories,
  topicSummary,
} from '../lib/store.js'

test('entryId is stable across whitespace/case', () => {
  const a = entryId('facts', 'Vite 构建入口在 apps/web')
  const b = entryId('facts', '  vite 构建入口在   APPS/WEB ')
  assert.equal(a, b)
  assert.match(a, /^f-[0-9a-f]{5}$/u)
})

test('projectSlug is readable and collision-safe', () => {
  const slug = projectSlug('/Users/x/DeepSeekHarness/2026-08-31-记忆插件开发')
  assert.match(slug, /^2026-08-31-记忆插件开发-[0-9a-f]{8}$/u)
  assert.notEqual(projectSlug('/a/proj'), projectSlug('/b/proj'))
})

test('parse/serialize round-trips entries and preserves unknown lines', () => {
  const text = [
    '# Project Memory',
    '<!-- dsh-memory v1 -->',
    '',
    'hand-written preamble note',
    '',
    '## Facts',
    '- [f-11111] fact one <!-- 2026-08-30 auto -->',
    '- not an entry, kept verbatim',
    '',
    '## Decisions',
    '- [d-22222] decision one <!-- 2026-08-31 manual -->',
    '',
    '## Lessons',
    '',
    '## Preferences',
    '',
  ].join('\n')
  const parsed = parseMemories(text)
  assert.equal(parsed.sections.get('facts').entries.length, 1)
  assert.equal(parsed.sections.get('facts').entries[0].source, 'auto')
  assert.deepEqual(parsed.sections.get('facts').extra, ['- not an entry, kept verbatim'])
  assert.equal(parsed.sections.get('decisions').entries[0].text, 'decision one')
  assert.deepEqual(parsed.preamble, ['hand-written preamble note'])
  const out = serializeMemories(parsed)
  const reparsed = parseMemories(out)
  assert.equal(countEntries(reparsed), 2)
  assert.deepEqual(reparsed.sections.get('facts').extra, ['- not an entry, kept verbatim'])
  assert.ok(out.includes('- [f-11111] fact one <!-- 2026-08-30 auto -->'))
})

test('applyOps add dedupes by content and honours per-category cap', () => {
  const parsed = emptyParsed()
  const first = applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'the build uses vite', source: 'auto' },
    { op: 'add', category: 'facts', text: 'The build   uses VITE', source: 'auto' },
  ], { date: '2026-08-31', maxPerCategory: 50 })
  assert.equal(first.changed, true)
  assert.equal(parsed.sections.get('facts').entries.length, 1)
  assert.equal(first.skipped.length, 1)

  const cap = applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'entry two', source: 'manual' },
    { op: 'add', category: 'facts', text: 'entry three', source: 'auto' },
  ], { date: '2026-08-31', maxPerCategory: 2 })
  assert.equal(cap.changed, true)
  const entries = parsed.sections.get('facts').entries
  assert.equal(entries.length, 2)
  // oldest auto entry pruned first; the manual entry survives
  assert.ok(entries.some((entry) => entry.text === 'entry two'))
  assert.ok(!entries.some((entry) => entry.text === 'the build uses vite'))
})

test('applyOps update replaces by id and forget removes', () => {
  const parsed = emptyParsed()
  applyOps(parsed, [{ op: 'add', category: 'decisions', text: 'use sqlite', source: 'auto' }], { date: '2026-08-31' })
  const id = parsed.sections.get('decisions').entries[0].id
  applyOps(parsed, [{ op: 'update', id, category: 'decisions', text: 'use markdown files instead of sqlite', source: 'auto' }], { date: '2026-08-31' })
  assert.equal(parsed.sections.get('decisions').entries.length, 1)
  assert.equal(parsed.sections.get('decisions').entries[0].text, 'use markdown files instead of sqlite')
  assert.equal(findEntry(parsed, id), undefined)

  const newId = parsed.sections.get('decisions').entries[0].id
  const forget = applyOps(parsed, [{ op: 'forget', id: newId }], {})
  assert.equal(forget.changed, true)
  assert.equal(countEntries(parsed), 0)
  const miss = applyOps(parsed, [{ op: 'forget', id: 'f-zzzzz' }], {})
  assert.equal(miss.changed, false)
  assert.equal(miss.skipped.length, 1)
})

test('searchEntries scores phrase matches above single terms', () => {
  const parsed = emptyParsed()
  applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'build uses vite and pnpm', source: 'auto' },
    { op: 'add', category: 'lessons', text: 'pnpm strict node_modules broke the link', source: 'auto' },
  ], { date: '2026-08-31' })
  const matches = searchEntries(parsed, 'pnpm strict')
  assert.equal(matches.length, 2)
  assert.equal(matches[0].category, 'lessons')
  assert.equal(searchEntries(parsed, 'pnpm', 'facts').length, 1)
  assert.equal(searchEntries(parsed, 'nothing-here').length, 0)
})

test('MemoryStore mutate writes atomically, serializes, and load caches by mtime', async () => {
  const root = await mkdtemp(join(scratch, "dshmem-"))
  const store = new MemoryStore({ getConfig: () => ({ memoryDir: root, maxEntriesPerCategory: 50 }) })
  const cwd = '/tmp/fake-project'

  await Promise.all([
    store.mutate(cwd, (parsed) => applyOps(parsed, [{ op: 'add', category: 'facts', text: 'alpha', source: 'auto' }], { date: '2026-08-31' })),
    store.mutate(cwd, (parsed) => applyOps(parsed, [{ op: 'add', category: 'facts', text: 'beta', source: 'auto' }], { date: '2026-08-31' })),
  ])
  const loaded = await store.load(cwd)
  assert.equal(countEntries(loaded.parsed), 2)
  assert.ok(loaded.path.startsWith(join(root, 'projects')))

  // external edit is picked up (mtime cache invalidation)
  const edited = loaded.text.replace('alpha', 'alpha EDITED')
  await writeFile(loaded.path, edited, 'utf8')
  const reloaded = await store.load(cwd)
  assert.ok(reloaded.parsed.sections.get('facts').entries.some((entry) => entry.text === 'alpha EDITED'))

  // unparseable content survives a mutation
  await writeFile(loaded.path, `${edited}\nrandom trailing note\n`, 'utf8')
  await store.mutate(cwd, (parsed) => applyOps(parsed, [{ op: 'add', category: 'lessons', text: 'gamma', source: 'manual' }], { date: '2026-08-31' }))
  const final = await readFile(loaded.path, 'utf8')
  assert.ok(final.includes('random trailing note'))
  assert.ok(final.includes('gamma'))
})

test('MemoryStore.load returns empty parsed for absent file', async () => {
  const root = await mkdtemp(join(scratch, "dshmem-"))
  await mkdir(join(root, 'projects'), { recursive: true })
  const store = new MemoryStore({ getConfig: () => ({ memoryDir: root }) })
  const loaded = await store.load('/tmp/never-written')
  assert.equal(loaded.text, '')
  assert.equal(countEntries(loaded.parsed), 0)
})

test('sanitizeTopicName validates and normalizes', () => {
  assert.equal(sanitizeTopicName('Debugging.md'), 'debugging')
  assert.equal(sanitizeTopicName('  api-design '), 'api-design')
  assert.equal(sanitizeTopicName('调试排坑'), '调试排坑')
  assert.equal(sanitizeTopicName('../etc/passwd'), undefined)
  assert.equal(sanitizeTopicName('a/b'), undefined)
  assert.equal(sanitizeTopicName(''), undefined)
  assert.equal(sanitizeTopicName('-leading'), undefined)
})

test('topicSummary extracts the first meaningful line', () => {
  assert.equal(topicSummary('# Debugging 手册\n\n正文'), 'Debugging 手册')
  assert.equal(topicSummary('\n\n- 列表开头的行\n'), '列表开头的行')
  assert.equal(topicSummary(''), '')
  assert.ok(topicSummary(`# ${'x'.repeat(200)}`).length <= 80)
})

test('writeTopic/readTopic/listTopics round-trip with append and replace', async () => {
  const root = await mkdtemp(join(scratch, 'dshmem-'))
  const store = new MemoryStore({ getConfig: () => ({ memoryDir: root }) })
  const cwd = '/tmp/topic-project'
  const first = await store.writeTopic(cwd, 'debugging', '# 调试手册\n\n第一节', 'append')
  assert.equal(first.created, true)
  const second = await store.writeTopic(cwd, 'debugging', '第二节', 'append')
  assert.equal(second.created, false)
  const read = await store.readTopic(cwd, 'debugging')
  assert.ok(read.text.includes('第一节') && read.text.includes('第二节'))
  const topics = await store.listTopics(cwd)
  assert.equal(topics.length, 1)
  assert.equal(topics[0].name, 'debugging')
  assert.equal(topics[0].summary, '调试手册')
  await store.writeTopic(cwd, 'debugging', '全新内容', 'replace')
  assert.equal((await store.readTopic(cwd, 'debugging')).text.trim(), '全新内容')
  assert.equal(await store.readTopic(cwd, 'missing'), undefined)
  assert.equal((await store.listTopics('/tmp/no-topics-project')).length, 0)
})

test('projectDirName encodes the full path readably with a collision hash', () => {
  const name = projectDirName('/Users/x/DeepSeekHarness/2026-08-31-记忆插件开发')
  assert.match(name, /^Users-x-DeepSeekHarness-2026-08-31-记忆插件开发--[0-9a-f]{8}$/u)
  // the readable part is lossy, the hash disambiguates
  assert.notEqual(projectDirName('/a/b-c'), projectDirName('/a/b/c'))
  // over-long paths truncate from the front, keeping the tail + hash
  const long = projectDirName(`/very/${'深'.repeat(120)}/project-tail`)
  assert.ok(Buffer.byteLength(long, 'utf8') < 220)
  assert.ok(long.includes('project-tail'))
  assert.ok(long.startsWith('…'))
})

test('legacy v1 slug directories migrate to v2 names on first access', async () => {
  const root = await mkdtemp(join(scratch, 'dshmem-'))
  const cwd = '/tmp/migrate-project'
  const legacyDir = join(root, 'projects', projectSlug(cwd))
  await mkdir(join(legacyDir, 'topics'), { recursive: true })
  await writeFile(join(legacyDir, 'memories.md'), [
    '# Project Memory', '<!-- dsh-memory v1 -->', '',
    '## Facts', '- [f-11111] legacy fact <!-- 2026-08-31 auto -->', '',
    '## Decisions', '', '## Lessons', '', '## Preferences', '',
  ].join('\n'), 'utf8')
  await writeFile(join(legacyDir, 'topics', 'old.md'), '# 旧专题\n\n内容\n', 'utf8')

  const store = new MemoryStore({ getConfig: () => ({ memoryDir: root }) })
  const loaded = await store.load(cwd)
  assert.ok(loaded.path.includes(projectDirName(cwd)))
  assert.ok(loaded.parsed.sections.get('facts').entries.some((entry) => entry.text === 'legacy fact'))
  // topics moved along with the directory
  const topics = await store.listTopics(cwd)
  assert.equal(topics.length, 1)
  assert.equal(topics[0].name, 'old')
  // the legacy directory is gone
  await assert.rejects(readFile(join(legacyDir, 'memories.md'), 'utf8'), /ENOENT/u)
  // a fresh project (no legacy dir) just uses the v2 name
  const fresh = await store.load('/tmp/brand-new-project')
  assert.ok(fresh.path.includes(projectDirName('/tmp/brand-new-project')))
})

test('projectDir resolution is single-flight under concurrent first access', async () => {
  const root = await mkdtemp(join(scratch, 'dshmem-'))
  const cwd = '/tmp/race-project'
  const legacyDir = join(root, 'projects', projectSlug(cwd))
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, 'memories.md'), '# Project Memory\n<!-- dsh-memory v1 -->\n\n## Facts\n- [f-22222] race fact <!-- 2026-08-31 auto -->\n\n## Decisions\n\n## Lessons\n\n## Preferences\n', 'utf8')

  const store = new MemoryStore({ getConfig: () => ({ memoryDir: root }) })
  // Concurrent first accesses from different call sites share one resolution.
  const [a, b, listed] = await Promise.all([
    store.projectDir(cwd),
    store.load(cwd),
    store.listTopics(cwd),
  ])
  assert.equal(a, join(root, 'projects', projectDirName(cwd)))
  assert.ok(b.path.startsWith(a))
  assert.ok(Array.isArray(listed))
  // Exactly one project directory remains — no legacy/current split-brain.
  const { readdir } = await import('node:fs/promises')
  const dirs = await readdir(join(root, 'projects'))
  assert.deepEqual(dirs.sort(), [projectDirName(cwd)])
  assert.ok(b.parsed.sections.get('facts').entries.some((entry) => entry.text === 'race fact'))
})
