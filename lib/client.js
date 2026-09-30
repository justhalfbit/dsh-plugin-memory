/**
 * dsh-plugin-memory — browser half (hand-written lazy-CJS plugin bundle).
 *
 * Registers the "跨会话记忆" settings page on the Plugins page's keyed
 * `plugins.bundle.config` slot (key: this package name), while the Host
 * serves the `memory` entry the host half composes (DSH >= 0.2). The page
 * follows the stock form contract: staged drafts, explicit save/discard,
 * override badges with per-field reset, and one revision-fenced atomic write
 * through the shared configuration form (`ctx.configForms.get('memory')`).
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-memory',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const React = require('react')
		// createSnapshotStore moved between platform module tables across DSH
		// versions: DSH >= 0.1.2 seeds `@deepseek-ai/dsh-client-store`, while
		// DSH 0.1.1-rc.x seeds `@deepseek-ai/dsh-client-runtime/client` (the
		// package was retired in 0.1.2). The loader's require throws a
		// synchronous, catchable Error on a missing module, so probe new-first
		// and fall back; both exports carry an equivalent createSnapshotStore
		// (0.1.2 additionally guards subscriber callbacks; same shape and
		// semantics for the getSnapshot/subscribe/set this plugin uses).
		let runtime
		try {
			runtime = require('@deepseek-ai/dsh-client-store')
		} catch {
			runtime = require('@deepseek-ai/dsh-client-runtime/client')
		}
		const h = React.createElement

		// Host composition entry id (cordis.patch.yml): DSH >= 0.2 forms address
		// a plugin's settings by entry id. The page registers under the bundle's
		// package name, which is what the Plugins page keys a bundle's page by.
		const NS = 'memory'
		const BUNDLE = 'dsh-plugin-memory'
		const inject = ['slots', 'configForms']

		/* ── Styles (design tokens shared with the stock cards) ───────────── */
		const css = [
			'.dshmem-page{flex-direction:column;padding-bottom:8px;display:flex}',
			'.dshmem-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
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
			{ field: 'injectBudgetChars', kind: 'number', label: '注入预算（字符）', hint: '整个注入提示的长度上限（含约 1K 的固定指令开头），余下额度按各节实际需要分摊、装不下才截断保最新。这是上限不是下限：小记忆只花它实际渲染的长度。默认 64000 ≈ 1M token 窗口的 1.6%，满载 200 条时可显示约 150 条；小上下文模型请调低。' },
			{ field: 'distillMinChars', kind: 'number', label: '蒸馏最小新增字符', hint: '新增对话少于该字符数时先累积，不触发蒸馏。与下面的冷却轮数相乘决定蒸馏频率，调低会明显增加 LLM 调用次数。' },
			{ field: 'cooldownTurns', kind: 'number', label: '蒸馏冷却（轮）', hint: '同一会话内两次蒸馏之间至少间隔的轮数。' },
			{ field: 'distillProvider', kind: 'text', label: '蒸馏 Provider', hint: '留空跟随当前对话的模型路由；与蒸馏模型成对设置。' },
			{ field: 'distillModel', kind: 'text', label: '蒸馏模型', hint: '可指定便宜的小模型做记忆提取，留空跟随当前对话。' },
			{ field: 'maxEntriesPerCategory', kind: 'number', label: '每类条目上限', hint: '超出后优先淘汰最旧的自动蒸馏条目，手动保存的条目最后淘汰。' },
			{ field: 'topicIndexInInject', kind: 'boolean', label: '注入专题索引', hint: '在注入的记忆摘要末尾附一行一个的专题文件索引（正文按需经 memory_read 加载）。' },
			{ field: 'proactivity', kind: 'select', label: '记忆积极度', hint: '控制对话模型主动写记忆的门槛与频率，热生效；机制不变（可见工具调用 + 去重 + 上限）。', options: [
				{ value: 'conservative', label: '保守型 — 只记纠错、决策、教训、偏好、非显然事实；多数轮次不记' },
				{ value: 'balanced', label: '平衡型 — 持久知识随学随记，琐事仍排除' },
				{ value: 'eager', label: '积极型 — 边干边记、宁多勿漏（近似 Claude 默认）' },
			] },
		]
		const SPEC = new Map(FIELDS.map((spec) => [spec.field, spec]))

		/* ── Staged form over the shared configuration form ────────────────── */
		class MemoryForm {
			constructor(scope) {
				this.scope = scope
				/** @type {Map<string, { kind: 'set', value: unknown } | { kind: 'clear' } | { kind: 'draft', text: string }>} */
				this.staged = new Map()
				/** Revision the drafts were read against; fences the save. */
				this.baseRevision = undefined
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
					status: snapshot.status,
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

			/** Stage one field; the first draft pins the revision it was read at. */
			stage(field, staged) {
				if (this.staged.size === 0) this.baseRevision = this.snapshot().revision
				this.staged.set(field, staged)
				// A new edit answers the failure notice (stock SettingsFormModel).
				this.failed = false
				this.publish()
			}

			actions() {
				return {
					edit: (field, text) => {
						this.stage(field, { kind: 'draft', text })
					},
					toggle: (field, value) => {
						// Generic staged set: booleans from checkboxes, strings from selects.
						this.stage(field, { kind: 'set', value })
					},
					resetField: (field) => {
						this.stage(field, { kind: 'clear' })
					},
					discard: () => {
						this.staged.clear()
						this.baseRevision = undefined
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
				// One atomic mutation fenced by the revision the drafts were read
				// at: the Host applies every field or none, and a concurrent change
				// refuses the save instead of being silently overwritten.
				const written = [...this.staged]
				const ops = written.map(([field, staged]) => {
					if (staged.kind === 'clear') return { op: 'unset', path: [field] }
					if (staged.kind === 'set') return { op: 'set', path: [field], value: staged.value }
					const text = staged.text.trim()
					if (text === '') return { op: 'unset', path: [field] }
					return { op: 'set', path: [field], value: SPEC.get(field).kind === 'number' ? Number(text) : text }
				})
				let landed = false
				try {
					// The form answers false (never throws) when the Host refuses;
					// a transport failure throws. Both keep the drafts.
					landed = (await this.scope.mutate(ops, this.baseRevision)) === true
				} catch {
					landed = false
				}
				if (landed) {
					// Only clear the exact drafts this save wrote: an edit that
					// slipped in during the await must survive for the next save.
					for (const [field, staged] of written) {
						if (this.staged.get(field) === staged) this.staged.delete(field)
					}
					this.baseRevision = this.staged.size === 0 ? undefined : this.snapshot().revision
				} else {
					// The form already re-read the Host; the failure notice shows the
					// person the values changed under them, so an explicit retry
					// writes the kept drafts over what they can now see.
					this.baseRevision = this.snapshot().revision
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

		const SUMMARY = '对话模型边干边记到本地 Markdown（~/.dsh/memory），同项目新会话自动注入；另有可选后台蒸馏。'

		/**
		 * The bundle's page on the Plugins page. The page draws the title, icon,
		 * and crumb; `view: 'summary'` asks for the one-liner, `view: 'page'` for
		 * the form with its own save controls.
		 */
		function MemoryPage(props) {
			const state = props.useMemoryCard((snapshot) => snapshot)
			const discard = props.discard
			const isPage = props.view !== 'summary'
			// Leaving the page drops the staged edits (Plugins page contract);
			// a summary rendering elsewhere never owns them.
			React.useEffect(() => (isPage ? () => discard() : undefined), [discard, isPage])
			if (props.view === 'summary') return SUMMARY
			if (!state.available) {
				return h('div', { className: 'dshmem-page' },
					h('p', { className: 'dshmem-readonly' }, state.status === 'loading'
						? '正在读取设置…'
						: '当前页面无法读写记忆设置（仅本机访问的 Web 端可保存设置，或宿主尚未提供 memory 条目）。'))
			}
			const disabled = !state.writable || state.saving
			const blocked = !state.dirty || state.invalid || state.saving || !state.writable
			return h('div', { className: 'dshmem-page' },
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
					state.failed ? h('p', { className: 'dshmem-failed', role: 'status' }, '保存未生效（取值被拒绝或设置已被其他地方修改），已保留你的修改，请核对后重试。') : null,
					state.dirty ? h('span', { className: 'dshmem-pending' }, '未保存') : null,
					h('button', { type: 'button', className: 'dshmem-btn', 'data-kind': 'discard', disabled: !state.dirty || state.saving, onClick: props.discard }, '放弃修改'),
					h('button', { type: 'button', className: 'dshmem-btn', 'data-kind': 'save', disabled: blocked, onClick: props.save }, state.saving ? '保存中…' : '保存')))
		}

		/* ── Mount ─────────────────────────────────────────────────────────── */
		function apply(ctx) {
			const form = new MemoryForm(ctx.configForms.get(NS))
			const actions = form.actions()
			ctx.effect(() => form.attach(), 'dsh-plugin-memory: configuration form subscription')
			// The page exists only while the Host serves the `memory` entry, so a
			// host half that failed to load leaves no dead page behind.
			ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
				name: 'plugins.bundle.config',
				key: BUNDLE,
				inject: () => ({ hooks: { memoryCard: form.store }, ...actions }),
			}, MemoryPage))), 'dsh-plugin-memory: plugins page')
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
