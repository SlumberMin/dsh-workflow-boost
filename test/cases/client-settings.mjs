import { test, assert, assertEqual } from '../harness.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const clientPath = join(root, 'client.js')
const source = readFileSync(clientPath, 'utf8')

/** Evaluate client.js in a VM with a fake ModuleLoader; return the module definition. */
function loadClient(overrides = {}) {
  let captured = null
  const window = {
    __ModuleLoader__: {
      load(definition) { captured = definition },
    },
  }
  const context = vm.createContext({ window, console, ...overrides })
  vm.runInContext(source, context, { filename: 'client.js' })
  return captured
}

function fakeCtx() {
  const slots = []
  const locales = []
  const effects = []
  const formCalls = []
  const ctx = {
    get(name) { return name === 'configForms' ? undefined : undefined },
    locale: {
      register(namespace, dict) { locales.push({ namespace, dict }); return () => {} },
      bind() { return (key) => key },
    },
    configForms: {
      get(id) { formCalls.push(id); return undefined },
    },
    slots: {
      inject(name, register) { slots.push({ name, register }); return () => {} },
      register(definition) { return () => {} },
    },
    effect(fn, label) { effects.push({ label, dispose: fn() }); return () => {} },
  }
  return { ctx, slots, locales, effects, formCalls }
}

test('client module loads through the DSH ModuleLoader contract', () => {
  const definition = loadClient()
  assert(definition !== null, 'ModuleLoader.load must be called')
  assertEqual(definition.id, 'dsh-workflow-boost')
  assert(typeof definition.factory === 'function', 'factory must be a function')
})

test('client module injects the settings services it renders from', () => {
  const definition = loadClient()
  const module = definition.factory((name) => {
    if (name === 'react') return {
      createElement: () => null,
      useEffect: () => {},
      useMemo: () => null,
      useState: () => [null, () => {}],
      useSyncExternalStore: () => ({ status: 'unavailable' }),
    }
    return undefined
  })
  assert(Array.isArray(module.inject), 'module.inject must be an array')
  for (const service of ['slots', 'locale', 'configForms']) assert(module.inject.includes(service), 'missing service ' + service)
  assert(typeof module.apply === 'function', 'module.apply must be a function')
})

test('client apply binds the workflow-boost row and registers both surfaces', () => {
  const definition = loadClient()
  const module = definition.factory((name) => {
    if (name === 'react') return {
      createElement: () => null,
      useEffect: () => {},
      useMemo: () => null,
      useState: () => [null, () => {}],
      useSyncExternalStore: () => ({ status: 'unavailable' }),
    }
    return undefined
  })
  const { ctx, slots, locales, formCalls } = fakeCtx()
  module.apply(ctx)
  assertEqual(formCalls[0], 'workflow-boost')
  assert(locales.length >= 1, 'locale namespace must be registered')
  assertEqual(locales[0].namespace, 'dsh-workflow-boost')
  assert(locales[0].dict.zh !== undefined && locales[0].dict.en !== undefined, 'zh and en dictionaries required')
  const names = slots.map((entry) => entry.name)
  assert(names.includes('settings.section'), 'Settings dialog section must be registered')
  assert(names.includes('plugins.row.config'), 'Plugins page config card must be registered')
})

test('client registers a localized settings label and a stable slot key', () => {
  const definition = loadClient()
  const module = definition.factory((name) => {
    if (name === 'react') return {
      createElement: () => null,
      useEffect: () => {},
      useMemo: () => null,
      useState: () => [null, () => {}],
      useSyncExternalStore: () => ({ status: 'unavailable' }),
    }
    return undefined
  })
  const { ctx, slots } = fakeCtx()
  const registrations = []
  ctx.slots.inject = (name, registerCb) => {
    slots.push({ name })
    const dispose = registerCb()
    return typeof dispose === 'function' ? dispose : () => {}
  }
  ctx.slots.register = (definitionIn, component) => {
    registrations.push({ definition: definitionIn, component })
    return () => {}
  }
  module.apply(ctx)
  const section = registrations.find((entry) => entry.definition.name === 'settings.section')
  assert(section !== undefined, 'settings.section registration missing')
  assertEqual(section.definition.id, 'workflow-boost')
  assert(typeof section.definition.order === 'number')
  assertEqual(section.definition.label(), 'nav')
  const card = registrations.find((entry) => entry.definition.name === 'plugins.row.config')
  assert(card !== undefined, 'plugins.row.config registration missing')
  assertEqual(card.definition.key, 'dsh-workflow-boost#workflow-boost')
})

test('package manifest advertises the client half and ships client.js', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert(pkg.dsh.client !== undefined, 'dsh.client must be declared')
  assertEqual(pkg.dsh.client.platform, 'web')
  assert(pkg.exports['./client'] !== undefined, './client export required')
  assert(pkg.files.includes('client.js'), 'client.js must be packaged')
})
