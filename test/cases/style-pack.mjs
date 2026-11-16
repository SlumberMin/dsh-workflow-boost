/**
 * stylePack 1.2.0 cases.
 *
 * Covers the pure preset catalog (including the 2026-06 source cutoff),
 * rendering, persistence helpers, the real DSH command contract, tail-notice
 * injection, volatile settings-page edits and fail-open behaviour.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, assert, assertEqual } from '../harness.mjs'
import { createFakeContext, fakeLoadHost } from '../fakes.mjs'
import * as core from '../../lib/pure/style-core.js'
import { install, settingsPath, loadPersisted, savePersisted } from '../../lib/style-pack.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const logs = []
const state = () => ({ log(level, message) { logs.push({ level, message: String(message) }) }, loadHost: fakeLoadHost })
const baseConfig = (overrides = {}) => ({ stylePack: { enabled: true, style: 'default', identity: 'off', persist: false, ...overrides } })

function mount(config = baseConfig()) {
  const fake = createFakeContext()
  const disposer = install(fake.ctx, config, state())
  return { fake, disposer }
}

function commandOf(fake, name) {
  const found = fake.commands.find((entry) => entry.name === name)
  assert(found !== undefined, 'missing command /' + name)
  return found
}

// ---------------------------------------------------------------- catalog

test('catalog: 2026-06 cutoff is enforced for every named identity', () => {
  assertEqual(core.SOURCES_CUTOFF, '2026-06')
  assert(core.SOURCES.length >= 3, 'public release sources must be recorded')
  for (const [name, preset] of Object.entries(core.IDENTITIES)) {
    if (preset.released === null) continue
    assert(/^2026-(0[7-9]|1[0-2])$/.test(preset.released), name + ' predates the cutoff: ' + preset.released)
    assert(preset.line.length > 0, name + ' must have a presentation line')
  }
})

test('catalog: six styles with checkable rule sets', () => {
  assertEqual(Object.keys(core.STYLES), ['default', 'concise', 'proactive', 'explanatory', 'learning', 'custom'])
  for (const [name, preset] of Object.entries(core.STYLES)) {
    assert(Array.isArray(preset.rules), name + ' rules must be an array')
    assert(preset.label.length > 0 && preset.summary.length > 0, name + ' needs label and summary')
  }
  assertEqual(core.STYLES.concise.rules.length, 5)
  assertEqual(core.STYLES.default.rules.length, 0)
})

test('resolveStyleConfig: defaults, trimming and text clipping', () => {
  const resolved = core.resolveStyleConfig({})
  assertEqual(resolved.style, 'default')
  assertEqual(resolved.identity, 'off')
  assertEqual(resolved.applyToSystemPrompt, true)
  assertEqual(resolved.persist, true)
  assertEqual(resolved.identityScope, 'presentation')
  const clipped = core.resolveStyleConfig({ style: '  concise  ', customStyle: 'x'.repeat(5000) })
  assertEqual(clipped.style, 'concise')
  assertEqual(clipped.customStyle.length, core.MAX_TEXT_CHARS)
  assertEqual(core.resolveStyleConfig(undefined).enabled, true)
  assertEqual(core.resolveStyleConfig({ enabled: false }).enabled, false)
})

test('styleRules: preset, custom lines, unknown name', () => {
  assert(core.styleRules('concise', '')[0].startsWith('First sentence'))
  assertEqual(core.styleRules('custom', 'one rule\n\ntwo rules\n'), ['one rule', 'two rules'])
  assertEqual(core.styleRules('not-a-style', ''), [])
  assertEqual(core.styleRules('concise', '').length, core.STYLES.concise.rules.length)
})

test('identityLine: preset, custom single line, unknown name', () => {
  assert(core.identityLine('claude-opus-5.5', '').includes('Claude Opus 5.5'))
  assertEqual(core.identityLine('custom', 'You are A\nYou are B'), 'You are A You are B')
  assertEqual(core.identityLine('not-an-identity', ''), '')
  assertEqual(core.identityIsActive('off'), false)
  assertEqual(core.identityIsActive(''), false)
  assertEqual(core.identityIsActive('grok-4.7'), true)
})

// --------------------------------------------------------------- rendering

test('renderStyleSection: default adds nothing, concise adds rules', () => {
  const empty = core.renderStyleSection(core.resolveStyleConfig({ style: 'default', identity: 'off' }))
  assertEqual(empty, '', 'host prompt must stay byte-identical by default')
  const text = core.renderStyleSection(core.resolveStyleConfig({ style: 'concise' }))
  assert(text.includes('## Response style'))
  assert(text.includes('First sentence states the answer'))
  assert(!text.includes('self-presentation only'), 'no identity line means no identity caveat')
})

test('renderStyleSection: identity is presentation-only by default', () => {
  const settings = core.resolveStyleConfig({ identity: 'claude-fable-5.2' })
  const text = core.renderStyleSection(settings)
  assert(text.startsWith('You are Claude Fable 5.2'))
  assert(text.includes('self-presentation only'))
  const full = core.renderStyleSection({ ...settings, identityScope: 'full' })
  assert(!full.includes('self-presentation only'))
  assert(full.includes('Treat the identity line above as the model identity'))
  assertEqual(core.renderStyleSection({ ...settings, applyToSystemPrompt: false }), '')
})

test('renderSwitchNotice: empty for defaults, carries rules when active', () => {
  assertEqual(core.renderSwitchNotice(core.resolveStyleConfig({})), '')
  const notice = core.renderSwitchNotice(core.resolveStyleConfig({ style: 'concise', identity: 'kimi-k3' }))
  assert(notice.startsWith('[style switch] '))
  assert(notice.includes('Response style:'))
  assert(notice.includes('Kimi K3'))
})

test('describeSelection and renderCatalog: unknown names and marked selection', () => {
  const selection = core.describeSelection({ style: 'bogus', identity: 'bogus' })
  assertEqual(selection.style.label, '(unknown)')
  assertEqual(selection.identity.label, '(unknown)')
  assert(selection.styles.includes('concise') && selection.identities.includes('off'))
  const catalog = core.renderCatalog(core.resolveStyleConfig({ style: 'concise' }))
  assert(catalog.includes('2026-06'))
  assert(catalog.includes('* concise'))
  assert(catalog.includes('/boost-style <name>'))
  assert(catalog.includes('claude-opus-5.5'))
})

test('applyChange: allowlisted, immutable and clipped', () => {
  const before = core.resolveStyleConfig({ style: 'default', identity: 'off' })
  const next = core.applyChange(before, { style: 'concise', identity: 'bogus', customStyle: 'y'.repeat(5000) })
  assertEqual(next.style, 'concise')
  assertEqual(next.identity, 'off', 'unknown identity must be ignored')
  assertEqual(next.customStyle.length, core.MAX_TEXT_CHARS)
  assertEqual(before.style, 'default', 'input must not be mutated')
  assertEqual(core.applyChange(before, null), before)
})

// ------------------------------------------------------------- persistence

test('settingsPath normalizes Windows separators and trailing slashes', () => {
  assertEqual(settingsPath('D:\\work\\project\\'), 'D:/work/project/.dsh/workflow-boost/style.json')
  assertEqual(settingsPath('/ws'), '/ws/.dsh/workflow-boost/style.json')
})

test('loadPersisted tolerates missing, malformed and non-object files', async () => {
  assertEqual(await loadPersisted('', async () => '{}'), undefined)
  assertEqual(await loadPersisted('/ws', undefined), undefined)
  assertEqual(await loadPersisted('/ws', async () => '{broken'), undefined)
  assertEqual(await loadPersisted('/ws', async () => 'null'), undefined)
  const value = await loadPersisted('/ws', async () => '{"style":"concise"}')
  assertEqual(value.style, 'concise')
})

test('savePersisted writes only the four choice fields', async () => {
  let written
  const ok = await savePersisted('/ws', core.resolveStyleConfig({ style: 'concise', identity: 'grok-4.7' }), async (path, text) => { written = { path, text } }, state())
  assertEqual(ok, true)
  assert(written.path.endsWith('/.dsh/workflow-boost/style.json'))
  const parsed = JSON.parse(written.text)
  assertEqual(Object.keys(parsed).sort(), ['customIdentity', 'customStyle', 'identity', 'savedAt', 'style'])
  assertEqual(parsed.identity, 'grok-4.7')
  assertEqual(await savePersisted('', {}, async () => {}, state()), false)
  assertEqual(await savePersisted('/ws', {}, async () => { throw new Error('read-only') }, state()), false)
})

// ------------------------------------------------------- host wiring: commands

test('commands: four definitions follow the native DSH contract', async () => {
  const { fake, disposer } = mount()
  await tick()
  assertEqual(fake.commands.map((entry) => entry.name), ['boost-style', 'boost-identity', 'boost-show', 'boost-reset'])
  for (const entry of fake.commands) {
    assert(typeof entry.handler === 'function', entry.name + ' needs a handler')
    assert(typeof entry.description === 'string' && entry.description.length > 0, entry.name + ' needs a description')
    if (entry.name !== 'boost-show' && entry.name !== 'boost-reset') {
      assert(typeof entry.input?.hint === 'string' && entry.input.hint.length > 0, entry.name + ' needs an input hint')
    }
  }
  disposer()
})

test('commands: /boost-style switches style and boost_settings reports it', async () => {
  const { fake, disposer } = mount()
  await tick()
  await tick()
  const agent = { session: {} }
  const result = await commandOf(fake, 'boost-style').handler({ agent, rawInput: '  concise  ' })
  assertEqual(result.kind, 'success')
  assert(result.text.includes('concise'))
  const tool = fake.tools.find((entry) => entry?.name === 'boost_settings')
  assert(tool !== undefined, 'boost_settings tool was not registered')
  const report = await tool.execute({}, { agent })
  assert(String(report).includes('Active style: concise'))
  disposer()
})

test('commands: unknown style is rejected without changing the selection', async () => {
  const { fake, disposer } = mount()
  await tick()
  await tick()
  const agent = { session: {} }
  const result = await commandOf(fake, 'boost-style').handler({ agent, rawInput: 'bogus' })
  assertEqual(result.kind, 'error')
  const tool = fake.tools.find((entry) => entry?.name === 'boost_settings')
  assert(String(await tool.execute({}, { agent })).includes('Active style: default'))
  disposer()
})

test('commands: identity switch and custom text land in the tail notice', async () => {
  const { fake, disposer } = mount()
  await tick()
  const agent = { session: {} }
  const identity = await commandOf(fake, 'boost-identity').handler({ agent, rawInput: 'claude-opus-5.5' })
  assertEqual(identity.kind, 'success')
  const custom = await commandOf(fake, 'boost-style').handler({ agent, rawInput: 'custom Answer in one line.' })
  assertEqual(custom.kind, 'success')
  // DSH contract: (exec, result, next) => Promise<PostToolDecision>, waterfall.
  // fake.waterfall() passes only two arguments and would hide a signature bug.
  const chain = fake.listeners.get('tools/post-execute') ?? []
  let index = 0
  const next = async () => (index < chain.length
    ? chain[index++]({ agent }, undefined, next)
    : { kind: 'accept' })
  const downstream = await next()
  assert(Array.isArray(downstream.additionalContexts), 'switch must add an additional context')
  const notice = downstream.additionalContexts[0]?.content?.[0]?.text ?? downstream.additionalContexts[0]?.text ?? ''
  assert(String(notice).includes('[style switch]'))
  assert(String(notice).includes('Answer in one line.'))
  assert(String(notice).includes('Claude Opus 5.5'))
  disposer()
})

test('commands: a missing agent object never throws', async () => {
  const { fake, disposer } = mount()
  await tick()
  const style = await commandOf(fake, 'boost-style').handler({ agent: undefined, rawInput: 'concise' })
  assertEqual(style.kind, 'success')
  const show = await commandOf(fake, 'boost-show').handler({})
  assertEqual(show.kind, 'success')
  const reset = await commandOf(fake, 'boost-reset').handler({ agent: undefined })
  assertEqual(reset.kind, 'success')
  disposer()
})

test('commands: /boost-reset restores the configured default', async () => {
  const { fake, disposer } = mount(baseConfig({ style: 'explanatory' }))
  await tick()
  const agent = { session: {} }
  await commandOf(fake, 'boost-style').handler({ agent, rawInput: 'concise' })
  const reset = await commandOf(fake, 'boost-reset').handler({ agent })
  assertEqual(reset.kind, 'success')
  const shown = await commandOf(fake, 'boost-show').handler({ agent })
  assert(shown.text.includes('* explanatory'), 'reset must fall back to the row config')
  disposer()
})

// --------------------------------------------------- host wiring: volatile config

test('volatile config: settings-page edits refresh the static section', async () => {
  let current = { style: 'concise', identity: 'off', enabled: true, persist: false }
  const config = { stylePack: { get: () => current } }
  const { fake, disposer } = mount(config)
  assertEqual(fake.sections.length, 1, 'a volatile section must still render on install')
  assert(fake.sections[0].text.includes('First sentence states the answer'))
  current = { style: 'explanatory', identity: 'off', enabled: true, persist: false }
  await fake.emit('loader/volatile-update', [['stylePack', 'style']])
  assertEqual(fake.sections.length, 1, 'the old section must be disposed before the new one is added')
  assert(fake.sections[0].text.includes('Why'), 'the refreshed section must use the new config value')
  disposer()
})

test('disabled module registers nothing; broken host fails open', async () => {
  const off = createFakeContext()
  assertEqual(install(off.ctx, baseConfig({ enabled: false }), state()), undefined)
  assertEqual(off.commands.length, 0)
  assertEqual(off.sections.length, 0)
  const broken = {
    logger: { info() {}, warn() {}, debug() {} },
    on() { throw new Error('boom') },
    get() { throw new Error('boom') },
    tools: { register() { throw new Error('boom') } },
    systemPrompt: { section() { throw new Error('boom') } },
  }
  const disposer = install(broken, baseConfig(), state())
  assert(typeof disposer === 'function')
  await tick()
  disposer()
})

test('config schema exposes stylePack fields as volatile for the settings form', () => {
  const path = fileURLToPath(new URL('../../lib/config.js', import.meta.url))
  const text = readFileSync(path, 'utf8')
  const start = text.indexOf('stylePack: formObject({')
  assert(start >= 0, 'stylePack must use formObject() so its fields are volatile')
  assert(text.includes('typeof schema.volatile'), 'volatile() must be guarded for schemastery < 3.19')
  const section = text.slice(start, text.indexOf('cacheReport: formObject({'))
  assert(section.includes('customStyle') && section.includes('customIdentity'), 'custom fields must be editable too')
  assert(section.includes("z.const('claude-fable-5.2')"), 'identity preset must be selectable in the form')
  const sections = text.match(/: formObject\(\{/g) ?? []
  assert(sections.length === 15, 'all 15 modules must expose live-editable fields, got ' + sections.length)
})
