/**
 * dsh-plugin-memory — Markdown memory store.
 *
 * One `memories.md` per project under `<root>/projects/<slug>/`, where slug is
 * derived from the session's `header.cwd`. The file is the source of truth:
 * human-readable, hand-editable, git-friendly. The parser is tolerant — lines
 * it does not understand are preserved verbatim through every rewrite.
 *
 * Concurrency: one in-process write queue per slug plus a best-effort
 * cross-process lock directory, and atomic temp+rename writes.
 *
 * Zero external dependencies (node:crypto / node:fs / node:path / node:os).
 * @module dsh-plugin-memory/store
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

/** The four memory categories, in canonical file order. */
export const CATEGORIES = [
  { key: 'facts', heading: 'Facts', prefix: 'f' },
  { key: 'decisions', heading: 'Decisions', prefix: 'd' },
  { key: 'lessons', heading: 'Lessons', prefix: 'l' },
  { key: 'preferences', heading: 'Preferences', prefix: 'p' },
]

export const CATEGORY_KEYS = CATEGORIES.map((category) => category.key)

const HEADING_TO_KEY = new Map(CATEGORIES.map((category) => [category.heading.toLowerCase(), category.key]))
const KEY_TO_CATEGORY = new Map(CATEGORIES.map((category) => [category.key, category]))

const FILE_TITLE = '# Project Memory'
const FILE_MARKER = '<!-- dsh-memory v1 -->'

/** Lowercase hex SHA-1 of `text`. */
export function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** Collapse whitespace and lowercase for dedupe comparison. */
export function normalizeText(text) {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Stable content-derived entry id: `<category prefix>-<8 hex chars>`.
 * @param {string} categoryKey - one of {@link CATEGORY_KEYS}.
 * @param {string} text - entry text.
 */
export function entryId(categoryKey, text) {
  const category = KEY_TO_CATEGORY.get(categoryKey)
  if (category === undefined) throw new Error(`unknown memory category: ${categoryKey}`)
  return `${category.prefix}-${sha1(normalizeText(text)).slice(0, 8)}`
}

/**
 * Project slug: readable basename + 8-char path hash, so renamed or same-name
 * directories never collide.
 * @param {string} cwd - absolute project working directory.
 */
export function projectSlug(cwd) {
  const absolute = resolve(cwd)
  const base = basename(absolute)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  const hash = sha1(absolute).slice(0, 8)
  return base.length === 0 ? hash : `${base}-${hash}`
}

/**
 * Project directory name, v2 (sessions-style): the full absolute path made
 * filesystem-safe and readable, plus an 8-hex path hash — the readable part
 * is lossy (like the sessions layout), the hash keeps the mapping
 * collision-free. No leading dash (a shell footgun); over-long components
 * are truncated from the FRONT, keeping the distinctive project-name tail.
 * @param {string} cwd - absolute project working directory.
 */
export function projectDirName(cwd) {
  const absolute = resolve(cwd)
  const hash = sha1(absolute).slice(0, 8)
  let encoded = absolute
    .replace(/[^A-Za-z0-9\u4e00-\u9fff._]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|-+$/gu, '')
  let truncated = false
  while (encoded.length > 0 && Buffer.byteLength(encoded, 'utf8') > 180) {
    encoded = encoded.slice(1)
    truncated = true
  }
  if (truncated) encoded = `…${encoded.replace(/^[-.]+/u, '')}`
  return encoded.length === 0 ? hash : `${encoded}--${hash}`
}

/** An empty parsed document. */
export function emptyParsed() {
  return {
    preamble: [],
    sections: new Map(CATEGORIES.map((category) => [category.key, { entries: [], extra: [] }])),
  }
}

const ENTRY_RE = /^-\s+\[([a-z]-[0-9a-f]{3,8})\]\s+(.*)$/u
const META_RE = /\s*<!--\s*(\d{4}-\d{2}-\d{2})\s+(auto|manual)\s*-->\s*$/u

/**
 * Parse a memories.md document. Tolerant: only `## <known heading>` sections
 * and `- [id] text <!-- date source -->` entry lines are interpreted; every
 * other line is preserved verbatim (preamble before the first known section,
 * `extra` inside one).
 * @param {string} text - full file text.
 */
export function parseMemories(text) {
  const parsed = emptyParsed()
  let current
  for (const line of text.split('\n')) {
    const headingMatch = /^##\s+(.+?)\s*$/u.exec(line)
    if (headingMatch !== null) {
      const key = HEADING_TO_KEY.get(headingMatch[1].toLowerCase())
      if (key !== undefined) {
        current = parsed.sections.get(key)
        continue
      }
    }
    if (current === undefined) {
      if (line.trim() === FILE_TITLE || line.trim() === FILE_MARKER) continue
      parsed.preamble.push(line)
      continue
    }
    const entryMatch = ENTRY_RE.exec(line)
    if (entryMatch === null) {
      if (line.trim() !== '') current.extra.push(line)
      continue
    }
    let body = entryMatch[2]
    let date
    let source = 'manual'
    const metaMatch = META_RE.exec(body)
    if (metaMatch !== null) {
      date = metaMatch[1]
      source = metaMatch[2]
      body = body.slice(0, metaMatch.index)
    }
    const entryText = body.trim()
    if (entryText.length === 0) continue
    current.entries.push({ id: entryMatch[1], text: entryText, date, source })
  }
  while (parsed.preamble.length > 0 && parsed.preamble.at(-1).trim() === '') parsed.preamble.pop()
  while (parsed.preamble.length > 0 && parsed.preamble[0].trim() === '') parsed.preamble.shift()
  return parsed
}

/** Serialize a parsed document back to canonical Markdown. */
export function serializeMemories(parsed) {
  const lines = [FILE_TITLE, FILE_MARKER]
  const preamble = parsed.preamble.filter((line, index, all) => !(line.trim() === '' && (all[index - 1] ?? '').trim() === ''))
  if (preamble.length > 0) {
    lines.push('')
    lines.push(...preamble)
  }
  for (const category of CATEGORIES) {
    const section = parsed.sections.get(category.key)
    lines.push('', `## ${category.heading}`)
    for (const entry of section.entries) {
      const meta = entry.date === undefined ? '' : ` <!-- ${entry.date} ${entry.source} -->`
      lines.push(`- [${entry.id}] ${entry.text}${meta}`)
    }
    if (section.extra.length > 0) lines.push(...section.extra)
  }
  return `${lines.join('\n')}\n`
}

/** Count all entries across sections. */
export function countEntries(parsed) {
  let total = 0
  for (const section of parsed.sections.values()) total += section.entries.length
  return total
}

/** Locate one entry by id. @returns `{ categoryKey, index, entry }` or undefined. */
export function findEntry(parsed, id) {
  for (const [categoryKey, section] of parsed.sections) {
    const index = section.entries.findIndex((entry) => entry.id === id)
    if (index !== -1) return { categoryKey, index, entry: section.entries[index] }
  }
  return undefined
}

/**
 * Apply distillation/tool ops to a parsed document, in place.
 *
 * Ops: `{ op: 'add'|'update'|'forget', category?, text?, id?, source? }`.
 * `add` dedupes by content id and normalized text; `update` replaces the
 * entry named by `id` (falls back to `add` when absent); `forget` removes by
 * id. After all ops, each section is pruned to `maxPerCategory`, dropping the
 * oldest `auto` entries first.
 *
 * @returns `{ changed, applied, skipped, ids }` — applied/skipped are
 *   human-readable audit lines; `ids.added`/`ids.duplicates` are the
 *   structured entry ids for programmatic consumers (memory_save).
 */
export function applyOps(parsed, ops, { date, maxPerCategory = 50 } = {}) {
  const today = date ?? new Date().toISOString().slice(0, 10)
  const applied = []
  const skipped = []
  const ids = { added: [], duplicates: [] }
  let changed = false

  const addEntry = (categoryKey, text, source) => {
    const section = parsed.sections.get(categoryKey)
    if (section === undefined) {
      skipped.push(`unknown category: ${categoryKey}`)
      return undefined
    }
    const cleaned = text.replace(/\s+/gu, ' ').trim()
    if (cleaned.length === 0) {
      skipped.push('empty text')
      return undefined
    }
    const id = entryId(categoryKey, cleaned)
    const normalized = normalizeText(cleaned)
    const duplicate = section.entries.find((entry) => entry.id === id || normalizeText(entry.text) === normalized)
    if (duplicate !== undefined) {
      skipped.push(`duplicate of [${duplicate.id}]`)
      ids.duplicates.push(duplicate.id)
      return duplicate.id
    }
    section.entries.push({ id, text: cleaned, date: today, source })
    applied.push(`+ [${id}] ${cleaned}`)
    ids.added.push(id)
    changed = true
    return id
  }

  for (const op of ops) {
    if (op.op === 'add') {
      addEntry(op.category, op.text ?? '', op.source ?? 'auto')
    } else if (op.op === 'forget') {
      const found = typeof op.id === 'string' ? findEntry(parsed, op.id) : undefined
      if (found === undefined) {
        skipped.push(`no entry with id ${op.id}`)
        continue
      }
      parsed.sections.get(found.categoryKey).entries.splice(found.index, 1)
      applied.push(`- [${op.id}] ${found.entry.text}`)
      changed = true
    } else if (op.op === 'update') {
      const found = typeof op.id === 'string' ? findEntry(parsed, op.id) : undefined
      // Validate the replacement BEFORE removing the original, so a bad
      // update op can never silently destroy the entry it meant to revise.
      const categoryKey = op.category ?? found?.categoryKey ?? 'facts'
      const cleaned = typeof op.text === 'string' ? op.text.replace(/\s+/gu, ' ').trim() : ''
      if (!parsed.sections.has(categoryKey) || cleaned.length === 0) {
        skipped.push(`invalid update (kept ${found === undefined ? 'nothing' : `[${op.id}]`})`)
        continue
      }
      if (found !== undefined) {
        parsed.sections.get(found.categoryKey).entries.splice(found.index, 1)
        changed = true
      }
      addEntry(categoryKey, cleaned, op.source ?? 'auto')
    } else {
      skipped.push(`unknown op: ${op.op}`)
    }
  }

  for (const section of parsed.sections.values()) {
    while (section.entries.length > maxPerCategory) {
      const autoIndex = section.entries.findIndex((entry) => entry.source === 'auto')
      const dropIndex = autoIndex === -1 ? 0 : autoIndex
      const [dropped] = section.entries.splice(dropIndex, 1)
      applied.push(`~ pruned [${dropped.id}]`)
      changed = true
    }
  }

  return { changed, applied, skipped, ids }
}

/**
 * Keyword search: case-insensitive term matching with a simple score
 * (matched terms + whole-phrase bonus).
 */
export function searchEntries(parsed, query, categoryKey) {
  const phrase = normalizeText(query)
  const terms = phrase.split(' ').filter((term) => term.length > 0)
  if (terms.length === 0) return []
  const matches = []
  for (const [key, section] of parsed.sections) {
    if (categoryKey !== undefined && key !== categoryKey) continue
    for (const entry of section.entries) {
      const haystack = normalizeText(entry.text)
      const matched = terms.filter((term) => haystack.includes(term)).length
      if (matched === 0) continue
      const score = matched + (haystack.includes(phrase) ? terms.length : 0)
      matches.push({ category: key, entry, score })
    }
  }
  matches.sort((a, b) => b.score - a.score)
  return matches
}

/* ── Topic files (progressive disclosure, Claude-Code style) ─────────────── */

/** Hard cap on topic files per project. */
export const MAX_TOPIC_FILES = 24
/**
 * Hard cap on one topic file's character length. This is the ONE topic size
 * limit: reads return this many characters and one write may carry this many,
 * so any file the store accepted can always be read in full and rewritten in
 * full. A read cap below this would hand the model a truncated body it could
 * then save back over the complete file.
 */
export const MAX_TOPIC_CHARS = 64000

const TOPIC_NAME_RE = /^[\p{Script=Han}a-z0-9][\p{Script=Han}a-z0-9_-]{0,47}$/u

/**
 * Normalize and validate a topic name (it becomes the file basename, so path
 * separators and traversal are rejected by construction).
 * @returns the normalized name, or undefined when invalid.
 */
export function sanitizeTopicName(name) {
  if (typeof name !== 'string') return undefined
  const cleaned = name.trim().replace(/\.md$/iu, '').toLowerCase()
  return TOPIC_NAME_RE.test(cleaned) ? cleaned : undefined
}

/** First meaningful line of a topic document, for the injected index. */
export function topicSummary(text, max = 80) {
  for (const line of text.split('\n')) {
    const cleaned = line.replace(/^[#>\-*\s]+/u, '').trim()
    if (cleaned.length > 0) return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
  }
  return ''
}

/** Expand `~`/`~/` against the OS home. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Resolve the DSH home (`$DSH_HOME` or `~/.dsh`), matching dsh-home-paths semantics. */
function dshHome() {
  const env = (process.env.DSH_HOME ?? '').trim()
  if (env.length > 0) return resolve(expandHome(env))
  return join(homedir(), '.dsh')
}

const noop = () => {}

/** Lock retries before a caller gives up and proceeds unlocked. */
const MAX_LOCK_ATTEMPTS = 20

/**
 * The cross-session memory store: per-project cached reads, per-project
 * serialized mutations, cross-process lock, atomic writes.
 */
export class MemoryStore {
  /** @param {{ getConfig: () => { memoryDir: string, maxEntriesPerCategory: number }, warn?: (message: string) => void }} options */
  constructor({ getConfig, warn }) {
    this.getConfig = getConfig
    this.warn = warn ?? noop
    /** @type {Map<string, { mtimeMs: number, size: number, text: string }>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<unknown>>} */
    this.queues = new Map()
    /** @type {Map<string, { mtimeMs: number, size: number, summary: string }>} */
    this.topicCache = new Map()
    /** @type {Map<string, string>} resolved (and legacy-migrated) project dirs, keyed by root+cwd. */
    this.projectDirs = new Map()
  }

  /** Memory root directory for the current configuration. */
  root() {
    const configured = (this.getConfig().memoryDir ?? '').trim()
    if (configured.length === 0) return join(dshHome(), 'memory')
    const expanded = expandHome(configured)
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }

  /**
   * Resolve one project's directory, migrating a v1 slug directory to the v2
   * sessions-style name on first access. Single-flight per root+cwd: the
   * PROMISE is memoized synchronously, so concurrent first accesses (pre-step
   * injection, distillation, tool calls) share one resolution instead of
   * racing the rename into a legacy/current split-brain. A failed resolution
   * is evicted so the next call retries.
   */
  projectDir(cwd) {
    const root = this.root()
    const key = `${root}\u0000${resolve(cwd)}`
    const cached = this.projectDirs.get(key)
    if (cached !== undefined) return cached
    const promise = this.resolveProjectDir(root, cwd).catch((error) => {
      if (this.projectDirs.get(key) === promise) this.projectDirs.delete(key)
      throw error
    })
    this.projectDirs.set(key, promise)
    return promise
  }

  /** The single-flight body of {@link projectDir}. */
  async resolveProjectDir(root, cwd) {
    const current = join(root, 'projects', projectDirName(cwd))
    const legacy = join(root, 'projects', projectSlug(cwd))
    try {
      await stat(current)
      return current
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await stat(legacy)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return current // fresh project: nothing to migrate
    }
    try {
      await rename(legacy, current)
      this.warn(`memory: migrated project directory ${legacy} -> ${current}`)
      return current
    } catch {
      // Lost a cross-process race (or rename is not permitted): re-probe and
      // prefer whichever directory actually exists now.
      try {
        await stat(current)
        return current
      } catch {
        return legacy
      }
    }
  }

  /** Absolute memories.md path for one project cwd. */
  async fileFor(cwd) {
    return join(await this.projectDir(cwd), 'memories.md')
  }

  /**
   * Read one project's memory (mtime-cached, so external edits are picked up).
   * @returns `{ path, text, parsed, digest }` — `text` is '' for an absent file.
   */
  async load(cwd) {
    const path = await this.fileFor(cwd)
    let text = ''
    try {
      const info = await stat(path)
      const cached = this.cache.get(path)
      if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        text = cached.text
      } else {
        text = await readFile(path, 'utf8')
        this.cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.cache.delete(path)
    }
    return { path, text, parsed: parseMemories(text), digest: sha1(text) }
  }

  /**
   * Serialize one mutation on the project's queue: lock, fresh read, apply
   * `mutator(parsed)`, atomic write when it reports a change.
   * @param {string} cwd - project working directory.
   * @param {(parsed: object) => { changed: boolean } & Record<string, unknown>} mutator
   * @returns the mutator's result.
   */
  async mutate(cwd, mutator) {
    const path = await this.fileFor(cwd)
    const previous = this.queues.get(path) ?? Promise.resolve()
    const task = previous.catch(noop).then(async () => {
      const dir = join(path, '..')
      await mkdir(dir, { recursive: true })
      const unlock = await this.acquireLock(`${path}.lock`)
      try {
        let text = ''
        try {
          text = await readFile(path, 'utf8')
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        const parsed = parseMemories(text)
        const result = mutator(parsed) ?? { changed: false }
        if (result.changed === true) {
          const next = serializeMemories(parsed)
          await this.writeAtomic(path, next)
          const info = await stat(path)
          this.cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text: next })
        }
        return result
      } finally {
        await unlock()
      }
    })
    this.queues.set(path, task)
    try {
      return await task
    } finally {
      if (this.queues.get(path) === task) this.queues.delete(path)
    }
  }

  /** Absolute topics directory for one project cwd. */
  async topicsDirFor(cwd) {
    return join(await this.projectDir(cwd), 'topics')
  }

  /** Absolute path of one topic file (name must be pre-sanitized). */
  async topicPath(cwd, topic) {
    return join(await this.topicsDirFor(cwd), `${topic}.md`)
  }

  /**
   * Enumerate one project's topic files with size, date, and a cached
   * first-line summary (mtime-invalidated, so external edits are picked up).
   * @returns `{ name, bytes, date, summary }[]`, name-sorted; [] when none.
   */
  async listTopics(cwd) {
    const dir = await this.topicsDirFor(cwd)
    let files
    try {
      files = await readdir(dir)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return []
    }
    const topics = []
    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue
      const path = join(dir, file)
      try {
        const info = await stat(path)
        let cached = this.topicCache.get(path)
        if (cached === undefined || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
          cached = { mtimeMs: info.mtimeMs, size: info.size, summary: topicSummary(await readFile(path, 'utf8')) }
          this.topicCache.set(path, cached)
        }
        topics.push({
          name: file.slice(0, -3),
          bytes: info.size,
          date: new Date(info.mtimeMs).toISOString().slice(0, 10),
          summary: cached.summary,
        })
      } catch {
        continue
      }
    }
    return topics
  }

  /**
   * Read one topic file in full. The bound equals {@link MAX_TOPIC_CHARS}, the
   * store's own write cap, so every file it accepted comes back complete;
   * truncation can only ever affect a hand-written oversized file.
   * @returns `{ path, text }`, or undefined when the topic does not exist.
   */
  async readTopic(cwd, topic, maxChars = MAX_TOPIC_CHARS) {
    const path = await this.topicPath(cwd, topic)
    try {
      const text = await readFile(path, 'utf8')
      return { path, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[... truncated: file longer than ${maxChars} characters ...]` : text }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return undefined
    }
  }

  /**
   * Append to or replace one topic file, on the same per-file queue + lock +
   * atomic-rename discipline as the main document.
   * @returns `{ path, bytes, created }`.
   */
  async writeTopic(cwd, topic, content, mode) {
    const path = await this.topicPath(cwd, topic)
    const previous = this.queues.get(path) ?? Promise.resolve()
    const task = previous.catch(noop).then(async () => {
      await mkdir(join(path, '..'), { recursive: true })
      const unlock = await this.acquireLock(`${path}.lock`)
      try {
        let existing = ''
        let created = false
        try {
          existing = await readFile(path, 'utf8')
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          created = true
          const current = await this.listTopics(cwd)
          if (current.length >= MAX_TOPIC_FILES) {
            throw new Error(`topic file limit reached (${MAX_TOPIC_FILES}); merge related topics, or remove one with memory_delete_topic, before creating another`)
          }
        }
        const body = content.trim()
        const next = mode === 'append' && existing.trim().length > 0
          ? `${existing.replace(/\n+$/u, '')}\n\n${body}\n`
          : `${body}\n`
        if (next.length > MAX_TOPIC_CHARS) {
          throw new Error(`topic file would exceed ${MAX_TOPIC_CHARS} characters; memory_read it, then rewrite a condensed version with mode "replace", or split the new material into another topic`)
        }
        await this.writeAtomic(path, next)
        this.topicCache.delete(path)
        return { path, bytes: Buffer.byteLength(next, 'utf8'), created }
      } finally {
        await unlock()
      }
    })
    this.queues.set(path, task)
    try {
      return await task
    } finally {
      if (this.queues.get(path) === task) this.queues.delete(path)
    }
  }

  /**
   * Delete one topic file, on the same per-file queue + lock discipline as
   * every other topic mutation. Without this the per-project topic cap is a
   * dead end: the model is told to make room but has no way to do it.
   * @returns `{ path, deleted }` — `deleted` is false when no such topic existed.
   */
  async deleteTopic(cwd, topic) {
    const path = await this.topicPath(cwd, topic)
    const previous = this.queues.get(path) ?? Promise.resolve()
    const task = previous.catch(noop).then(async () => {
      // Probe before locking: the lock directory is created NEXT TO the target,
      // so locking a topic whose directory does not exist would fail on mkdir.
      try {
        await stat(path)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        return { path, deleted: false }
      }
      const unlock = await this.acquireLock(`${path}.lock`)
      try {
        await rm(path, { force: true })
        this.topicCache.delete(path)
        return { path, deleted: true }
      } finally {
        await unlock()
      }
    })
    this.queues.set(path, task)
    try {
      return await task
    } finally {
      if (this.queues.get(path) === task) this.queues.delete(path)
    }
  }

  /** Write `content` to `path` via temp + rename; a failed write leaves no temp file behind. */
  async writeAtomic(path, content) {
    const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await writeFile(temp, content, 'utf8')
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(noop)
      throw error
    }
  }

  /**
   * Best-effort cross-process lock: an atomically created lock directory with
   * stale-steal after 5s. In-process callers are already serialized per file.
   *
   * EVERY retry path — contended lock, stolen stale lock, failed steal, lock
   * that vanished mid-inspection — passes through the same attempt bail and
   * the same backoff. An unremovable lock (foreign owner left by a `sudo` run,
   * read-only mount) must degrade into "proceed without the lock", never into
   * an unbounded zero-delay spin that hangs the caller with no timeout while
   * hammering the filesystem.
   */
  async acquireLock(lockPath) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await mkdir(lockPath)
        return async () => {
          await rm(lockPath, { recursive: true, force: true })
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        if (attempt >= MAX_LOCK_ATTEMPTS) {
          this.warn(`memory: lock busy, proceeding without ${lockPath}`)
          return noop
        }
        try {
          const info = await stat(lockPath)
          if (Date.now() - info.mtimeMs > 5000) {
            // Confirm the stale observation immediately before stealing, so a
            // lock that was released and re-acquired fresh in between (its
            // mtime moved) is never deleted from under its live holder.
            const recheck = await stat(lockPath).catch(() => undefined)
            if (recheck !== undefined && recheck.mtimeMs === info.mtimeMs) {
              await rm(lockPath, { recursive: true, force: true })
            }
          }
        } catch {
          // A failed stat or a failed steal is not fatal on its own: fall
          // through to the shared backoff and let the bail decide when to
          // give up, instead of retrying immediately and forever.
        }
        await new Promise((settle) => setTimeout(settle, 50 + Math.random() * 50))
      }
    }
  }
}
