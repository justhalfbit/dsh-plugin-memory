/**
 * Contract tests for the host half against the DSH >= 0.2 settings model:
 * the volatile `Config` the Loader parses, the live reader every subsystem
 * shares, and the page policy registered with the optional Settings service.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, DEFAULTS, apply, configReader } from '../lib/index.js'

/** Commit a new value into a running reference, as the Loader does. */
function commit(ref, value) {
	ref[Symbol.for('cosmokit.volatile.write')](value)
}

test('every Config field is volatile, so the Settings form exposes all of them', () => {
	const parsed = Config({})
	for (const key of Object.keys(DEFAULTS)) {
		assert.equal(typeof parsed[key]?.get, 'function', `${key} should parse to a reference`)
		assert.deepEqual(parsed[key].get(), DEFAULTS[key])
	}
})

test('Config rejects values its bounds refuse', () => {
	assert.throws(() => Config({ injectBudgetChars: 10 }))
	assert.throws(() => Config({ proactivity: 'reckless' }))
})

test('the reader follows committed references without a remount', () => {
	const parsed = Config({ injectBudgetChars: 9000 })
	const read = configReader(parsed)
	assert.equal(read().injectBudgetChars, 9000)
	commit(parsed.proactivity, 'eager')
	assert.equal(read().proactivity, 'eager')
	assert.equal(read().enabled, true)
})

test('the reader passes plain values through and fills defaults', () => {
	const read = configReader({ enabled: false, cooldownTurns: null })
	assert.equal(read().enabled, false)
	assert.equal(read().cooldownTurns, DEFAULTS.cooldownTurns)
	assert.deepEqual(configReader(undefined)(), DEFAULTS)
})

/** A host context stub: records tool registrations, listeners, and the Settings child. */
function hostContext() {
	const tools = new Map()
	const injects = []
	const effects = []
	const fiber = { id: 'memory-fiber' }
	const ctx = {
		fiber,
		logger: { info() {}, warn() {} },
		tools: { register: (tool) => tools.set(tool.name, tool) },
		llm: {},
		agents: { get: () => undefined },
		on: () => () => {},
		effect: (fn) => { effects.push(fn()) },
		inject: (deps, callback) => injects.push({ deps, callback }),
	}
	return { ctx, tools, injects, effects, fiber }
}

test('apply asks Settings for no auto-generated page, owned by the plugin fiber', () => {
	const { ctx, injects, fiber } = hostContext()
	apply(ctx, Config({}))
	const child = injects.find((row) => row.deps.includes('settings'))
	assert.ok(child, 'settings stays an optional child inject')
	const calls = []
	const disposers = []
	child.callback({
		settings: { configure: (presentation, owner) => { calls.push({ presentation, owner }); return () => {} } },
		effect: (fn) => { disposers.push(fn()) },
	})
	assert.deepEqual(calls, [{ presentation: { auto: false }, owner: fiber }])
	assert.equal(typeof disposers[0], 'function', 'the policy is released with the child')
})

test('apply tolerates a Settings service without configure', () => {
	const { ctx, injects } = hostContext()
	apply(ctx, Config({}))
	const child = injects.find((row) => row.deps.includes('settings'))
	assert.doesNotThrow(() => child.callback({ settings: {}, effect: () => {} }))
})

test('apply registers the seven memory tools', () => {
	const { ctx, tools } = hostContext()
	apply(ctx, Config({}))
	assert.deepEqual([...tools.keys()].sort(), [
		'memory_delete_topic', 'memory_forget', 'memory_list', 'memory_read',
		'memory_save', 'memory_search', 'memory_write_topic',
	])
})
