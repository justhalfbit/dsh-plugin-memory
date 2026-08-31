/**
 * dsh-plugin-memory — browser half (hand-written lazy-CJS plugin bundle).
 *
 * Registers the "跨会话记忆" settings card on the keyed `settings.plugin.item`
 * slot under the `memory` namespace the host half serves. The card follows
 * the stock plugin-card contract: staged drafts, explicit save/discard,
 * override badges with per-field reset, revision-fenced writes through the
 * client settings scope (`ctx.settingsScope.bind`).
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-memory',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const React = require('react')
		const runtime = require('@deepseek-ai/dsh-client-runtime/client')
		const h = React.createElement

		const NS = 'memory'
		const inject = ['slots', 'settingsScope']

		/* ── Styles (design tokens shared with the stock cards) ───────────── */
		const css = [
			'.dshmem-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none}',
			'.dshmem-card[data-open=true]{background:var(--dsw-alias-bg-layer-2)}',
			'.dshmem-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
			'.dshmem-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
			'.dshmem-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
			'.dshmem-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
			'.dshmem-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
			'.dshmem-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
			'.dshmem-chevron[data-open=true]{transform:rotate(180deg)}',
			'.dshmem-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
			'.dshmem-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
			'.dshmem-field+.dshmem-field{border-top:1px solid var(--dsw-alias-border-l2)}',
			'.dshmem-head{align-items:center;gap:8px;display:flex}',
			'.dshmem-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
			'.dshmem-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
			'.dshmem-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;padding:0;font-size:12px;line-height:1.5}',
			'.dshmem-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
			'.dshmem-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
			'.dshmem-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
			'.dshmem-input[data-invalid=true]{border-color:var(--dsw-alias-label-error)}',
			'.dshmem-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
			'.dshmem-hint[data-invalid=true]{color:var(--dsw-alias-label-error)}',
			'.dshmem-switchrow{align-items:center;gap:10px;display:flex}',
			'.dshmem-switchrow input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);margin:0}',
			'.dshmem-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
			'.dshmem-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
			'.dshmem-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
			'.dshmem-btn[data-kind=discard]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}',
			'.dshmem-btn[data-kind=save]{background:var(--dsw-alias-brand-primary);color:#fff}',
			'.dshmem-btn:disabled{opacity:.5;cursor:default}',
			'.dshmem-readonly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
		].join('\n')
		const tagId = 'dsh-plugin-memory/settings-card.css'
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-plugin-memory'
			tag.dataset.pluginCss = tagId
			tag.textContent = css
			document.head.appendChild(tag)
		}

		/* ── Field specs ───────────────────────────────────────────────────── */
		/** @type {{ field: string, kind: 'boolean'|'number'|'text', label: string, hint: string }[]} */
		const FIELDS = [
			{ field: 'enabled', kind: 'boolean', label: '启用记忆', hint: '总开关：关闭后不注入、不蒸馏（工具仍可手动调用查询）。' },
			{ field: 'autoDistill', kind: 'boolean', label: '自动蒸馏（opt-in）', hint: '默认关闭：记忆由对话模型边干边记（对齐 Claude Code）。开启后额外在每轮完成时后台静默蒸馏，适合无人值守的长任务。' },
			{ field: 'memoryDir', kind: 'text', label: '记忆目录', hint: '留空使用默认 ~/.dsh/memory；支持 ~ 展开。' },
			{ field: 'injectBudgetChars', kind: 'number', label: '注入预算（字符）', hint: '注入到新会话的记忆摘要长度上限，超出按节均衡截断。' },
			{ field: 'distillMinChars', kind: 'number', label: '蒸馏最小新增字符', hint: '新增对话少于该字符数时先累积，不触发蒸馏。' },
			{ field: 'cooldownTurns', kind: 'number', label: '蒸馏冷却（轮）', hint: '同一会话内两次蒸馏之间至少间隔的轮数。' },
			{ field: 'distillProvider', kind: 'text', label: '蒸馏 Provider', hint: '留空跟随当前对话的模型路由；与蒸馏模型成对设置。' },
			{ field: 'distillModel', kind: 'text', label: '蒸馏模型', hint: '可指定便宜的小模型做记忆提取，留空跟随当前对话。' },
			{ field: 'maxEntriesPerCategory', kind: 'number', label: '每类条目上限', hint: '超出后优先淘汰最旧的自动蒸馏条目，手动保存的条目最后淘汰。' },
			{ field: 'topicIndexInInject', kind: 'boolean', label: '注入专题索引', hint: '在注入的记忆摘要末尾附一行一个的专题文件索引（正文按需经 memory_read 加载）。' },
			{ field: 'proactivity', kind: 'select', label: '记忆积极度', hint: '控制对话模型主动写记忆的门槛与频率，热生效；机制不变（可见工具调用 + 去重 + 上限）。', options: [
				{ value: 'conservative', label: '保守型 — 只记纠错、决策、教训；拿不准不记' },
				{ value: 'balanced', label: '平衡型 — 持久知识随学随记，琐事仍排除' },
				{ value: 'eager', label: '积极型 — 边干边记、宁多勿漏（近似 Claude 默认）' },
			] },
		]
		const SPEC = new Map(FIELDS.map((spec) => [spec.field, spec]))

		/* ── Staged form over the client settings scope ────────────────────── */
		class MemoryForm {
			constructor(scope) {
				this.scope = scope
				/** @type {Map<string, { kind: 'set', value: unknown } | { kind: 'clear' } | { kind: 'draft', text: string }>} */
				this.staged = new Map()
				this.saving = false
				this.failed = false
				this.store = runtime.createSnapshotStore(this.projection())
			}

			/** Follow scope changes; returns the unsubscribe for effect-managed disposal. */
			attach() {
				return this.scope.subscribe(() => {
					this.publish()
				})
			}

			publish() {
				this.store.set(this.projection())
			}

			snapshot() {
				return this.scope.getSnapshot()
			}

			/** Effective display value for one field: staged draft over resolved value. */
			fieldState(field) {
				const spec = SPEC.get(field)
				const snapshot = this.snapshot()
				const resolved = snapshot.value === undefined ? undefined : snapshot.value[field]
				const user = snapshot.user
				const overridden = user !== undefined && user !== null && Object.hasOwn(user, field)
				const staged = this.staged.get(field)
				if (staged === undefined) {
					return { value: resolved, text: resolved === undefined ? '' : String(resolved), overridden, invalid: false, dirty: false }
				}
				if (staged.kind === 'clear') {
					const base = snapshot.base === undefined || snapshot.base === null ? undefined : snapshot.base[field]
					return { value: base, text: base === undefined ? '' : String(base), overridden: false, invalid: false, dirty: true }
				}
				if (staged.kind === 'set') {
					return { value: staged.value, text: String(staged.value), overridden: true, invalid: false, dirty: true }
				}
				const invalid = spec.kind === 'number' && staged.text.trim() !== '' && !Number.isFinite(Number(staged.text.trim()))
				return { value: undefined, text: staged.text, overridden: true, invalid, dirty: true }
			}

			shell() {
				const snapshot = this.snapshot()
				let dirty = false
				let invalid = false
				for (const spec of FIELDS) {
					const state = this.fieldState(spec.field)
					dirty = dirty || state.dirty
					invalid = invalid || state.invalid
				}
				return {
					available: snapshot.status === 'ready',
					writable: snapshot.writable,
					dirty,
					invalid,
					saving: this.saving,
					failed: this.failed,
				}
			}

			projection() {
				const fields = {}
				for (const spec of FIELDS) fields[spec.field] = this.fieldState(spec.field)
				return { ...this.shell(), fields }
			}

			actions() {
				return {
					edit: (field, text) => {
						this.staged.set(field, { kind: 'draft', text })
						this.publish()
					},
					toggle: (field, value) => {
						// Generic staged set: booleans from checkboxes, strings from selects.
						this.staged.set(field, { kind: 'set', value })
						this.publish()
					},
					resetField: (field) => {
						this.staged.set(field, { kind: 'clear' })
						this.publish()
					},
					discard: () => {
						this.staged.clear()
						this.failed = false
						this.publish()
					},
					save: () => {
						void this.save()
					},
				}
			}

			async save() {
				if (this.saving) return
				const shell = this.shell()
				if (!shell.dirty || shell.invalid || !shell.writable) return
				this.saving = true
				this.failed = false
				this.publish()
				let landed = true
				for (const [field, staged] of [...this.staged]) {
					const spec = SPEC.get(field)
					try {
						if (staged.kind === 'clear') await this.scope.unset(field)
						else if (staged.kind === 'set') await this.scope.set(field, staged.value)
						else {
							const text = staged.text.trim()
							if (text === '') await this.scope.unset(field)
							else if (spec.kind === 'number') await this.scope.set(field, Number(text))
							else await this.scope.set(field, text)
						}
						// Only clear the exact draft this save wrote: an edit that
						// slipped in during the await must survive for the next save.
						if (this.staged.get(field) === staged) this.staged.delete(field)
					} catch (error) {
						landed = false
					}
				}
				this.saving = false
				this.failed = !landed
				this.publish()
			}
		}

		/* ── Components ────────────────────────────────────────────────────── */
		function FieldHead(props) {
			return h('div', { className: 'dshmem-head' },
				h('label', { className: 'dshmem-label', htmlFor: props.id }, props.label),
				props.overridden
					? h('span', { className: 'dshmem-head' },
						h('span', { className: 'dshmem-badge' }, '已覆盖'),
						h('button', { type: 'button', className: 'dshmem-reset', disabled: props.disabled, onClick: props.onReset }, '重置'))
					: null)
		}

		function ValueField(props) {
			const { spec, state } = props
			return h('div', { className: 'dshmem-field' },
				h(FieldHead, {
					id: 'dshmem-' + spec.field,
					label: spec.label,
					overridden: state.overridden,
					disabled: props.disabled,
					onReset: () => props.resetField(spec.field),
				}),
				h('input', {
					id: 'dshmem-' + spec.field,
					className: 'dshmem-input',
					type: 'text',
					inputMode: spec.kind === 'number' ? 'numeric' : undefined,
					'data-invalid': state.invalid || undefined,
					value: state.text,
					disabled: props.disabled,
					onChange: (event) => props.edit(spec.field, event.target.value),
				}),
				h('p', { className: 'dshmem-hint', 'data-invalid': state.invalid || undefined },
					state.invalid ? '需要输入数字' : spec.hint))
		}

		function SwitchField(props) {
			const { spec, state } = props
			const checked = state.value === true
			return h('div', { className: 'dshmem-field' },
				h(FieldHead, {
					id: 'dshmem-' + spec.field,
					label: spec.label,
					overridden: state.overridden,
					disabled: props.disabled,
					onReset: () => props.resetField(spec.field),
				}),
				h('div', { className: 'dshmem-switchrow' },
					h('input', {
						id: 'dshmem-' + spec.field,
						type: 'checkbox',
						checked,
						disabled: props.disabled,
						onChange: (event) => props.toggle(spec.field, event.target.checked),
					}),
					h('p', { className: 'dshmem-hint' }, spec.hint)))
		}

		function SelectField(props) {
			const { spec, state } = props
			const current = typeof state.value === 'string' && spec.options.some((option) => option.value === state.value)
				? state.value
				: spec.options[0].value
			return h('div', { className: 'dshmem-field' },
				h(FieldHead, {
					id: 'dshmem-' + spec.field,
					label: spec.label,
					overridden: state.overridden,
					disabled: props.disabled,
					onReset: () => props.resetField(spec.field),
				}),
				h('select', {
					id: 'dshmem-' + spec.field,
					className: 'dshmem-input',
					value: current,
					disabled: props.disabled,
					onChange: (event) => props.toggle(spec.field, event.target.value),
				}, spec.options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
				h('p', { className: 'dshmem-hint' }, spec.hint))
		}

		function MemoryCard(props) {
			const state = props.useMemoryCard((snapshot) => snapshot)
			const [open, setOpen] = React.useState(false)
			if (!state.available) return null
			const disabled = !state.writable || state.saving
			const blocked = !state.dirty || state.invalid || state.saving || !state.writable
			return h('li', { className: 'dshmem-card', 'data-open': open },
				h('button', { type: 'button', className: 'dshmem-header', 'aria-expanded': open, onClick: () => setOpen(!open) },
					h('span', { className: 'dshmem-headtext' },
						h('span', { className: 'dshmem-name' }, '跨会话记忆'),
						h('span', { className: 'dshmem-desc' }, '对话模型边干边记到本地 Markdown（~/.dsh/memory），同项目新会话自动注入；另有可选后台蒸馏。')),
					state.dirty ? h('span', { className: 'dshmem-pending' }, '未保存') : null,
					h('span', { className: 'dshmem-chevron', 'data-open': open, 'aria-hidden': true }, '▾')),
				open
					? h('div', { className: 'dshmem-body' },
						state.writable ? null : h('p', { className: 'dshmem-readonly' }, '当前设置文档为只读，无法保存修改。'),
						FIELDS.map((spec) => h(spec.kind === 'boolean' ? SwitchField : spec.kind === 'select' ? SelectField : ValueField, {
							key: spec.field,
							spec,
							state: state.fields[spec.field],
							disabled,
							edit: props.edit,
							toggle: props.toggle,
							resetField: props.resetField,
						})),
						h('div', { className: 'dshmem-footer' },
							state.failed ? h('p', { className: 'dshmem-failed', role: 'status' }, '保存未生效，请检查取值后重试。') : null,
							h('button', { type: 'button', className: 'dshmem-btn', 'data-kind': 'discard', disabled: !state.dirty || state.saving, onClick: props.discard }, '放弃'),
							h('button', { type: 'button', className: 'dshmem-btn', 'data-kind': 'save', disabled: blocked, onClick: props.save }, state.saving ? '保存中…' : '保存')))
					: null)
		}

		/* ── Mount ─────────────────────────────────────────────────────────── */
		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: NS })
			const form = new MemoryForm(scope)
			ctx.effect(() => form.attach(), 'dsh-plugin-memory: settings scope subscription')
			ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
				name: 'settings.plugin.item',
				key: NS,
				inject: () => ({ hooks: { memoryCard: form.store }, ...form.actions() }),
			}, MemoryCard))
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
