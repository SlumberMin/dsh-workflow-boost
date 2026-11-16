// client.js — the browser half of dsh-workflow-boost: the Settings page and the
// Plugins-page configuration card. The Host half (index.js + lib/) owns the
// behaviour; this file only renders controls over the row's volatile Config
// fields and submits atomic writes through ctx.configForms.
//
// Why this file exists: DSH's shipped Web client does not auto-render plugin
// config forms (the Host settings service projects volatile fields, but the
// client renders only pages that a client companion registers). Without this
// module the plugin shows no settings UI at all.
//
// Pattern copied from the shipped client packages and the third-party
// dsh-win-pwsh7 example: a plain ModuleLoader module, React from the host,
// ctx.configForms.get(rowId), and slot registrations.

window.__ModuleLoader__.load({
  id: 'dsh-workflow-boost',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState, useSyncExternalStore } = React

    const PACKAGE = 'dsh-workflow-boost'
    const ROW_ID = 'workflow-boost'
    const SLOT_KEY = PACKAGE + '#' + ROW_ID

    const STYLE_OPTIONS = [
      ['default', 'Default (host)'],
      ['concise', 'Concise'],
      ['proactive', 'Proactive'],
      ['explanatory', 'Explanatory'],
      ['learning', 'Learning'],
      ['custom', 'Custom'],
    ]
    const IDENTITY_OPTIONS = [
      ['off', 'Off (host identity)'],
      ['deepseek-v4.1', 'DeepSeek V4.1'],
      ['claude-opus-5.5', 'Claude Opus 5.5'],
      ['claude-fable-5.2', 'Claude Fable 5.2'],
      ['claude-sonnet-5.5', 'Claude Sonnet 5.5'],
      ['gpt-6.1-sol', 'GPT-6.1 Sol'],
      ['grok-4.7', 'Grok 4.7'],
      ['kimi-k3', 'Kimi K3'],
      ['glm-5.3', 'GLM-5.3'],
      ['minimax-m3.1', 'MiniMax M3.1'],
      ['custom', 'Custom identity'],
    ]
    const MODULES = [
      ['microcompact', 'Microcompact'],
      ['focusChain', 'Focus chain'],
      ['duplicateGuard', 'Stuck detector'],
      ['turnGuard', 'Turn guard'],
      ['editCheck', 'Edit checks'],
      ['checkpoint', 'File checkpoints'],
      ['goalGate', 'Goal evidence gate'],
      ['repoMap', 'Repo map'],
      ['cacheReport', 'Cache audit'],
      ['memoryLint', 'Memory lint'],
      ['hookBus', 'Hook bus'],
      ['handoffNotes', 'Handoff notes'],
      ['skillPack', 'Built-in skills'],
      ['reviewGate', 'Review gate'],
      ['stylePack', 'Style pack'],
    ]

    const DICT_EN = {
      nav: 'Workflow Boost',
      title: 'Workflow Boost',
      lead: 'Response style, self-presentation and module switches. Writes go to the active profile row and apply without restarting DSH.',
      style_title: 'Response style',
      style_hint: 'Concise answers first, no narration; Proactive starts working and asks only before destructive steps.',
      identity_title: 'Self-presentation',
      identity_hint: 'Presentation only. This never grants capabilities; tools remain the source of truth. Do not use it to misrepresent the product to end users.',
      identity_custom: 'Custom identity line',
      style_custom: 'Custom style rules (one per line)',
      modules_title: 'Modules',
      modules_hint: 'Turn individual modules off when they fight your workflow. The style pack itself stays listed here so it can be switched back on.',
      enabled: 'Plugin enabled',
      apply_system: 'Inject the style into the system prompt (cache-stable)',
      persist: 'Remember choices in this workspace (.dsh/workflow-boost/style.json)',
      save: 'Save',
      reset: 'Reset to defaults',
      saved: 'Saved',
      loading: 'Loading configuration…',
      unavailable: 'Configuration is not available in this Host.',
      unwritable: 'This Host is not accepting writes for this row.',
      rejected: 'The Host rejected the write.',
      missing_form: 'The settings service is not mounted; the plugin settings page stays empty.',
      style_saved: 'Style and switches saved.',
    }
    const DICT_ZH = {
      nav: 'Workflow Boost',
      title: 'Workflow Boost 设置',
      lead: '回复风格、自我呈现与模块开关。写入当前 profile 的插件行，无需重启 DSH。',
      style_title: '回复风格',
      style_hint: 'Concise：第一句给答案、不叙述过程；Proactive：直接开工，只在破坏性操作前确认。',
      identity_title: '自我呈现',
      identity_hint: '仅用于自我描述，不会带来任何能力；工具仍是唯一事实来源。不要用它向最终用户冒充其他产品。',
      identity_custom: '自定义身份描述',
      style_custom: '自定义风格规则（每行一条）',
      modules_title: '模块开关',
      modules_hint: '某个模块与你的工作流冲突时可单独关闭；stylePack 也列在这里，方便再打开。',
      enabled: '启用插件',
      apply_system: '把风格注入系统提示词（缓存稳定）',
      persist: '在工作区记住选择（.dsh/workflow-boost/style.json）',
      save: '保存',
      reset: '恢复默认',
      saved: '已保存',
      loading: '正在读取配置…',
      unavailable: '当前 Host 没有提供该配置。',
      unwritable: '当前 Host 不接受对该行的写入。',
      rejected: 'Host 拒绝了写入。',
      missing_form: '设置服务未挂载，插件设置页为空。',
      style_saved: '风格与开关已保存。',
    }


    const CSS = [
      '.dwb-root{display:flex;flex-direction:column;gap:16px;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;}',
      '.dwb-lead{margin:0;color:var(--dsw-alias-label-secondary,#5c6370);line-height:1.6;font-size:13px;}',
      '.dwb-card{border:1px solid var(--dsw-alias-border,#e3e6eb);border-radius:12px;padding:16px;background:var(--dsw-alias-bg-layer-2,#fff);display:flex;flex-direction:column;gap:12px;}',
      '.dwb-title{font-size:14px;font-weight:600;margin:0;}',
      '.dwb-hint{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5c6370);}',
      '.dwb-row{display:flex;flex-direction:column;gap:6px;}',
      '.dwb-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);}',
      '.dwb-select,.dwb-input,.dwb-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border,#d4d8de);border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;}',
      '.dwb-textarea{min-height:72px;resize:vertical;}',
      '.dwb-select:disabled,.dwb-input:disabled,.dwb-textarea:disabled{opacity:.6;}',
      '.dwb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px 16px;}',
      '.dwb-check{display:flex;align-items:center;gap:8px;font-size:13px;}',
      '.dwb-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.dwb-btn{border:1px solid var(--dsw-alias-border,#d4d8de);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:13px;padding:6px 14px;cursor:pointer;}',
      '.dwb-btn.primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff;font-weight:600;}',
      '.dwb-btn:disabled{opacity:.5;cursor:default;}',
      '.dwb-ok{font-size:12px;color:var(--dsw-alias-label-success,#15803d);}',
      '.dwb-error{font-size:12px;color:var(--dsw-alias-label-danger,#b91c1c);}',
      '.dwb-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#5c6370);}',
    ].join('')

    function readPath(source, path) {
      let node = source
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[key]
      }
      return node
    }

    function draftOf(value) {
      const root = value !== null && typeof value === 'object' ? value : {}
      const stylePack = root.stylePack !== null && typeof root.stylePack === 'object' ? root.stylePack : {}
      const modules = {}
      for (const [id] of MODULES) {
        const section = root[id]
        modules[id] = !(section !== null && typeof section === 'object' && section.enabled === false)
      }
      return {
        enabled: root.enabled !== false,
        style: typeof stylePack.style === 'string' ? stylePack.style : 'default',
        identity: typeof stylePack.identity === 'string' ? stylePack.identity : 'off',
        customStyle: typeof stylePack.customStyle === 'string' ? stylePack.customStyle : '',
        customIdentity: typeof stylePack.customIdentity === 'string' ? stylePack.customIdentity : '',
        applyToSystemPrompt: stylePack.applyToSystemPrompt !== false,
        persist: stylePack.persist !== false,
        modules,
      }
    }

    function opsBetween(next, current, resolved) {
      const ops = []
      const push = (path, value, currentValue) => {
        if (JSON.stringify(value) === JSON.stringify(currentValue)) return
        ops.push({ op: 'set', path, value })
      }
      push(['enabled'], next.enabled, current.enabled)
      push(['stylePack', 'style'], next.style, current.style)
      push(['stylePack', 'identity'], next.identity, current.identity)
      push(['stylePack', 'customStyle'], next.customStyle, current.customStyle)
      push(['stylePack', 'customIdentity'], next.customIdentity, current.customIdentity)
      push(['stylePack', 'applyToSystemPrompt'], next.applyToSystemPrompt, current.applyToSystemPrompt)
      push(['stylePack', 'persist'], next.persist, current.persist)
      for (const [id] of MODULES) push([id, 'enabled'], next.modules[id], current.modules[id])
      return ops
    }

    function optionList(options) {
      return options.map(([value, label]) => h('option', { key: value, value }, label))
    }


    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const disposeLocale = ctx.locale.register(PACKAGE, { zh: DICT_ZH, en: DICT_EN })
        const t = ctx.locale.bind(PACKAGE)
        const form = ctx.configForms.get(ROW_ID)

        // Stable identities: useSyncExternalStore compares snapshots with
        // Object.is and re-subscribes when subscribe changes, so these wrappers
        // are built exactly once.
        const ABSENT_SUBSCRIBE = () => {}
        const ABSENT_SNAPSHOT = { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false }
        const subscribe = form === undefined ? ABSENT_SUBSCRIBE : (listener) => form.subscribe(listener)
        const getSnapshot = form === undefined ? () => ABSENT_SNAPSHOT : () => form.getSnapshot()

        /**
         * The single settings surface. It renders in two slots: the Settings
         * dialog page (settings.section) and the Plugins-page config card
         * (plugins.row.config). Both are the same controls over the same row.
         */
        function WorkflowBoostPanel(props) {
          if (props !== null && typeof props === 'object' && props.view === 'summary') return null
          const snap = useSyncExternalStore(subscribe, getSnapshot)
          const [draft, setDraft] = useState(null)
          const [busy, setBusy] = useState(false)
          const [note, setNote] = useState(null)
          const [savedAt, setSavedAt] = useState(null)

          const status = snap !== null && typeof snap === 'object' ? snap.status : 'unavailable'
          const ready = status === 'ready'
          const writable = snap !== null && typeof snap === 'object' ? snap.writable !== false : false
          const editable = ready && writable && !busy
          const current = draftOf(snap === null || typeof snap !== 'object' ? undefined : snap.value)
          const values = draft ?? current
          const dirty = ready && draft !== null && JSON.stringify(draft) !== JSON.stringify(current)

          const update = (patch) => {
            setDraft({ ...values, ...patch })
            setNote(null)
            setSavedAt(null)
          }

          const save = async () => {
            if (!ready) return
            setBusy(true)
            setNote(null)
            try {
              const ops = opsBetween(values, current, snap === null ? undefined : snap.value)
              if (ops.length === 0) {
                setDraft(null)
                setSavedAt(new Date().toLocaleTimeString())
                return
              }
              const ok = await form.mutate(ops, snap === null ? undefined : snap.revision)
              if (ok) {
                setDraft(null)
                setSavedAt(new Date().toLocaleTimeString())
              } else {
                setNote(t('rejected'))
              }
            } catch (error) {
              setNote(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error))
            } finally {
              setBusy(false)
            }
          }

          const resetStyle = async () => {
            if (!ready || form === undefined) return
            setBusy(true)
            setNote(null)
            try {
              const ok = await form.mutate([{ op: 'unset', path: ['stylePack'] }], snap === null ? undefined : snap.revision)
              if (ok) {
                setDraft(null)
                setSavedAt(new Date().toLocaleTimeString())
              } else {
                setNote(t('rejected'))
              }
            } catch (error) {
              setNote(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error))
            } finally {
              setBusy(false)
            }
          }

          if (form === undefined) {
            return h('section', { className: 'dwb-root' }, h('style', null, CSS), h('p', { className: 'dwb-hint' }, t('missing_form')))
          }
          if (status === 'loading') {
            return h('section', { className: 'dwb-root' }, h('style', null, CSS), h('p', { className: 'dwb-hint' }, t('loading')))
          }
          if (status === 'unavailable') {
            return h('section', { className: 'dwb-root' }, h('style', null, CSS), h('p', { className: 'dwb-hint' }, t('unavailable')))
          }

          const section = (key, title, hint, body) => h('div', { className: 'dwb-card', key },
            h('div', { className: 'dwb-row' },
              h('h3', { className: 'dwb-title' }, title),
              hint === null ? null : h('p', { className: 'dwb-hint' }, hint)),
            body)

          return h('section', { className: 'dwb-root' },
            h('style', null, CSS),
            h('p', { className: 'dwb-lead' }, t('lead')),
            h('label', { className: 'dwb-check' },
              h('input', { type: 'checkbox', checked: values.enabled, disabled: !editable, onChange: (event) => update({ enabled: event.target.checked }) }),
              t('enabled')),
            section('style', t('style_title'), t('style_hint'),
              h('div', { className: 'dwb-row' },
                h('select', {
                  className: 'dwb-select',
                  value: values.style,
                  disabled: !editable,
                  onChange: (event) => update({ style: event.target.value }),
                }, optionList(STYLE_OPTIONS)),
                values.style === 'custom'
                  ? h('textarea', {
                      className: 'dwb-textarea',
                      placeholder: t('style_custom'),
                      value: values.customStyle,
                      disabled: !editable,
                      onChange: (event) => update({ customStyle: event.target.value }),
                    })
                  : null)),
            section('identity', t('identity_title'), t('identity_hint'),
              h('div', { className: 'dwb-row' },
                h('select', {
                  className: 'dwb-select',
                  value: values.identity,
                  disabled: !editable,
                  onChange: (event) => update({ identity: event.target.value }),
                }, optionList(IDENTITY_OPTIONS)),
                values.identity === 'custom'
                  ? h('input', {
                      className: 'dwb-input',
                      placeholder: t('identity_custom'),
                      value: values.customIdentity,
                      disabled: !editable,
                      onChange: (event) => update({ customIdentity: event.target.value }),
                    })
                  : null)),
            section('modules', t('modules_title'), t('modules_hint'),
              h('div', { className: 'dwb-grid' },
                MODULES.map(([id, label]) => h('label', { className: 'dwb-check', key: id },
                  h('input', {
                    type: 'checkbox',
                    checked: values.modules[id] !== false,
                    disabled: !editable,
                    onChange: (event) => update({ modules: { ...values.modules, [id]: event.target.checked } }),
                  }),
                  label)))),
            h('div', { className: 'dwb-row' },
              h('label', { className: 'dwb-check' },
                h('input', { type: 'checkbox', checked: values.applyToSystemPrompt, disabled: !editable, onChange: (event) => update({ applyToSystemPrompt: event.target.checked }) }),
                t('apply_system')),
              h('label', { className: 'dwb-check' },
                h('input', { type: 'checkbox', checked: values.persist, disabled: !editable, onChange: (event) => update({ persist: event.target.checked }) }),
                t('persist'))),
            h('div', { className: 'dwb-actions' },
              h('button', { type: 'button', className: 'dwb-btn primary', disabled: !editable || !dirty, onClick: () => void save() }, t('save')),
              h('button', { type: 'button', className: 'dwb-btn', disabled: !editable || busy, onClick: () => void resetStyle() }, t('reset')),
              savedAt === null ? null : h('span', { className: 'dwb-ok' }, t('saved') + ' ' + savedAt),
              note === null ? null : h('span', { className: 'dwb-error' }, note),
              writable ? null : h('span', { className: 'dwb-error' }, t('unwritable'))))
        }

        // ---- registrations -------------------------------------------------
        const disposers = []
        ctx.effect(() => disposeLocale, 'dsh-workflow-boost: client locale namespace')
        ctx.effect(() => {
          const attempts = []
          const tryRegister = (slotName, makeDefinition) => {
            try {
              const dispose = ctx.slots.inject(slotName, () => {
                try {
                  return ctx.slots.register(makeDefinition(), WorkflowBoostPanel)
                } catch {
                  return () => {}
                }
              })
              if (typeof dispose === 'function') attempts.push(dispose)
            } catch {
              /* an older or foreign host may not declare this slot */
            }
          }
          // The Settings dialog navigation entry: this is what makes the plugin
          // appear in the left column of the Settings modal.
          tryRegister('settings.section', () => ({
            name: 'settings.section',
            id: 'workflow-boost',
            order: 15,
            label: () => t('nav'),
          }))
          // The Plugins page config card: official plugins put their page here.
          tryRegister('plugins.row.config', () => ({
            name: 'plugins.row.config',
            key: SLOT_KEY,
            locale: PACKAGE,
          }))
          return () => {
            for (const dispose of attempts) {
              try { dispose() } catch { /* disposal must not throw */ }
            }
          }
        }, 'dsh-workflow-boost: settings surfaces')
      },
    }
  },
})
