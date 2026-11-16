/**
 * liveConfig cases: the settings page edits fields declared `.volatile()` in
 * Config. Those fields arrive as stable references with a `.get()` method, so
 * lib/live-config.js flattens them into one plain object shared by all modules
 * and refreshes it in place on loader/volatile-update.
 *
 * Everything here runs in a clean Node process with a fake host context.
 */
import { test, assert, assertEqual } from '../harness.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createLiveConfig, isVolatileRef, refreshLiveConfig, snapshotConfig,
} from '../../lib/live-config.js'
import { createModuleLifecycle } from '../../lib/module-lifecycle.js'

const SECTIONS = [
  'microcompact', 'focusChain', 'duplicateGuard', 'turnGuard', 'editCheck',
  'checkpoint', 'goalGate', 'repoMap', 'memoryLint', 'hookBus',
  'handoffNotes', 'skillPack', 'reviewGate', 'stylePack', 'cacheReport',
]

/** Stand-in for a host Volatile reference: the object identity never changes. */
function box(value) {
  let current = value
  return {
    get: () => current,
    set: (next) => { current = next },
  }
}

function rowConfig() {
  const row = { enabled: box(true) }
  for (const id of SECTIONS) row[id] = { enabled: box(false) }
  row.microcompact = {
    enabled: box(true), triggerRatio: box(0.72), placeholder: box('[cleared]'), list: ['a', 'b'],
  }
  row.focusChain = { enabled: box(false), everySteps: box(8) }
  return row
}

test('snapshotConfig dereferences volatile references recursively', () => {
  const snap = snapshotConfig(rowConfig())
  assertEqual(snap.enabled, true)
  assertEqual(snap.microcompact.triggerRatio, 0.72)
  assertEqual(snap.microcompact.list, ['a', 'b'])
  assertEqual(snap.focusChain.everySteps, 8)
  assert(!isVolatileRef(snap.microcompact.triggerRatio), 'a reference leaked into the snapshot')
  assert(!isVolatileRef(snap), 'the snapshot itself must be plain')
})

test('createLiveConfig tolerates missing and plain row config', () => {
  assertEqual(createLiveConfig(undefined), {})
  assertEqual(createLiveConfig({ enabled: false, microcompact: { everySteps: 4 } }), {
    enabled: false, microcompact: { everySteps: 4 },
  })
})

test('refreshLiveConfig keeps nested object identity while picking up new values', () => {
  const row = rowConfig()
  const live = createLiveConfig(row)
  const section = live.microcompact
  assertEqual(section.triggerRatio, 0.72)

  row.microcompact.triggerRatio.set(0.9)
  row.microcompact.placeholder.set('[gone]')
  row.enabled.set(false)
  refreshLiveConfig(live, row)

  assert(live.microcompact === section, 'a module caching config.microcompact would go stale')
  assertEqual(section.triggerRatio, 0.9)
  assertEqual(section.placeholder, '[gone]')
  assertEqual(live.enabled, false)
})

test('refreshLiveConfig drops removed keys and replaces arrays by value', () => {
  const row = rowConfig()
  const live = createLiveConfig(row)
  row.microcompact = { enabled: box(true), triggerRatio: box(0.5), list: ['x'] }
  refreshLiveConfig(live, row)
  assert(!('placeholder' in live.microcompact), 'stale key survived refresh')
  assertEqual(live.microcompact.list, ['x'])
})

test('plain config (schemastery < 3.19) still round-trips', () => {
  const plain = { enabled: true, microcompact: { enabled: true, triggerRatio: 0.6 } }
  const live = createLiveConfig(plain)
  assertEqual(live.microcompact.triggerRatio, 0.6)
  plain.microcompact.triggerRatio = 0.4
  refreshLiveConfig(live, plain)
  assertEqual(live.microcompact.triggerRatio, 0.4)
  assert(!isVolatileRef(live.microcompact.triggerRatio))
})

test('module lifecycle reconciles enable switches on a volatile update', () => {
  const starts = []
  const stops = []
  const active = { a: true, b: false, c: true }
  const disposers = { a: () => stops.push('a'), b: () => stops.push('b'), c: () => stops.push('c') }
  const lifecycle = createModuleLifecycle(['a', 'b', 'c'], {
    install: (id) => { starts.push(id); return disposers[id] },
    wanted: (id) => active[id],
    log: () => {},
  })
  assertEqual(lifecycle.enabled, ['a', 'c'])

  // A settings-page edit turns one module off and another on.
  active.a = false
  active.b = true
  lifecycle.reconcile()
  assertEqual(stops, ['a'], 'disabling a module did not dispose it')
  assert(starts.includes('b'), 'enabling a module did not mount it')
  assert(!lifecycle.isMounted('a') && lifecycle.isMounted('b'))

  // Reconciliation must be idempotent: no change means no re-install.
  const atSwitch = starts.length
  lifecycle.reconcile()
  assertEqual(starts.length, atSwitch)

  // A parameter-only edit must never remount anything.
  lifecycle.reconcile()
  assertEqual(starts.length, atSwitch)

  lifecycle.disposeAll()
  assertEqual(stops.sort(), ['a', 'b', 'c'])
  assertEqual(starts.length, atSwitch)
})

test('apply() refreshes the shared snapshot before modules react to updates', () => {
  const path = fileURLToPath(new URL('../../index.js', import.meta.url))
  const text = readFileSync(path, 'utf8')
  const refresh = text.indexOf("ctx.on('loader/volatile-update'")
  const install = text.indexOf('createModuleLifecycle(')
  assert(refresh >= 0 && install >= 0, 'refresh listener or module lifecycle missing')
  assert(refresh < install, 'refresh listener must be registered BEFORE modules install (stylePack reads the snapshot on the same event)')
  assert(text.includes('refreshLiveConfig(live, config)'), 'refresh listener must refresh the live snapshot')
})
