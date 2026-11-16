/**
 * moduleLifecycle — decide which modules are mounted, and reconcile that set
 * when a settings-page edit changes an `enabled` switch.
 *
 * Extracted from index.js so the enable/disable behaviour can be unit-tested
 * in a clean Node process (index.js imports Config, which needs the host's
 * @deepseek-ai/schemastery). No host imports here.
 *
 * Ordinary parameter edits need no remount: modules read the shared live
 * config object, which lib/live-config.js refreshes in place.
 */
export function createModuleLifecycle(ids, { install, wanted, log }) {
  const mounted = new Map()
  const enabled = []
  const warn = (message) => {
    try { log?.('warn', message) } catch { /* logging must never break a turn */ }
  }

  const start = (id) => {
    let disposer
    try {
      disposer = install?.(id)
    } catch (error) {
      warn('module ' + id + ' failed to install: ' + describe(error))
      return
    }
    mounted.set(id, disposer)
  }

  const stop = (id) => {
    if (!mounted.has(id)) return
    const disposer = mounted.get(id)
    mounted.delete(id)
    try {
      disposer?.()
    } catch (error) {
      warn('module ' + id + ' cleanup failed: ' + describe(error))
    }
  }

  for (const id of ids) {
    if (!wanted(id)) {
      try { log?.('info', 'module ' + id + ' disabled by config') } catch { /* ignore */ }
      continue
    }
    start(id)
    if (mounted.has(id)) enabled.push(id)
  }

  return {
    enabled,
    isMounted: (id) => mounted.has(id),
    /** Mount newly enabled modules and unmount newly disabled ones. Idempotent. */
    reconcile() {
      for (const id of ids) {
        const on = wanted(id)
        const active = mounted.has(id)
        if (on && !active) start(id)
        else if (!on && active) stop(id)
      }
    },
    disposeAll() {
      for (const id of [...mounted.keys()]) stop(id)
    },
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
