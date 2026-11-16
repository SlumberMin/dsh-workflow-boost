/**
 * Verify lib/config.js and lib/live-config.js against the REAL
 * @deepseek-ai/schemastery shipped by the host.
 *
 * Why this exists: the unit suite deliberately uses a fake `z` to stay
 * dependency-free. That let a P0 slip through for a whole release —
 * `.optional()` and `.describe()` are zod methods, not schemastery methods,
 * so the real host threw while constructing Config and the plugin never
 * loaded. It also let a whole settings page go missing: only fields declared
 * `.volatile()` are projected into the plugin settings form.
 *
 * This gate loads the actual host package in a throwaway module tree, mirrors
 * the host's volatileForm() projection, and checks that the live-config layer
 * dereferences the resulting runtime references correctly.
 *
 * Usage: node test/verify-config.mjs [path-to-schemastery-package]
 * Env:   DSH_SCHEMASTERY=<package root>  (overrides auto-detection)
 * Exit:  0 = all PASS (or SKIP when no host package is installed)
 *        1 = at least one FAIL
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = homedir()

const SECTIONS = [
  'microcompact', 'focusChain', 'duplicateGuard', 'turnGuard', 'editCheck',
  'checkpoint', 'goalGate', 'repoMap', 'memoryLint', 'hookBus',
  'handoffNotes', 'skillPack', 'reviewGate', 'stylePack', 'cacheReport',
]
/** Array-of-object fields stay ordinary config: the generated form cannot edit them. */
const ORDINARY_FIELDS = [
  ['duplicateGuard', 'whitelist'],
  ['editCheck', 'checks'],
  ['goalGate', 'verifyCommands'],
  ['hookBus', 'hooks'],
]

const candidates = [
  process.env.DSH_SCHEMASTERY,
  process.argv[2],
  'D:/DevTools/dsh-home/profiles/desktop/node_modules/@deepseek-ai/schemastery',
  join(home, '.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery'),
  join(home, '.dsh/profiles/node_modules/@deepseek-ai/schemastery'),
].filter(Boolean)

const found = []
for (const dir of candidates) {
  const pkg = join(dir, 'package.json')
  if (!existsSync(pkg)) continue
  try {
    const version = JSON.parse(readFileSync(pkg, 'utf8')).version
    if (!found.some((entry) => entry.version === version)) found.push({ dir, version })
  } catch { /* not a usable package */ }
}

if (found.length === 0) {
  console.log('SKIP verify-config: no host @deepseek-ai/schemastery found.')
  console.log('     Set DSH_SCHEMASTERY=<package root> to run this gate.')
  process.exit(0)
}

let failures = 0
const report = (ok, name, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ': ' + detail : ''))
  if (!ok) failures += 1
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

/**
 * Mirror of packages/settings/settings/src/schema.ts :: volatileForm():
 * a node with meta.volatile contributes its whole subtree, otherwise only
 * object children with a volatile ancestor survive.
 */
function projectForm(node) {
  if (node?.meta?.volatile) return { whole: true, node }
  if (node?.type === 'object') {
    const dict = {}
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      const childForm = projectForm(child)
      if (childForm) dict[key] = childForm
    }
    return Object.keys(dict).length ? { whole: false, dict } : undefined
  }
  return undefined
}

function countEditable(form) {
  if (!form) return 0
  if (form.whole) {
    const node = form.node
    return node.type === 'object' ? Object.keys(node.dict ?? {}).length : 1
  }
  return Object.values(form.dict).reduce((total, child) => total + countEditable(child), 0)
}

const sourceText = readFileSync(join(root, 'lib/config.js'), 'utf8')
report(!sourceText.includes('.optional()'), 'no zod-only .optional() in config.js')
report(!sourceText.includes('.describe('), 'no zod-only .describe() in config.js')
report(sourceText.includes('typeof schema.volatile'), '.volatile() guarded for schemastery < 3.19')
report((sourceText.match(/: formObject\(\{/g) ?? []).length === SECTIONS.length,
  'all ' + SECTIONS.length + ' module sections use the live formObject() builder')

for (const { dir, version } of found) {
  console.log('--- schemastery ' + version + ' @ ' + dir + ' ---')
  const tmp = mkdtempSync(join(tmpdir(), 'dwb-verify-config-'))
  try {
    const lib = join(tmp, 'lib')
    const pkgRoot = join(tmp, 'node_modules/@deepseek-ai/schemastery')
    mkdirSync(lib, { recursive: true })
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}\n', 'utf8')
    for (const file of ['lib/config.js', 'lib/defaults.js', 'lib/live-config.js']) {
      cpSync(join(root, file), join(tmp, file))
    }
    for (const file of ['package.json', 'lib/index.mjs', 'lib/index.cjs']) {
      const from = join(dir, file)
      if (existsSync(from)) cpSync(from, join(pkgRoot, file))
    }
    const hostModules = dirname(dirname(dir))
    for (const dep of ['@deepseek-ai/cosmokit', '@standard-schema/spec']) {
      const from = join(hostModules, dep)
      if (existsSync(from)) cpSync(from, join(tmp, 'node_modules', dep), { recursive: true })
    }

    const stamp = '?v=' + Date.now() + '-' + Math.random().toString(36).slice(2)
    const zUrl = pathToFileURL(join(pkgRoot, 'lib/index.mjs')).href + stamp
    const z = (await import(zUrl)).default
    const { Config } = await import(pathToFileURL(join(lib, 'config.js')).href + stamp)
    const { createLiveConfig, refreshLiveConfig } = await import(pathToFileURL(join(lib, 'live-config.js')).href + stamp)

    const run = (name, fn) => {
      try { const detail = fn() ?? ''; report(true, name, detail) }
      catch (error) { report(false, name, error instanceof Error ? error.message : String(error)) }
    }

    run('Config constructs under the real schema builder', () => {
      assert(typeof Config === 'function', 'Config is not a callable schema')
      for (const id of SECTIONS) assert(Config.dict?.[id], id + ' section missing')
      return SECTIONS.length + ' sections built'
    })

    const majorMinor = version.split('.').map(Number)
    const supportsVolatile = majorMinor[0] > 3 || (majorMinor[0] === 3 && majorMinor[1] >= 19)

    if (supportsVolatile) {
      run('settings form projects the master switch and all 15 sections', () => {
        const form = projectForm(Config)
        assert(form && !form.whole, 'no form projected from Config')
        assert(form.dict.enabled, 'master enabled switch is not live-editable')
        for (const id of SECTIONS) {
          assert(form.dict[id], id + ' has no editable fields in the settings form')
        }
        return Object.keys(form.dict).length + ' top-level form entries'
      })
      run('settings form exposes enough per-module fields', () => {
        const form = projectForm(Config)
        const total = countEditable(form)
        assert(total >= 80, 'only ' + total + ' editable fields projected (expected >= 80)')
        for (const id of SECTIONS) {
          assert(countEditable(form.dict[id]) >= 2, id + ' exposes fewer than 2 editable fields')
        }
        return total + ' editable fields'
      })
      run('complex array fields stay ordinary config', () => {
        const form = projectForm(Config)
        for (const [section, field] of ORDINARY_FIELDS) {
          assert(!form.dict[section]?.dict?.[field], section + '.' + field + ' should not be projected')
        }
        assert(form.dict.reviewGate?.dict?.checks, 'reviewGate.checks object should stay editable')
        return ORDINARY_FIELDS.length + ' array fields excluded'
      })
      run('field-level volatile values arrive as live .get() references', () => {
        const parsed = Config({ stylePack: { style: 'concise' }, microcompact: { triggerRatio: 0.8 } })
        assert(typeof parsed.stylePack?.style?.get === 'function', 'stylePack.style is not a live reference')
        assert(parsed.stylePack.style.get() === 'concise', 'style value lost')
        assert(typeof parsed.microcompact?.triggerRatio?.get === 'function', 'microcompact.triggerRatio is not a live reference')
        assert(parsed.microcompact.triggerRatio.get() === 0.8, 'triggerRatio value lost')
        return 'per-field references confirmed'
      })
      run('live-config flattens and refreshes real host references in place', () => {
        const first = Config({ stylePack: { style: 'concise' }, microcompact: { triggerRatio: 0.8 } })
        const live = createLiveConfig(first)
        assert(live.stylePack.style === 'concise', 'style not flattened')
        assert(live.microcompact.triggerRatio === 0.8, 'triggerRatio not flattened')
        assert(live.microcompact.enabled === true, 'schema defaults lost while flattening')
        const section = live.microcompact
        const second = Config({ stylePack: { style: 'learning' }, microcompact: { triggerRatio: 0.9 } })
        refreshLiveConfig(live, second)
        assert(live.microcompact === section, 'nested section object was replaced (modules cache it)')
        assert(section.triggerRatio === 0.9, 'triggerRatio did not refresh')
        assert(live.stylePack.style === 'learning', 'style did not refresh')
        return 'flatten + in-place refresh OK'
      })
    } else {
      run('older schema builder still loads (volatile gracefully absent)', () => {
        assert(typeof Config === 'function', 'Config did not load')
        assert(Config.dict?.stylePack, 'stylePack section missing')
        assert(projectForm(Config) === undefined, 'unexpected live form projection')
        const parsed = Config({ microcompact: { triggerRatio: 0.8 } })
        const live = createLiveConfig(parsed)
        assert(live.microcompact.triggerRatio === 0.8, 'plain config must pass through live-config')
        return 'plain section, settings-page live edit unavailable'
      })
    }
  } catch (error) {
    report(false, 'schemastery ' + version + ' environment', error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? 'VERIFY-CONFIG: all gates passed' : 'VERIFY-CONFIG: ' + failures + ' gate(s) failed')
process.exitCode = failures === 0 ? 0 : 1
