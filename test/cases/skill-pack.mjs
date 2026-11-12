/**
 * skillPack 1.1.0 cases.
 *
 * Covers the static catalog contract (names/description length/when-to-use/
 * instruction bodies/key tool names), the two native registration shapes
 * (registerProvider provider + register fallback), exposeCatalog semantics,
 * late service discovery, repeated installs, clean disposal and fail-open.
 */
import { test, assert, assertEqual } from '../harness.mjs'
import * as core from '../../lib/pure/skill-core.js'
import { install } from '../../lib/skill-pack.js'

/** Fake native skills service exposing the registerProvider path. */
function createFakeSkills(options = {}) {
  const record = { providerFactories: [], registered: [], disposals: 0 }
  const service = {
    registerProvider(create) {
      if (options.providerThrows === true) throw new Error('registerProvider unsupported')
      record.providerFactories.push(create)
      return () => {
        record.disposals += 1
      }
    },
    register(skill) {
      record.registered.push(skill)
      return () => {
        record.disposals += 1
      }
    },
  }
  if (options.onlyRegister === true) delete service.registerProvider
  if (options.noRegister === true) delete service.register
  return { service, record }
}

/** Fake context whose get('skills') resolves lazily (for mount-order tests). */
function createCtx(options = {}) {
  const listenerState = { listeners: [], unsubscribed: 0 }
  const ctx = {
    get(name) {
      if (name !== 'skills') return undefined
      return typeof options.skills === 'function' ? options.skills() : options.skills
    },
    on(name, listener) {
      listenerState.listeners.push({ name, listener })
      return () => {
        listenerState.unsubscribed += 1
      }
    },
  }
  return { ctx, listenerState }
}

function createState() {
  const logs = []
  return {
    logs,
    log(level, message) {
      logs.push({ level, message: String(message) })
    },
  }
}

test('catalog: four built-in skills with valid descriptions, bodies and tool names', () => {
  const names = core.skillNames()
  assertEqual(names, [
    'workflow-boost-verify',
    'workflow-boost-cache',
    'workflow-boost-checkpoint',
    'workflow-boost-repomap',
  ])
  assertEqual(core.validateCatalog(), [], 'built-in catalog must be valid')
  assert(Object.isFrozen(core.SKILL_CATALOG), 'catalog is frozen')
  for (const entry of core.SKILL_CATALOG) {
    assert(Object.isFrozen(entry), 'entry is frozen: ' + entry.name)
    assert(entry.description.length > 0 && entry.description.length <= core.MAX_DESCRIPTION_CHARS, 'description length: ' + entry.name)
    assert(/\buse\b/iu.test(entry.description), 'description states when to use: ' + entry.name)
    assert(entry.instructions.length >= core.MIN_INSTRUCTIONS_CHARS, 'instructions min: ' + entry.name)
    assert(entry.instructions.length <= core.MAX_INSTRUCTIONS_CHARS, 'instructions max: ' + entry.name)
    assert(entry.source.kind === 'dsh-workflow-boost', 'source marker: ' + entry.name)
    for (const tool of core.REQUIRED_TOOLS[entry.name]) {
      assert(entry.instructions.includes(tool), entry.name + ' instructions must mention ' + tool)
    }
  }
  const summaries = core.skillSummaries()
  assertEqual(summaries.length, 4)
  assertEqual(Object.keys(summaries[0]), ['name', 'description'], 'catalog exposes only name + description')
})

test('validateCatalog: flags broken names, descriptions, bodies, sources and duplicates', () => {
  assertEqual(core.validateCatalog([]), ['catalog is empty'])
  const broken = core.validateCatalog([
    { name: 'Bad Name', description: 'short', instructions: 'tiny', source: {} },
  ])
  assert(broken.some((problem) => problem.includes('invalid kebab-case')), 'bad name flagged')
  assert(broken.some((problem) => problem.includes('when to use')), 'missing when-to-use flagged')
  assert(broken.some((problem) => problem.includes('shorter than')), 'short body flagged')
  assert(broken.some((problem) => problem.includes('invalid source')), 'bad source flagged')
  const duplicate = core.validateCatalog([
    { name: 'a-skill', description: 'Use when x', instructions: 'x'.repeat(400), source: { kind: 'dsh-workflow-boost' } },
    { name: 'a-skill', description: 'Use when y', instructions: 'x'.repeat(400), source: { kind: 'dsh-workflow-boost' } },
  ])
  assert(duplicate.some((problem) => problem.includes('duplicate skill name')), 'duplicate flagged')
  const missingTool = core.validateCatalog([
    { name: 'workflow-boost-verify', description: 'Use when verifying', instructions: 'x'.repeat(400), source: { kind: 'dsh-workflow-boost' } },
  ])
  assert(missingTool.some((problem) => problem.includes('goal_verify')), 'missing required tool name flagged')
})

test('createSkillProvider: candidates and lazy definitions match the host contract', async () => {
  const provider = core.createSkillProvider()
  assertEqual(provider.name, 'dsh-workflow-boost')
  const candidates = await provider.list()
  assertEqual(candidates.length, 4)
  for (const candidate of candidates) {
    assert(typeof candidate.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate.name), 'valid candidate name')
    assert(typeof candidate.description === 'string' && candidate.description.length > 0, 'candidate description')
    assertEqual(typeof candidate.source, 'string', 'host requires a string source')
    assertEqual(candidate.source, 'dsh-workflow-boost')
    assertEqual(candidate.provider, provider.name)
    assertEqual(typeof candidate.rank, 'number')
    assertEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  }
  const definition = await provider.get(candidates[0])
  assertEqual(definition.name, 'workflow-boost-verify')
  assertEqual(typeof definition.content, 'string')
  assertEqual(definition.content, core.SKILL_CATALOG[0].instructions, 'definition body is the catalog body')
  assertEqual(typeof definition.source, 'string')
  assertEqual(definition.provider, provider.name)
  assertEqual(await provider.get({ name: 'does-not-exist' }), undefined)
})

test('createSkillProvider: exposeCatalog=false hides the catalog but keeps definitions loadable', async () => {
  const provider = core.createSkillProvider(core.SKILL_CATALOG, { exposeCatalog: false })
  assertEqual(await provider.list(), [])
  const definition = await provider.get({ name: 'workflow-boost-repomap' })
  assert(definition !== undefined && definition.content.includes('repo_map'))
})

test('install: registers through registerProvider and disposes the registration', async () => {
  const fake = createFakeSkills()
  const { ctx } = createCtx({ skills: fake.service })
  const state = createState()
  const disposer = install(ctx, {}, state)
  assert(typeof disposer === 'function', 'returns a disposer')
  assertEqual(fake.record.providerFactories.length, 1, 'registerProvider used once')
  assertEqual(fake.record.registered.length, 0, 'register fallback not used')
  const provider = fake.record.providerFactories[0]({})
  const candidates = await provider.list()
  assertEqual(core.skillNames(candidates), core.skillNames(), 'catalog exposed through the provider')
  assert(state.logs.some((entry) => entry.level === 'info' && entry.message.includes('registerProvider')), 'info log emitted')
  disposer()
  assertEqual(fake.record.disposals, 1, 'provider disposer called exactly once')
})

test('install: falls back to register(skill) when registerProvider throws', () => {
  const fake = createFakeSkills({ providerThrows: true })
  const { ctx } = createCtx({ skills: fake.service })
  const disposer = install(ctx, {}, createState())
  assertEqual(fake.record.registered.length, 4, 'every skill registered individually')
  for (const skill of fake.record.registered) {
    const entry = core.SKILL_CATALOG.find((candidate) => candidate.name === skill.name)
    assert(entry !== undefined, 'registered a known skill: ' + skill.name)
    assertEqual(skill.content, entry.instructions, 'body passed as content')
    assertEqual(skill.source, 'dsh-workflow-boost')
  }
  disposer()
  assertEqual(fake.record.disposals, 4, 'each runtime skill disposed')
})

test('install: a service with only register() uses the runtime path', () => {
  const fake = createFakeSkills({ onlyRegister: true })
  const { ctx } = createCtx({ skills: fake.service })
  const disposer = install(ctx, { skillPack: { exposeCatalog: false } }, createState())
  assertEqual(fake.record.registered.length, 4)
  disposer()
  assertEqual(fake.record.disposals, 4)
})

test('install: exposeCatalog=false is forwarded to the provider', async () => {
  const fake = createFakeSkills()
  const { ctx } = createCtx({ skills: fake.service })
  const disposer = install(ctx, { skillPack: { exposeCatalog: false } }, createState())
  const provider = fake.record.providerFactories[0]({})
  assertEqual(await provider.list(), [], 'catalog hidden')
  const definition = await provider.get({ name: 'workflow-boost-cache' })
  assert(definition !== undefined && definition.content.includes('cache_report'), 'definition still loadable')
  disposer()
})

test('install: repeated install on the same context does not duplicate registrations', () => {
  const fake = createFakeSkills()
  const { ctx } = createCtx({ skills: fake.service })
  const state = createState()
  const first = install(ctx, {}, state)
  const second = install(ctx, {}, state)
  assertEqual(fake.record.providerFactories.length, 1, 'second install is a no-op')
  assert(state.logs.some((entry) => entry.level === 'debug' && entry.message.includes('already registered')), 'no-op is logged at debug')
  first()
  second()
  const third = install(ctx, {}, state)
  assertEqual(fake.record.providerFactories.length, 2, 're-registration works after disposal')
  third()
})

test('install: missing skills service fails open and retries on session events', () => {
  let current
  const fake = createFakeSkills()
  const { ctx, listenerState } = createCtx({ skills: () => current })
  const state = createState()
  const disposer = install(ctx, {}, state)
  assert(typeof disposer === 'function')
  assertEqual(fake.record.providerFactories.length, 0, 'nothing registered without a service')
  assert(listenerState.listeners.length === 1, 'a bounded probe listens for session events')
  assert(state.logs.some((entry) => entry.level === 'debug' && entry.message.includes('unavailable')), 'debug log emitted')
  current = fake.service
  listenerState.listeners[0].listener()
  assertEqual(fake.record.providerFactories.length, 1, 'late service discovered on the first event')
  assertEqual(listenerState.unsubscribed, 1, 'probe unsubscribed after success')
  listenerState.listeners[0].listener()
  assertEqual(fake.record.providerFactories.length, 1, 'no duplicate registration on later events')
  disposer()
})

test('install: broken context never throws', () => {
  const broken = {
    get() {
      throw new Error('boom')
    },
    on() {
      throw new Error('boom')
    },
  }
  const state = createState()
  let disposer
  try {
    disposer = install(broken, {}, state)
  } catch (error) {
    throw new Error('install must not throw: ' + error.message)
  }
  if (typeof disposer === 'function') disposer()
  assert(state.logs.length >= 0)
})

test('install: disabled config returns undefined without registering', () => {
  const fake = createFakeSkills()
  const { ctx } = createCtx({ skills: fake.service })
  const disposer = install(ctx, { skillPack: { enabled: false } }, createState())
  assertEqual(disposer, undefined)
  assertEqual(fake.record.providerFactories.length, 0)
})
