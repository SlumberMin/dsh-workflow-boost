/**
 * Verify lib/config.js against the REAL @deepseek-ai/schemastery shipped by
 * the host.
 *
 * Why this exists: the unit suite deliberately uses a fake `z` to stay
 * dependency-free. That let a P0 slip through for a whole release —
 * `.optional()` and `.describe()` are zod methods, not schemastery methods,
 * so the real host threw while constructing Config and the plugin never
 * loaded. This gate loads the actual host package in a throwaway module tree.
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

const sourceText = readFileSync(join(root, 'lib/config.js'), 'utf8')
report(!sourceText.includes('.optional()'), 'no zod-only .optional() in config.js')
report(!sourceText.includes('.describe('), 'no zod-only .describe() in config.js')
report(sourceText.includes('typeof schema.volatile'), '.volatile() guarded for schemastery < 3.19')

for (const { dir, version } of found) {
  console.log('--- schemastery ' + version + ' @ ' + dir + ' ---')
  const tmp = mkdtempSync(join(tmpdir(), 'dwb-verify-config-'))
  try {
    const lib = join(tmp, 'lib')
    const pkgRoot = join(tmp, 'node_modules/@deepseek-ai/schemastery')
    mkdirSync(lib, { recursive: true })
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}\n', 'utf8')
    for (const file of ['lib/config.js', 'lib/defaults.js']) {
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

    const run = (name, fn) => {
      try { const detail = fn() ?? ''; report(true, name, detail) }
      catch (error) { report(false, name, error instanceof Error ? error.message : String(error)) }
    }

    run('Config constructs under the real schema builder', () => {
      assert(typeof Config === 'function', 'Config is not a callable schema')
      assert(Config.dict?.stylePack, 'stylePack section missing')
      return 'all sections built'
    })

    const majorMinor = version.split('.').map(Number)
    const supportsVolatile = majorMinor[0] > 3 || (majorMinor[0] === 3 && majorMinor[1] >= 19)

    if (supportsVolatile) {
      run('stylePack is volatile (settings page renders its form)', () => {
        assert(Config.dict.stylePack.meta?.volatile === true, 'meta.volatile is not true')
        return 'meta.volatile=true'
      })
      run('stylePack resolves through .get() with real defaults', () => {
        const parsed = Config({ stylePack: { style: 'concise', identity: 'claude-opus-5.5' } })
        assert(typeof parsed.stylePack?.get === 'function', 'no .get() on the volatile reference')
        const value = parsed.stylePack.get()
        assert(value.style === 'concise' && value.identity === 'claude-opus-5.5', 'edits not visible through .get()')
        assert(value.enabled === true && typeof value.persist === 'boolean', 'defaults not applied')
        return 'style=concise identity=claude-opus-5.5'
      })
      run('settings-form projection accepts the editable fields', () => {
        // Mirrors dsh-settings plainSchema(): drop meta.volatile, resolve a plain form value.
        const plain = new z(Config.dict.stylePack.toJSON())
        delete plain.meta.volatile
        const value = plain({ style: 'learning', customStyle: 'one rule' })
        assert(value.style === 'learning', 'style not editable')
        assert(value.customStyle === 'one rule', 'customStyle not editable')
        assert('identity' in value && 'customIdentity' in value, 'identity fields missing from form')
        return Object.keys(value).length + ' fields'
      })
    } else {
      run('older schema builder still loads (volatile gracefully absent)', () => {
        assert(typeof Config === 'function', 'Config did not load')
        assert(Config.dict?.stylePack, 'stylePack section missing')
        assert(Config.dict.stylePack.meta?.volatile !== true, 'unexpected volatile marker')
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
