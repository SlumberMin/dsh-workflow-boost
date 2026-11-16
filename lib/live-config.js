/**
 * liveConfig — flatten a Cordis volatile row config into ONE plain, mutable
 * object that every module can keep a reference to.
 *
 * Why this layer exists
 * ---------------------
 * The plugin settings page only projects fields declared `.volatile()` in the
 * Config schema (host: packages/settings/settings/src/schema.ts, volatileForm).
 * A volatile field arrives in `apply()` as a stable reference object with a
 * `.get()` method, not as a plain value; the Loader commits new values into
 * those same references and emits `loader/volatile-update` (vendor/loader).
 *
 * Fifteen modules read `config.section.field` directly. Rather than rewriting
 * every read to `.get()`, we take a snapshot once and REFRESH IT IN PLACE on
 * every volatile update. Modules hold the same object (and the same nested
 * section objects), so a settings-page edit is visible on their next read with
 * no remount and no module changes.
 *
 * Degradation: on schemastery < 3.19 no field is volatile, so the row config
 * is already plain; snapshotConfig() simply copies it and the plugin behaves
 * exactly as before (edits then require the normal Loader remount).
 *
 * No host imports: this is pure data plumbing and is unit-testable in a clean
 * Node process.
 */

/** Volatile references implement the shared `get()` protocol. */
export function isVolatileRef(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

function readRef(ref) {
  try {
    return ref.get()
  } catch {
    return undefined
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Recursively dereference volatile values into detached plain values. */
export function snapshotConfig(value) {
  if (isVolatileRef(value)) return snapshotConfig(readRef(value))
  if (Array.isArray(value)) return value.map(snapshotConfig)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = snapshotConfig(child)
    return out
  }
  return value
}

/** Build the shared config object handed to every module. */
export function createLiveConfig(raw) {
  const value = snapshotConfig(raw ?? {})
  return isPlainObject(value) ? value : {}
}

/**
 * Re-read the row config and write the new values into `target` in place.
 * Nested plain objects are merged (not replaced) so a module that cached
 * `const section = config.microcompact` keeps seeing live values. Arrays and
 * scalars are replaced by value.
 */
export function refreshLiveConfig(target, raw) {
  const next = snapshotConfig(raw ?? {})
  if (!isPlainObject(target) || !isPlainObject(next)) return target
  mergeInPlace(target, next)
  return target
}

function mergeInPlace(target, next) {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) delete target[key]
  }
  for (const [key, value] of Object.entries(next)) {
    const current = target[key]
    if (isPlainObject(current) && isPlainObject(value)) mergeInPlace(current, value)
    else target[key] = value
  }
}
