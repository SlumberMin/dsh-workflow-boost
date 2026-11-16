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
      ['default', 'style_default'],
      ['concise', 'style_concise'],
      ['proactive', 'style_proactive'],
      ['explanatory', 'style_explanatory'],
      ['learning', 'style_learning'],
      ['custom', 'style_custom'],
    ]
    const IDENTITY_OPTIONS = [
      ['off', 'identity_off'],
      ['deepseek-v4.1', 'identity_deepseek'],
      ['claude-opus-5.5', 'identity_opus55'],
      ['claude-fable-5.2', 'identity_fable52'],
      ['claude-sonnet-5.5', 'identity_sonnet55'],
      ['gpt-6.1-sol', 'identity_gpt61'],
      ['grok-4.7', 'identity_grok47'],
      ['kimi-k3', 'identity_kimi3'],
      ['glm-5.3', 'identity_glm53'],
      ['minimax-m3.1', 'identity_minimax31'],
      ['custom', 'identity_custom'],
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
      style_hint: 'Claude Code has no extra style by default: its base prompt already asks for concise answers, no preamble or recap, and 1-3 sentences for simple questions. "Concise" here is the closest match; "Default" leaves the DSH prompt untouched.',
      style_legend: 'Recommended: pick "Concise" for a Claude Code-like feel.',
      style_default: 'No extra rules (host default)',
      style_concise: 'Concise (matches Claude Code default; recommended)',
      style_proactive: 'Proactive (start now, confirm destructive steps)',
      style_explanatory: 'Explanatory (short Why notes)',
      style_learning: 'Learning (leave a small piece to the user)',
      style_custom: 'Custom rules',
      identity_title: 'Self-presentation (overrides the prompt identity)',
      identity_hint: 'When enabled, the prompt assembly replaces the DSH harness identity and persona lines (not appends another line), so the model does not see two names. It changes self-description only and never grants capabilities; tools remain the source of truth. Do not use it to misrepresent the product to end users.',
      identity_off: 'Off (keep DSH identity)',
      identity_deepseek: 'DeepSeek V4.1',
      identity_opus55: 'Claude Opus 5.5',
      identity_fable52: 'Claude Fable 5.2',
      identity_sonnet55: 'Claude Sonnet 5.5',
      identity_gpt61: 'GPT-6.1 Sol',
      identity_grok47: 'Grok 4.7',
      identity_kimi3: 'Kimi K3',
      identity_glm53: 'GLM-5.3',
      identity_minimax31: 'MiniMax M3.1',
      identity_custom: 'Custom identity',
      moduleName_microcompact: '上下文微压缩',
      moduleName_focusChain: '任务聚焦链',
      moduleName_duplicateGuard: '卡死循环检测',
      moduleName_turnGuard: '回合护栏',
      moduleName_editCheck: '编辑后检查',
      moduleName_checkpoint: '文件快照',
      moduleName_goalGate: '目标证据门禁',
      moduleName_repoMap: '仓库地图',
      moduleName_cacheReport: '缓存与成本报告',
      moduleName_memoryLint: '记忆审计',
      moduleName_hookBus: '生命周期 Hook',
      moduleName_handoffNotes: '压缩交接笔记',
      moduleName_skillPack: '内置技能',
      moduleName_reviewGate: '完成前复核',
      moduleName_stylePack: '风格与身份（本页）',
      module_microcompact: 'Clears the oldest tool results under context pressure to save tokens.',
      module_focusChain: 'Re-injects the todo list every few tool calls so long tasks stay on track.',
      module_duplicateGuard: 'Warns, then blocks, when the same call or error repeats.',
      module_turnGuard: 'Bounds steps/minutes per turn and gates turn close on evidence and todos.',
      module_editCheck: 'Runs lint/typecheck/tests after edits and feeds failures back (off by default).',
      module_checkpoint: 'Snapshots files before writes so checkpoint_restore can roll back.',
      module_goalGate: 'Requires a passing verification command before a goal can be completed.',
      module_repoMap: 'Renders the important files and symbols of a large repository within a budget.',
      module_cacheReport: 'Reports cache hit rate, cost, compression ledger and unexpected-miss attribution.',
      module_memoryLint: 'Audits AGENTS.md/CLAUDE.md conflicts, duplicates and broken links, and records proposals.',
      module_hookBus: 'Runs user-configured lifecycle hook commands (off by default).',
      module_handoffNotes: 'Writes goal/todo/recent-activity notes before compaction and restores them after.',
      module_skillPack: 'Registers four built-in skills that load instructions on demand.',
      module_reviewGate: 'Deterministic pre-completion diff review: secrets, conflict markers, debug prints, large deletions.',
      module_stylePack: 'This page: response style and self-presentation (commands still work if turned off).',
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
      style_hint: 'Claude Code 的「默认」没有额外风格：它的基础提示词本身就要求简洁、不要前奏/复述、简单问题 1-3 句。所以本页的「简洁」最接近 Claude Code 默认；选「不追加」则完全保留 DSH 原样，不额外加任何规则。',
      style_legend: '推荐：想更接近 Claude Code 的回复体感，选「简洁」。',
      style_default: '不追加规则（DSH 原样）',
      style_concise: '简洁（对齐 Claude Code 默认，推荐）',
      style_proactive: '主动（直接开工，破坏性操作前确认）',
      style_explanatory: '解释（附「Why」说明）',
      style_learning: '学习（留一小段给你写）',
      style_custom: '自定义规则',
      identity_title: '自我呈现（覆盖系统提示词身份）',
      identity_hint: '开启后会在系统提示词装配层替换掉 DSH 的「harness 身份」和「persona 行」（不是只在末尾追加一句话），这样模型不会同时看到两个名字。它只改变自我描述，不会带来任何能力；工具仍是唯一事实来源。不要用它向最终用户冒充其他产品。',
      identity_off: '关闭（保留 DSH 身份）',
      identity_deepseek: 'DeepSeek V4.1',
      identity_opus55: 'Claude Opus 5.5',
      identity_fable52: 'Claude Fable 5.2',
      identity_sonnet55: 'Claude Sonnet 5.5',
      identity_gpt61: 'GPT-6.1 Sol',
      identity_grok47: 'Grok 4.7',
      identity_kimi3: 'Kimi K3',
      identity_glm53: 'GLM-5.3',
      identity_minimax31: 'MiniMax M3.1',
      identity_custom: '自定义身份',
      module_microcompact: '上下文快满时，清掉最旧的工具结果，省 token。',
      module_focusChain: '每几步把待办清单重新贴进对话，防止长任务跑偏。',
      module_duplicateGuard: '发现同一调用/同一错误反复出现时，先提醒再拦截。',
      module_turnGuard: '限制单回合步数/时长，收尾前检查证据和待办。',
      module_editCheck: '改完代码自动跑 lint/类型检查/测试，失败把错误贴回来（默认关）。',
      module_checkpoint: '写文件前做快照，可 checkpoint_restore 回滚。',
      module_goalGate: '目标完成前必须跑验证命令，拿不出证据就不让标完成。',
      module_repoMap: '给大仓库生成「重要文件 + 符号」地图，按预算截断。',
      module_cacheReport: '报告缓存命中率、成本、压缩账本，以及意外 miss 归因。',
      module_memoryLint: '审计 AGENTS.md/CLAUDE.md 的冲突、重复、坏链接，并记录记忆提案。',
      module_hookBus: '执行你在配置里写的生命周期 hook 命令（默认关）。',
      module_handoffNotes: '压缩前把目标/待办/最近活动写成笔记，压缩后贴回来。',
      module_skillPack: '注册 4 个内置技能，让模型按需加载使用说明。',
      module_reviewGate: '完成前对 diff 做确定性检查：密钥、冲突标记、调试残留、大删除。',
      module_stylePack: '本页这些风格与自我呈现设置（关掉后仍可用 /boost-* 命令切换）。',
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
      '.dwb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px 16px;}',
      '.dwb-module{display:flex;flex-direction:column;gap:2px;}',
      '.dwb-module-desc{margin:0 0 0 24px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5c6370);}',
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

    function optionList(options, translate) {
      return options.map(([value, key]) => h('option', { key: value, value }, translate(key)))
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
                }, optionList(STYLE_OPTIONS, t)),
                h('p', { className: 'dwb-muted' }, t('style_legend')),
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
                }, optionList(IDENTITY_OPTIONS, t)),
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
                MODULES.map(([id, fallback]) => {
                  const nameKey = 'moduleName_' + id
                  const translated = t(nameKey)
                  return h('div', { className: 'dwb-module', key: id },
                    h('label', { className: 'dwb-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: values.modules[id] !== false,
                        disabled: !editable,
                        onChange: (event) => update({ modules: { ...values.modules, [id]: event.target.checked } }),
                      }),
                      translated === nameKey ? fallback : translated),
                    h('p', { className: 'dwb-module-desc' }, t('module_' + id)))
                }))),
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
