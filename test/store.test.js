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
  MAX_TOPIC_CHARS,
  MAX_TOPIC_FILES,
  MemoryStore,
  applyOps,
  countEntries,
  emptyParsed,
  entryId,
  findEntry,
  localDay,
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
  assert.match(a, /^f-[0-9a-f]{8}$/u)
})

test('localDay stamps the LOCAL calendar day, and a dateless add uses it', () => {
  // Both dates are built from LOCAL components, so east of Greenwich the old
  // toISOString() would report the PREVIOUS day for them — the off-by-one this
  // replaced (an entry saved 01:00 in UTC+8 was dated a day early). Asserting
  // fixed strings keeps the test honest in every zone: it discriminates
  // wherever the offset is non-zero and never fails where it is zero.
  assert.equal(localDay(new Date(2026, 0, 1, 0, 30)), '2026-01-01')
  assert.equal(localDay(new Date(2026, 2, 5, 12, 0)), '2026-03-05', 'month and day are zero-padded')
  // The stamp an entry actually receives when the caller passes no date.
  const parsed = emptyParsed()
  applyOps(parsed, [{ op: 'add', category: 'facts', text: 'dated by default', source: 'manual' }])
  assert.ok(serializeMemories(parsed).includes(`<!-- ${localDay()} manual -->`))
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
  // The cap has to say what it destroyed, text included — the id alone names an
  // entry that is already gone, so nothing could look it up afterwards.
  assert.equal(cap.pruned.length, 1)
  assert.equal(cap.pruned[0].text, 'the build uses vite')
  assert.ok(cap.pruned[0].id.startsWith('f-'))
  assert.deepEqual(first.pruned, [], 'a call that prunes nothing reports nothing')
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

test('a rewrite never silently drops a line it could not parse', () => {
  // The module promises unparsed lines survive every rewrite. An id line whose
  // text is empty is not a usable entry, but it must not vanish either.
  for (const line of ['- [f-22222] ', '- [f-33333] <!-- 2026-01-01 auto -->']) {
    const out = serializeMemories(parseMemories(`## Facts\n${line}`))
    assert.ok(out.includes(line.trim()), `lost: ${JSON.stringify(line)}`)
  }
  // A real entry alongside one still parses normally.
  const mixed = parseMemories('## Facts\n- [f-22222] \n- [f-11111] a real fact')
  assert.equal(mixed.sections.get('facts').entries.length, 1)
  assert.equal(mixed.sections.get('facts').entries[0].text, 'a real fact')
})

test('protectManual refuses silent deletes and rewrites of manual entries', () => {
  const parsed = emptyParsed()
  applyOps(parsed, [
    { op: 'add', category: 'facts', text: 'written through a visible tool call', source: 'manual' },
    { op: 'add', category: 'facts', text: 'written by an earlier distillation', source: 'auto' },
  ], { date: '2026-09-02' })
  const manualId = parsed.sections.get('facts').entries[0].id
  const autoId = parsed.sections.get('facts').entries[1].id

  const forget = applyOps(parsed, [{ op: 'forget', id: manualId }], { protectManual: true })
  assert.equal(forget.changed, false)
  assert.match(forget.skipped[0], /protected manual entry/u)
  assert.equal(findEntry(parsed, manualId).entry.text, 'written through a visible tool call')

  // An update is destructive too (remove + re-add), so it is refused as well —
  // and dropped outright rather than degraded into a contradictory extra entry.
  const update = applyOps(parsed, [{ op: 'update', id: manualId, category: 'facts', text: 'a silent rewrite' }], { protectManual: true })
  assert.equal(update.changed, false)
  assert.match(update.skipped[0], /protected manual entry/u)
  assert.equal(findEntry(parsed, manualId).entry.text, 'written through a visible tool call')
  assert.equal(parsed.sections.get('facts').entries.length, 2, 'no contradictory pair left behind')

  // The pass still curates its OWN auto entries, and may still add.
  const ownWork = applyOps(parsed, [
    { op: 'update', id: autoId, category: 'facts', text: 'a corrected auto entry', source: 'auto' },
    { op: 'add', category: 'lessons', text: 'a brand new lesson', source: 'auto' },
  ], { protectManual: true })
  assert.equal(ownWork.changed, true)
  assert.equal(findEntry(parsed, autoId), undefined)
  assert.ok(parsed.sections.get('facts').entries.some((entry) => entry.text === 'a corrected auto entry'))
  assert.equal(parsed.sections.get('lessons').entries.length, 1)

  // The visible tool path is unrestricted: it defaults to protectManual off.
  const visible = applyOps(parsed, [{ op: 'forget', id: manualId }], {})
  assert.equal(visible.changed, true)
  assert.equal(findEntry(parsed, manualId), undefined)
})

test('protectManual also shields hand-written entries that carry no source meta', () => {
  // parseMemories defaults a bare entry line to `manual`, so a user's own
  // hand-edited note is protected without needing any annotation.
  const parsed = parseMemories(['## Facts', '- [f-11111] hand written by the user'].join('\n'))
  assert.equal(parsed.sections.get('facts').entries[0].source, 'manual')
  const result = applyOps(parsed, [{ op: 'forget', id: 'f-11111' }], { protectManual: true })
  assert.equal(result.changed, false)
  assert.equal(findEntry(parsed, 'f-11111').entry.text, 'hand written by the user')
})

test('acquireLock gives up instead of spinning when a stale lock cannot be removed', {
  // The setup makes the steal fail by removing write permission from the parent
  // directory, which root ignores — skip rather than fail in a root container.
  skip: process.getuid?.() === 0 ? 'requires a non-root user' : false,
}, async () => {
  const { chmod, utimes } = await import('node:fs/promises')
  const root = await mkdtemp(join(scratch, 'dshmem-'))
  const cwd = '/tmp/lock-bail-project'
  const dir = join(root, 'projects', projectDirName(cwd))
  await mkdir(dir, { recursive: true })
  const lock = join(dir, 'memories.md.lock')
  await mkdir(lock)
  // Old enough to look stale, inside a directory that forbids the removal:
  // the steal path fails on every attempt.
  const stale = new Date(Date.now() - 60000)
  await utimes(lock, stale, stale)
  await chmod(dir, 0o555)
  try {
    const warnings = []
    const store = new MemoryStore({ getConfig: () => ({ memoryDir: root }), warn: (message) => warnings.push(message) })
    const started = Date.now()
    const unlock = await store.acquireLock(lock)
    // Bounded: it returns a no-op unlock rather than looping forever.
    assert.equal(typeof unlock, 'function')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /lock busy, proceeding without/u)
    // And it backed off between attempts rather than spinning hot.
    assert.ok(Date.now() - started >= 20 * 50, 'expected bounded retries to back off')
  } finally {
    await chmod(dir, 0o755)
  }
})

test('topic read and single-write bounds both equal the file cap', async () => {
  const root = await mkdtemp(join(scratch, 'dshmem-'))
  const store = new MemoryStore({ getConfig: () => ({ memoryDir: root }) })
  const cwd = '/tmp/topic-bounds-project'
  // Fill a topic close to the file cap, then confirm a full read round-trips:
  // a read bound below the write bound would hand back a truncated body that a
  // later "replace" would save over the complete file.
  const body = `# big\n${'A'.repeat(MAX_TOPIC_CHARS - 200)}`
  await store.writeTopic(cwd, 'big', body, 'replace')
  const read = await store.readTopic(cwd, 'big')
  assert.ok(!read.text.includes('truncated'), 'a legal topic must never read back truncated')
  assert.equal(read.text.trim(), body)
  // The whole body can therefore be rewritten in one replace.
  const rewritten = await store.writeTopic(cwd, 'big', read.text, 'replace')
  assert.ok(rewritten.bytes > 0)
})

test('deleteTopic removes a topic and frees a slot at the per-project cap', async () => {
  const root = await mkdtemp(join(scratch, 'dshmem-'))
  const store = new MemoryStore({ getConfig: () => ({ memoryDir: root }) })
  const cwd = '/tmp/topic-delete-project'
  for (let index = 0; index < MAX_TOPIC_FILES; index += 1) {
    await store.writeTopic(cwd, `topic-${index}`, 'x', 'replace')
  }
  await assert.rejects(store.writeTopic(cwd, 'one-too-many', 'x', 'replace'), /topic file limit reached/u)
  const removed = await store.deleteTopic(cwd, 'topic-0')
  assert.equal(removed.deleted, true)
  assert.equal(await store.readTopic(cwd, 'topic-0'), undefined)
  assert.equal((await store.listTopics(cwd)).length, MAX_TOPIC_FILES - 1)
  // The freed slot is usable, so the cap is no longer a dead end.
  const created = await store.writeTopic(cwd, 'one-too-many', 'x', 'replace')
  assert.equal(created.created, true)
  // Deleting an absent topic is a reported no-op, not an error.
  assert.deepEqual((await store.deleteTopic(cwd, 'never-existed')).deleted, false)
})

test('applyOps update validates before destroying and reports structured ids', () => {
  const parsed = emptyParsed()
  const first = applyOps(parsed, [{ op: 'add', category: 'facts', text: 'keep me', source: 'auto' }], { date: '2026-09-01' })
  assert.equal(first.ids.added.length, 1)
  const id = first.ids.added[0]
  // invalid category: the original entry must survive
  const badCategory = applyOps(parsed, [{ op: 'update', id, category: 'bogus', text: 'x', source: 'auto' }], { date: '2026-09-01' })
  assert.equal(badCategory.changed, false)
  assert.equal(findEntry(parsed, id).entry.text, 'keep me')
  // empty replacement text: the original entry must survive
  const emptyText = applyOps(parsed, [{ op: 'update', id, category: 'facts', text: '   ', source: 'auto' }], { date: '2026-09-01' })
  assert.equal(emptyText.changed, false)
  assert.equal(findEntry(parsed, id).entry.text, 'keep me')
  // duplicate add reports the existing id structurally
  const dup = applyOps(parsed, [{ op: 'add', category: 'facts', text: 'KEEP  me', source: 'manual' }], { date: '2026-09-01' })
  assert.deepEqual(dup.ids.duplicates, [id])
  assert.equal(dup.ids.added.length, 0)
})
