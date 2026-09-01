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

		// The stock cards draw their disclosure affordance with the shared
		// 14px chevron primitive; require it so this card cannot drift from the
		// official icon, and keep an identical inline SVG for any host that
		// does not expose the primitives module.
		let primitives = null
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		} catch {
			primitives = null
		}
		const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
		const ChevronDown = typeof primitives?.IconChevronDownOutline14 === 'function'
			? primitives.IconChevronDownOutline14
			: (props) => h('svg', {
				width: 14,
				height: 14,
				className: props.className,
				viewBox: '0 0 14 14',
				fill: 'none',
				xmlns: 'http://www.w3.org/2000/svg',
			}, h('path', { d: CHEVRON_PATH, fill: 'currentColor' }))

		const NS = 'memory'
		const inject = ['slots', 'settingsScope']

		/* ── Styles (design tokens shared with the stock cards) ───────────── */
		const css = [
			'.dshmem-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
			'.dshmem-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
			'.dshmem-card[data-open=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
			'.dshmem-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
			'.dshmem-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
			'.dshmem-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
			'.dshmem-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
			'.dshmem-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
			'.dshmem-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
			'.dshmem-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
			'.dshmem-chevron-open{transform:rotate(180deg)}',
			'.dshmem-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
			'.dshmem-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
			'.dshmem-field+.dshmem-field{border-top:1px solid var(--dsw-alias-border-l2)}',
			'.dshmem-head{align-items:center;gap:8px;display:flex}',
			'.dshmem-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
			'.dshmem-badges{align-items:center;gap:8px;display:inline-flex}',
			'.dshmem-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
			'.dshmem-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;padding:0;font-size:12px;line-height:1.5}',
			'.dshmem-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
			'.dshmem-reset:disabled{cursor:default}',
			'.dshmem-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
			'.dshmem-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
			'.dshmem-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
			'.dshmem-input[data-invalid=true]{border-color:var(--dsw-alias-label-error)}',
			'.dshmem-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
			'.dshmem-hint[data-invalid=true]{color:var(--dsw-alias-label-error)}',
			'.dshmem-switchrow{align-items:center;gap:10px;display:flex}',
			'.dshmem-switchrow input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);margin:0}',
			'.dshmem-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
			'.dshmem-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
			'.dshmem-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
			'.dshmem-btn[data-kind=discard]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}',
			'.dshmem-btn[data-kind=discard]:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
			'.dshmem-btn[data-kind=save]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
			'.dshmem-btn:disabled{opacity:.4;cursor:default}',
			'.dshmem-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
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
			{ field: 'injectBudgetChars', kind: 'number', label: '注入预算（字符）', hint: '整个注入提示的长度上限（含约 1K 的固定指令开头），余下额度按各节实际需要分摊、装不下才截断保最新。默认 16000 ≈ 1M token 窗口的 0.4%，可显示约 36 条；小上下文模型请调低。' },
			{ field: 'distillMinChars', kind: 'number', label: '蒸馏最小新增字符', hint: '新增对话少于该字符数时先累积，不触发蒸馏。与下面的冷却轮数相乘决定蒸馏频率，调低会明显增加 LLM 调用次数。' },
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
					? h('span', { className: 'dshmem-badges' },
						h('span', { className: 'dshmem-badge' }, '已覆盖'),
						h('button', { type: 'button', className: 'dshmem-reset', disabled: props.disabled, onClick: props.onReset }, '恢复默认'))
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
					state.invalid ? '请填数字；留空表示使用默认值。' : spec.hint))
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
				h('button', {
					type: 'button',
					className: 'dshmem-header',
					'aria-expanded': open,
					'aria-label': (open ? '收起设置' : '展开设置') + ': 跨会话记忆',
					onClick: () => setOpen(!open),
				},
					h('span', { className: 'dshmem-headtext' },
						h('span', { className: 'dshmem-name' }, '跨会话记忆'),
						h('span', { className: 'dshmem-desc' }, '对话模型边干边记到本地 Markdown（~/.dsh/memory），同项目新会话自动注入；另有可选后台蒸馏。')),
					state.dirty ? h('span', { className: 'dshmem-pending' }, '未保存') : null,
					h(ChevronDown, { className: open ? 'dshmem-chevron dshmem-chevron-open' : 'dshmem-chevron' })),
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
							h('button', { type: 'button', className: 'dshmem-btn', 'data-kind': 'discard', disabled: !state.dirty || state.saving, onClick: props.discard }, '放弃修改'),
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
