/**
 * Contract tests for the browser half against the DSH >= 0.2 client surface:
 * the services it injects, the Plugins-page slot it registers into, and the
 * one revision-fenced mutation a save sends through `configForms`.
 *
 * lib/client.js is a hand-written lazy-CJS bundle, so it is evaluated here
 * against a stub `window.__ModuleLoader__`, a minimal element factory in
 * place of React, and an in-memory configuration form.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** `save` is fire-and-forget (the button's handler); let its awaits drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Evaluate the bundle and return its module exports. */
function loadClient({ document } = {}) {
	let registered
	const window = { __ModuleLoader__: { load: (record) => { registered = record } } }
	const effects = []
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
		useEffect: (fn) => { effects.push(fn) },
		useState: (initial) => [initial, () => {}],
	}
	const store = {
		createSnapshotStore: (initial) => {
			let current = initial
			const listeners = new Set()
			return {
				getSnapshot: () => current,
				subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
				set: (next) => { current = next; for (const listener of listeners) listener() },
			}
		},
	}
	const modules = { react: React, '@deepseek-ai/dsh-client-store': store }
	new Function('window', 'document', SOURCE)(window, document)
	const exports = registered.factory((id) => {
		if (!(id in modules)) throw new Error(`module not found: ${id}`)
		return modules[id]
	})
	return { id: registered.id, exports, effects }
}

const SERVED = {
	enabled: true, autoDistill: false, memoryDir: '', injectBudgetChars: 64000, distillMinChars: 2500,
	cooldownTurns: 3, distillProvider: '', distillModel: '', maxEntriesPerCategory: 50,
	topicIndexInInject: true, proactivity: 'conservative',
}

/** An in-memory stand-in for `ctx.configForms.get('memory')`; `user` overrides land in `value`. */
function fakeForm({ answer = true, user = {} } = {}) {
	let snapshot = {
		status: 'ready',
		value: { ...SERVED, ...user },
		base: { ...SERVED },
		user: { ...user },
		revision: 7,
		writable: true,
		mode: 'host',
	}
	const listeners = new Set()
	const calls = []
	return {
		calls,
		bump(patch) {
			snapshot = { ...snapshot, ...patch }
			for (const listener of listeners) listener()
		},
		getSnapshot: () => snapshot,
		subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
		mutate: async (ops, expectedRevision) => {
			calls.push({ ops, expectedRevision })
			return answer
		},
		set: () => { throw new Error('page must write through one mutate') },
		unset: () => { throw new Error('page must write through one mutate') },
	}
}

/** Mount `apply` against stub services; returns the registration it made. */
function mount(form, { served = true } = {}) {
	const { exports } = loadClient()
	const disposers = []
	const registrations = []
	const ctx = {
		effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
		configForms: {
			get: (entryId) => { assert.equal(entryId, 'memory'); return form },
			whileServed: (namespaces, register) => {
				assert.deepEqual(namespaces, ['memory'])
				return served ? register(new Set(namespaces)) : () => {}
			},
		},
		slots: {
			inject: (name, fn) => { assert.equal(name, 'plugins.bundle.config'); return fn() },
			register: (options, component) => { registrations.push({ options, component }); return () => {} },
		},
	}
	exports.apply(ctx)
	return { exports, registrations, disposers }
}

test('injects the DSH 0.2 services (no retired settingsScope)', () => {
	const { id, exports } = loadClient()
	assert.equal(id, 'dsh-plugin-memory')
	assert.deepEqual(exports.inject, ['slots', 'configForms'])
})

test('registers the bundle page keyed by package name while memory is served', () => {
	const { registrations } = mount(fakeForm())
	assert.equal(registrations.length, 1)
	assert.equal(registrations[0].options.name, 'plugins.bundle.config')
	assert.equal(registrations[0].options.key, 'dsh-plugin-memory')
})

test('registers nothing while the Host does not serve memory', () => {
	const { registrations } = mount(fakeForm(), { served: false })
	assert.equal(registrations.length, 0)
})

test('a save sends one atomic mutation fenced at the revision drafts were read at', async () => {
	const form = fakeForm({ user: { enabled: false, distillModel: 'cheap-model' } })
	const { registrations } = mount(form)
	const face = registrations[0].options.inject()
	face.edit('injectBudgetChars', ' 9000 ')
	form.bump({ revision: 8 }) // a later unrelated change must not move the fence
	face.toggle('proactivity', 'eager')
	face.resetField('enabled')
	face.edit('distillModel', '')
	face.save()
	await settle()
	assert.equal(form.calls.length, 1)
	assert.equal(form.calls[0].expectedRevision, 7)
	assert.deepEqual(form.calls[0].ops, [
		{ op: 'set', path: ['injectBudgetChars'], value: 9000 },
		{ op: 'set', path: ['proactivity'], value: 'eager' },
		{ op: 'unset', path: ['enabled'] },
		{ op: 'unset', path: ['distillModel'] },
	])
	const state = face.hooks.memoryCard.getSnapshot()
	assert.equal(state.dirty, false)
	assert.equal(state.failed, false)
})

test('a refused save (false, not a throw) keeps the drafts and reports failure', async () => {
	const form = fakeForm({ answer: false })
	const { registrations } = mount(form)
	const face = registrations[0].options.inject()
	face.edit('cooldownTurns', '5')
	face.save()
	await settle()
	const state = face.hooks.memoryCard.getSnapshot()
	assert.equal(state.failed, true)
	assert.equal(state.dirty, true)
	assert.equal(state.fields.cooldownTurns.text, '5')
})

test('invalid numbers block the save', async () => {
	const form = fakeForm()
	const { registrations } = mount(form)
	const face = registrations[0].options.inject()
	face.edit('cooldownTurns', 'abc')
	face.save()
	await settle()
	assert.equal(form.calls.length, 0)
	assert.equal(face.hooks.memoryCard.getSnapshot().invalid, true)
})

test('summary view renders the one-liner; page view renders the form', () => {
	const form = fakeForm()
	const { registrations } = mount(form)
	const { component, options } = registrations[0]
	const face = options.inject()
	const props = { ...face, useMemoryCard: (select) => select(face.hooks.memoryCard.getSnapshot()) }
	assert.equal(typeof component({ ...props, view: 'summary' }), 'string')
	const page = component({ ...props, view: 'page' })
	assert.equal(page.props.className, 'dshmem-page')
})

test('no-op edits are not dirty and never become overrides', async () => {
	const form = fakeForm()
	const { registrations } = mount(form)
	const face = registrations[0].options.inject()
	face.edit('injectBudgetChars', '64000 ') // back at the served value
	face.toggle('enabled', true) // already true
	face.resetField('cooldownTurns') // not overridden
	face.edit('distillModel', '') // blank of a field that is not overridden
	const state = face.hooks.memoryCard.getSnapshot()
	assert.equal(state.dirty, false)
	for (const field of ['injectBudgetChars', 'enabled', 'cooldownTurns', 'distillModel']) {
		assert.equal(state.fields[field].overridden, false, field + ' must not show an override')
	}
	face.save()
	await settle()
	assert.equal(form.calls.length, 0)
})

test('a real edit after no-ops writes only the real change', async () => {
	const form = fakeForm()
	const { registrations } = mount(form)
	const face = registrations[0].options.inject()
	face.toggle('enabled', true)
	form.bump({ revision: 9 })
	face.edit('cooldownTurns', '6')
	face.save()
	await settle()
	assert.equal(form.calls.length, 1)
	assert.equal(form.calls[0].expectedRevision, 9, 'the fence pins at the first real change')
	assert.deepEqual(form.calls[0].ops, [{ op: 'set', path: ['cooldownTurns'], value: 6 }])
	assert.equal(face.hooks.memoryCard.getSnapshot().dirty, false)
})

test('blanking an overridden field plans a reset and drops its badge', () => {
	const form = fakeForm({ user: { memoryDir: '/data/memory' } })
	const { registrations } = mount(form)
	const face = registrations[0].options.inject()
	assert.equal(face.hooks.memoryCard.getSnapshot().fields.memoryDir.overridden, true)
	face.edit('memoryDir', '  ')
	const state = face.hooks.memoryCard.getSnapshot()
	assert.equal(state.dirty, true)
	assert.equal(state.fields.memoryDir.overridden, false)
})

test('a new edit clears the failure notice', async () => {
	const form = fakeForm({ answer: false })
	const { registrations } = mount(form)
	const face = registrations[0].options.inject()
	face.edit('cooldownTurns', '5')
	face.save()
	await settle()
	assert.equal(face.hooks.memoryCard.getSnapshot().failed, true)
	face.edit('cooldownTurns', '4')
	assert.equal(face.hooks.memoryCard.getSnapshot().failed, false)
})

test('a reload refreshes the style tag an older build injected', () => {
	const tag = { dataset: { pluginCss: 'dsh-plugin-memory/settings-card.css' }, textContent: '.dshmem-card{}' }
	const appended = []
	const document = {
		querySelector: (selector) => (selector.includes('dsh-plugin-memory/settings-card.css') ? tag : null),
		createElement: () => { throw new Error('must reuse the existing tag') },
		head: { appendChild: (node) => appended.push(node) },
	}
	loadClient({ document })
	assert.ok(tag.textContent.includes('.dshmem-page'))
	assert.ok(!tag.textContent.includes('.dshmem-card'))
	assert.equal(appended.length, 0)
})
