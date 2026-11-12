/**
 * Test-only fakes for the host seams. No @deepseek-ai imports: the fakes let
 * verify-harness exercise module wiring in a clean Node environment.
 */

export const fakeHosts = {
  '@deepseek-ai/dsh-tools': {
    defineTool: (definition) => ({ ...definition, __fake: true }),
  },
  '@deepseek-ai/dsh-llm': {
    freezeMessage: (message) => message,
    createUserMessage: (message) => message,
  },
}

/** A loader returning the fake host packages by exact specifier. */
export function fakeLoadHost(specifier) {
  return Promise.resolve(fakeHosts[specifier])
}

/** Record what a module registers, and let the test drive its listeners. */
export function createFakeContext(options = {}) {
  const listeners = new Map()
  const tools = []
  const sections = []
  const services = new Map(Object.entries(options.services ?? {}))
  const commands = []
  const effects = []
  const commandsService = {
    register(definition) {
      commands.push(definition)
      return () => {
        const index = commands.indexOf(definition)
        if (index >= 0) commands.splice(index, 1)
      }
    },
    find() { return undefined },
  }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    get(name) {
      if (name === 'commands') return services.get('commands') ?? commandsService
      return services.get(name)
    },
    effect(fn) {
      effects.push(fn)
      const disposer = fn()
      return () => { try { disposer?.() } catch { /* ignore */ } }
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      guard() { return () => {} },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      getSectionOrder() { return undefined },
    },
  }
  return {
    ctx,
    listeners,
    tools,
    sections,
    commands,
    services,
    /** Invoke one waterfall listener chain. */
    async waterfall(name, payload) {
      const chain = listeners.get(name) ?? []
      let index = 0
      const next = async () => {
        if (index >= chain.length) return undefined
        const listener = chain[index]
        index += 1
        return listener(payload, next)
      }
      return next()
    },
    /** Invoke one serial/emit listener chain (payload only). */
    async serial(name, payload) {
      const chain = listeners.get(name) ?? []
      let result
      for (const listener of chain) result = await listener(payload)
      return result
    },
    /** Invoke emit listeners with positional args. */
    async emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) await listener(...args)
    },
  }
}

/** Minimal Session stand-in for tool/session surface assertions. */
export function createFakeSession(options = {}) {
  const events = []
  const appended = []
  const messages = []
  const session = {
    id: options.id ?? 'session-1',
    seq: 0,
    header: { cwd: options.cwd ?? 'C:/workspace', createdAt: Date.now() },
    surface: { nodes: [] },
    events,
    appended,
    append(type, data, opts) {
      const event = { type, data, seq: session.seq, ...opts }
      session.seq += 1
      appended.push(event)
      events.push(event)
      return event
    },
    eventAt(seq) {
      return events[seq]
    },
    deriveEventMessage(event) {
      if (event?.type === 'tool/result') return event.data?.message
      if (event?.type === 'assistant/message') return event.data
      return undefined
    },
  }
  return session
}
