/**
 * dsh-plugin-memory — the seven model-facing memory tools.
 *
 * Raw host-plane registrations (the dsh-plugin-show-image precedent): every
 * agent in every session sees them. Each call resolves its project store from
 * the calling agent's session cwd; direct calls without an agent session fail
 * with a clear message. The registry self-binds each registration to this
 * plugin's fiber, so unload removes the tools.
 *
 * @module dsh-plugin-memory/tools
 */

import { CATEGORY_KEYS, MAX_TOPIC_CHARS, applyOps, countEntries, findEntry, sanitizeTopicName, searchEntries } from './store.js'

const TOPIC_NAME_HINT = 'use letters/digits/CJK plus - or _ (max 48 chars), no path separators, no ".md"'

const CATEGORY_DESCRIPTION =
  'Memory category: "facts" (stable project facts), "decisions" (technical decisions and reasons), ' +
  '"lessons" (pitfalls and how they were resolved), "preferences" (user coding/workflow preferences).'

/** Resolve the calling agent's project cwd or throw a model-readable error. */
function requireCwd(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('memory tools need an agent session with a working directory; none is available for this call')
  }
  return cwd
}

/** Format one entry for model-facing text. */
function entryLine(category, entry) {
  const meta = entry.date === undefined ? '' : ` (${entry.date}, ${entry.source})`
  return `[${entry.id}] (${category}) ${entry.text}${meta}`
}

/**
 * Register the memory tools.
 * @param {object} ctx - host plugin context providing `ctx.tools`.
 * @param {import('./store.js').MemoryStore} store - the shared memory store.
 * @param {() => object} getConfig - live resolved configuration.
 */
export function registerMemoryTools(ctx, store, getConfig) {
  ctx.tools.register({
    name: 'memory_save',
    description:
      'Save one durable memory entry for the current project (persisted across sessions in ' +
      '~/.dsh/memory, injected into future conversations). Use it for long-term facts, decisions, ' +
      'lessons, or user preferences worth remembering — never for secrets or session-specific trivia. ' +
      'Saving an entry whose content already exists returns the existing id.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATEGORY_KEYS, description: CATEGORY_DESCRIPTION },
        content: { type: 'string', description: 'One self-contained sentence to remember (≤300 characters recommended).' },
      },
      required: ['category', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          category: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['id', 'category', 'status'],
      },
      render(args, value) {
        return [{ type: 'text', text: `Memory ${value.status}: [${value.id}] (${value.category})` }]
      },
    },
    async execute(args, exec) {
      const category = CATEGORY_KEYS.includes(args?.category) ? args.category : undefined
      const content = typeof args?.content === 'string' ? args.content.trim() : ''
      if (category === undefined) throw new Error(`category must be one of: ${CATEGORY_KEYS.join(', ')}`)
      if (content.length === 0) throw new Error('content is required')
      if (content.length > 500) throw new Error('content too long: keep one memory entry under 500 characters')
      const cwd = requireCwd(exec)
      const result = await store.mutate(cwd, (parsed) =>
        applyOps(parsed, [{ op: 'add', category, text: content, source: 'manual' }], {
          maxPerCategory: getConfig().maxEntriesPerCategory,
        }))
      const savedId = result.ids.added[0]
      return {
        id: savedId ?? result.ids.duplicates[0] ?? 'unknown',
        category,
        status: savedId !== undefined ? 'saved' : 'duplicate',
      }
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description:
      'Search the current project\'s persisted memory by keywords (case-insensitive term matching ' +
      'across facts/decisions/lessons/preferences). Returns matching entries with their ids.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        category: { type: 'string', enum: CATEGORY_KEYS, description: `Optional filter. ${CATEGORY_DESCRIPTION}` },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          matches: { type: 'array', items: { type: 'string' } },
        },
        required: ['total', 'matches'],
      },
      render(args, value) {
        if (value.total === 0) return [{ type: 'text', text: 'No memory entries matched.' }]
        return [{ type: 'text', text: `${value.total} match(es):\n${value.matches.join('\n')}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query : ''
      if (query.trim().length === 0) throw new Error('query is required')
      const category = CATEGORY_KEYS.includes(args?.category) ? args.category : undefined
      const { parsed } = await store.load(requireCwd(exec))
      const matches = searchEntries(parsed, query, category).slice(0, 20)
      return { total: matches.length, matches: matches.map((match) => entryLine(match.category, match.entry)) }
    },
  })

  ctx.tools.register({
    name: 'memory_list',
    description:
      'List the current project\'s persisted memory entries (optionally one category), including ' +
      'entries omitted from the injected reminder. Also reports the underlying Markdown file path.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATEGORY_KEYS, description: `Optional filter. ${CATEGORY_DESCRIPTION}` },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          total: { type: 'number' },
          entries: { type: 'array', items: { type: 'string' } },
          topics: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'total', 'entries', 'topics'],
      },
      render(args, value) {
        const parts = []
        if (value.total === 0) parts.push(`No memory entries yet (file: ${value.path}).`)
        else parts.push(`${value.total} entr(ies) in ${value.path}:\n${value.entries.join('\n')}`)
        if (value.topics.length > 0) parts.push(`Topic files (full text via memory_read):\n${value.topics.join('\n')}`)
        return [{ type: 'text', text: parts.join('\n\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const category = CATEGORY_KEYS.includes(args?.category) ? args.category : undefined
      const cwd = requireCwd(exec)
      const { parsed, path } = await store.load(cwd)
      const entries = []
      for (const [key, section] of parsed.sections) {
        if (category !== undefined && key !== category) continue
        for (const entry of section.entries) entries.push(entryLine(key, entry))
      }
      const topics = (await store.listTopics(cwd)).map((topic) =>
        `- ${topic.name} (${topic.bytes}B, ${topic.date})${topic.summary.length > 0 ? `: ${topic.summary}` : ''}`)
      return { path, total: category === undefined ? countEntries(parsed) : entries.length, entries, topics }
    },
  })

  ctx.tools.register({
    name: 'memory_forget',
    description:
      'Delete one wrong or outdated memory entry from the current project\'s persisted memory by its ' +
      'id (as shown in the injected reminder, memory_list, or memory_search).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id, e.g. "f-1a2b3c4d".' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['removed', 'text'],
      },
      render(args, value) {
        return [{
          type: 'text',
          text: value.removed ? `Forgot: ${value.text}` : `No memory entry found with that id.`,
        }]
      },
    },
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id.length === 0) throw new Error('id is required')
      if (!/^[a-z]-[0-9a-f]{3,8}$/u.test(id)) {
        throw new Error('invalid id format; expected e.g. "f-1a2b3c4d" — copy it from memory_list or the injected reminder')
      }
      const cwd = requireCwd(exec)
      let removedText = ''
      await store.mutate(cwd, (parsed) => {
        const found = findEntry(parsed, id)
        if (found === undefined) return { changed: false }
        removedText = found.entry.text
        return applyOps(parsed, [{ op: 'forget', id }], { maxPerCategory: getConfig().maxEntriesPerCategory })
      })
      return { removed: removedText.length > 0, text: removedText }
    },
  })

  ctx.tools.register({
    name: 'memory_read',
    description:
      'Read one of the current project\'s memory TOPIC files in full. Topic files hold deeper ' +
      'free-form notes and are never auto-loaded — the injected memory reminder and memory_list ' +
      'only show a one-line index. Call this when an indexed topic becomes relevant to the task.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name exactly as shown in the index, e.g. "debugging" (no path, no .md).' },
      },
      required: ['topic'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['topic', 'path', 'content'],
      },
      render(args, value) {
        return [{ type: 'text', text: `# Topic: ${value.topic} (${value.path})\n\n${value.content}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const topic = sanitizeTopicName(args?.topic)
      if (topic === undefined) throw new Error(`invalid topic name: ${TOPIC_NAME_HINT}`)
      const cwd = requireCwd(exec)
      const found = await store.readTopic(cwd, topic)
      if (found === undefined) {
        const available = await store.listTopics(cwd)
        throw new Error(available.length === 0
          ? 'this project has no topic files yet; create one with memory_write_topic'
          : `no topic "${topic}"; available: ${available.map((entry) => entry.name).join(', ')}`)
      }
      return { topic, path: found.path, content: found.text }
    },
  })

  ctx.tools.register({
    name: 'memory_write_topic',
    description:
      'Create or update one free-form Markdown TOPIC file under the current project\'s memory. ' +
      'Topic files are for deeper notes too long for single memory entries (debugging playbooks, ' +
      'API conventions, architecture walkthroughs). They are never auto-injected: only a one-line ' +
      'index (name + first line) rides the memory reminder, and readers load the full text with ' +
      'memory_read. mode "append" adds a section to the end; "replace" rewrites the whole file.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name (becomes <topic>.md), e.g. "debugging". Reuse an existing name to extend it.' },
        content: { type: 'string', description: 'Markdown content. Make the first line a good summary — it becomes the index line.' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) adds to the end; replace rewrites the file.' },
      },
      required: ['topic', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'number' },
          mode: { type: 'string' },
          created: { type: 'boolean' },
        },
        required: ['topic', 'path', 'bytes', 'mode', 'created'],
      },
      render(args, value) {
        const action = value.created ? 'created' : value.mode === 'replace' ? 'replaced' : 'appended'
        return [{ type: 'text', text: `Topic ${action}: ${value.topic} (${value.bytes} bytes) at ${value.path}` }]
      },
    },
    async execute(args, exec) {
      const topic = sanitizeTopicName(args?.topic)
      if (topic === undefined) throw new Error(`invalid topic name: ${TOPIC_NAME_HINT}`)
      const content = typeof args?.content === 'string' ? args.content.trim() : ''
      if (content.length === 0) throw new Error('content is required')
      // Matches the file cap, so mode "replace" can always rewrite a topic the
      // store accepted — the compaction path the size error points at.
      if (content.length > MAX_TOPIC_CHARS) throw new Error(`content too long for one write: keep it under ${MAX_TOPIC_CHARS} characters`)
      const mode = args?.mode === 'replace' ? 'replace' : 'append'
      const cwd = requireCwd(exec)
      const result = await store.writeTopic(cwd, topic, content, mode)
      return { topic, path: result.path, bytes: result.bytes, mode, created: result.created }
    },
  })

  ctx.tools.register({
    name: 'memory_delete_topic',
    description:
      'Delete one topic file from the current project\'s memory. Use it to retire a topic whose ' +
      'content is obsolete, or to make room when the per-project topic limit is reached. This removes ' +
      'the whole file — to drop a single entry from the main memory list, use memory_forget instead.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name exactly as shown in the index, e.g. "debugging" (no path, no ".md").' },
      },
      required: ['topic'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          path: { type: 'string' },
          deleted: { type: 'boolean' },
        },
        required: ['topic', 'path', 'deleted'],
      },
      render(args, value) {
        return [{
          type: 'text',
          text: value.deleted ? `Topic deleted: ${value.topic} (${value.path})` : `No topic "${value.topic}" to delete.`,
        }]
      },
    },
    async execute(args, exec) {
      const topic = sanitizeTopicName(args?.topic)
      if (topic === undefined) throw new Error(`invalid topic name: ${TOPIC_NAME_HINT}`)
      const cwd = requireCwd(exec)
      const result = await store.deleteTopic(cwd, topic)
      return { topic, path: result.path, deleted: result.deleted }
    },
  })
}
