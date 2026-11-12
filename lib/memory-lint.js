/**
 * memoryLint — audit AGENTS.md/CLAUDE.md instruction files and record memory
 * proposals (Claude Code / Cline style).
 *
 * Why it exists: always-on memory files silently rot (duplicate sections,
 * contradictory rules, dead imports, runaway size). This module adds two model
 * tools plus one one-shot notice:
 *
 *  - memory_audit: read-only audit of the instruction files the native loader
 *    would load for this session (project root -> cwd), reporting structured
 *    findings and any pending proposals.
 *  - memory_propose: append a proposal to
 *    <workspace>/.dsh/workflow-boost/memory-proposals.jsonl, deduplicated by
 *    content and capped by maxProposals. It never edits AGENTS.md/CLAUDE.md.
 *  - injectPending: one post-execute notice per agent when proposals are
 *    pending, so a new session's model learns they exist.
 *
 * Working directory resolution and file reads respect the host contracts:
 * ctx.get('workingDirectory').get(session), ctx.get('fs') when its API is
 * detectable, node:fs/promises fallback, and process.cwd() is never used.
 * Every path is contained by the workspace policy or the project-root chain;
 * every failure is logged and swallowed (fail-open).
 *
 * @module dsh-workflow-boost/lib/memory-lint
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sectionDefaults } from './defaults.js'
import { loadHost, logInfo, logWarn } from './shared.js'
import {
  allInstructionCandidates,
  auditMemoryFiles,
  displayPath,
  extractReferences,
  isInsidePath,
  joinPath,
  normalizePath,
  parentPath,
  parseProposalJsonl,
  planProposalAppend,
  referenceCandidate,
  renderAuditReport,
  renderPendingNotice,
  renderProposalResult,
  serializeProposalEntries,
  toPosixPath,
} from './pure/memory-core.js'

/** Plugin-owned state folder inside the workspace. */
export const STATE_DIR = '.dsh/workflow-boost'

/** Proposal store file name. */
export const PROPOSAL_FILE = 'memory-proposals.jsonl'

/** Source label stamped on injected notices. */
export const SOURCE_KIND = 'dsh-workflow-boost'

/** Bound for the one-line notice summary. */
const SUMMARY_MAX_CHARS = 120

/** Resolve the module config, merging lib/defaults.js with the row section. */
export function resolveSettings(config) {
  const merged = sectionDefaults('memoryLint', config)
  const clamp = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
  }
  return {
    enabled: merged.enabled !== false,
    maxFiles: clamp(merged.maxFiles, 40, 1, 200),
    maxFileBytes: clamp(merged.maxFileBytes, 262144, 1024, 2000000),
    maxProposals: clamp(merged.maxProposals, 100, 1, 1000),
    injectPending: merged.injectPending !== false,
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the session working directory through the documented service. */
function workspaceOf(ctx, session) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service === null || service === undefined || typeof service.get !== 'function') return undefined
    const cwd = service.get(session)
    return typeof cwd === 'string' && cwd.trim().length > 0 ? normalizePath(cwd) : undefined
  } catch {
    return undefined
  }
}

/** User-role notice carried through additionalContexts. */
export function makeNoticeMessage(text, summary) {
  const source = String(summary ?? '')
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: source.length <= SUMMARY_MAX_CHARS ? source : source.slice(0, SUMMARY_MAX_CHARS - 1) + '…',
    },
  }
}

/** Append one context to a post-execute decision without losing its kind. */
function withContext(decision, message) {
  const base = decision !== null && typeof decision === 'object' ? decision : { kind: 'accept' }
  const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
  return { ...base, additionalContexts: [...existing, message] }
}

/**
 * Build a file reader that prefers ctx.fs (the host's execution world) and
 * falls back to node:fs/promises only when the service is absent or its API is
 * not detectable. When ctx.fs IS present its errors are treated as final: a
 * denial must not be bypassed by reading through node:fs.
 */
export function createReader(ctx) {
  let service
  try { service = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined } catch { service = undefined }
  const usable = service !== null && service !== undefined &&
    typeof service.resolve === 'function' &&
    typeof service.stat === 'function' &&
    typeof service.readText === 'function'
  const probe = async (absolutePath, cwd, signal) => {
    if (usable) {
      try {
        const target = await service.resolve(absolutePath, { cwd, signal })
        const info = await service.stat(target, signal)
        if (info === undefined || info === null) return { ok: false, reason: 'missing' }
        const type = info.type === 'directory' ? 'directory' : info.type === 'file' ? 'file' : 'other'
        return { ok: true, target, type, size: Number(info.size ?? 0) }
      } catch (error) {
        return { ok: false, reason: 'unavailable', error }
      }
    }
    try {
      const info = await stat(absolutePath)
      const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
      return { ok: true, target: absolutePath, type, size: info.size }
    } catch (error) {
      if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { ok: false, reason: 'missing' }
      return { ok: false, reason: 'unavailable', error }
    }
  }
  return {
    kind: usable ? 'ctx.fs' : 'node',
    /** 'file' | 'directory' | 'other' | 'missing' | 'unknown' */
    async pathType(absolutePath, cwd, signal) {
      const probed = await probe(absolutePath, cwd, signal)
      return probed.ok ? probed.type : probed.reason === 'missing' ? 'missing' : 'unknown'
    },
    /** Read one text file under maxBytes; returns {ok,text,size} or {ok:false,reason}. */
    async readText(absolutePath, cwd, signal, maxBytes) {
      const probed = await probe(absolutePath, cwd, signal)
      if (!probed.ok) return { ok: false, reason: probed.reason }
      if (probed.type !== 'file') return { ok: false, reason: 'not-file' }
      if (probed.size > maxBytes) return { ok: false, reason: 'too-large', size: probed.size }
      if (usable) {
        try {
          const text = await service.readText(probed.target, signal)
          return { ok: true, text: String(text ?? ''), size: probed.size }
        } catch (error) {
          return { ok: false, reason: 'read-error', error }
        }
      }
      try {
        const text = await readFile(absolutePath, 'utf8')
        return { ok: true, text, size: Buffer.byteLength(text) }
      } catch (error) {
        return { ok: false, reason: 'read-error', error }
      }
    },
  }
}

/** Walk up from the endpoint looking for the project marker (.git file or dir). */
async function resolveProjectRoot(reader, endpoint, workspace, signal) {
  let current = normalizePath(endpoint)
  for (let depth = 0; depth < 40; depth += 1) {
    const type = await reader.pathType(joinPath(current, '.git'), workspace, signal)
    if (type === 'directory' || type === 'file') return current
    const parent = parentPath(current)
    if (parent === undefined || parent === '' || parent === current) break
    current = parent
  }
  return normalizePath(endpoint)
}

/** Map an absolute path to the comparable key used by the reference checker. */
function referenceKey(absolutePath) {
  return toPosixPath(normalizePath(absolutePath)).toLowerCase()
}

/** Resolve async existence for every reference before the pure audit runs. */
async function buildReferenceChecker(files, reader, workspace, signal) {
  const candidates = new Set()
  for (const file of files) {
    for (const reference of extractReferences(file.text)) {
      const candidate = referenceCandidate(file, reference.target)
      if (candidate !== undefined) candidates.add(candidate)
    }
  }
  const known = new Map()
  for (const candidate of candidates) {
    const type = await reader.pathType(candidate, workspace, signal)
    known.set(referenceKey(candidate), type === 'file' || type === 'directory' ? 'exists' : type === 'missing' ? 'missing' : 'unknown')
  }
  return (absolutePath) => known.get(referenceKey(absolutePath)) ?? 'unknown'
}

/** Absolute path of the proposal JSONL store inside the workspace. */
export function proposalPath(workspace) {
  return joinPath(workspace, STATE_DIR, PROPOSAL_FILE)
}

/** Session identity for a proposal record. */
function sessionIdOf(session) {
  try {
    const id = session?.id ?? session?.header?.id
    if (typeof id === 'string' && id.length > 0) return id.slice(0, 80)
  } catch { /* fall through */ }
  return 'unknown'
}

/** Read proposals; a missing or corrupt store is simply empty. */
async function loadProposals(file) {
  try {
    const text = await readFile(file, 'utf8')
    return parseProposalJsonl(text)
  } catch {
    return []
  }
}

/** Atomically replace the proposal store (temp sibling + rename). */
async function writeProposalFile(file, entries) {
  await mkdir(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8)
  await writeFile(temp, serializeProposalEntries(entries), 'utf8')
  await rename(temp, file)
}

/** Serialize read-modify-write of one proposal file inside this process. */
const proposalLocks = new Map()
function withFileLock(key, action) {
  const previous = proposalLocks.get(key) ?? Promise.resolve()
  const next = previous.then(() => action(), () => action())
  proposalLocks.set(key, next.then(() => {}, () => {}))
  return next
}

/** Cached pending-proposal count keyed by store path, invalidated by mtime+size. */
const pendingCache = new Map()
async function pendingProposalCount(workspace) {
  const file = proposalPath(workspace)
  let info
  try { info = await stat(file) } catch { return 0 }
  const cached = pendingCache.get(file)
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.count
  const entries = await loadProposals(file)
  pendingCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, count: entries.length })
  return entries.length
}

/** Load the instruction files for one audit call. */
async function collectAuditFiles(reader, settings, workspace, endpoint, singleFile, signal) {
  const projectRoot = singleFile !== undefined
    ? parentPath(singleFile) ?? workspace
    : await resolveProjectRoot(reader, endpoint, workspace, signal)
  const candidates = singleFile !== undefined
    ? [{ absolutePath: singleFile, display: displayPath(workspace, singleFile) }]
    : allInstructionCandidates(projectRoot, endpoint)
  const files = []
  const skipped = []
  let truncated = 0
  for (const candidate of candidates) {
    if (files.length >= settings.maxFiles) {
      truncated += 1
      continue
    }
    const read = await reader.readText(candidate.absolutePath, workspace, signal, settings.maxFileBytes)
    if (read.ok) {
      files.push({ display: displayPath(workspace, candidate.absolutePath), absolutePath: candidate.absolutePath, text: read.text, size: read.size })
    } else if (read.reason === 'too-large') {
      skipped.push({ display: displayPath(workspace, candidate.absolutePath), reason: 'larger than maxFileBytes' })
    }
    // missing / unreadable files are simply absent from the chain
  }
  if (truncated > 0) skipped.push({ display: 'remaining ' + truncated + ' candidate path(s)', reason: 'maxFiles limit reached' })
  return { files, skipped, projectRoot }
}

/** memory_audit implementation. */
async function runAudit(ctx, settings, state, args, exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) return 'memory_audit must be called by the model from an agent turn (no session is attached).'
  const workspace = workspaceOf(ctx, session)
  if (workspace === undefined) return 'memory_audit: the workingDirectory service is unavailable, so the instruction-file chain cannot be resolved. No files were changed.'
  const signal = exec?.signal
  const reader = createReader(ctx)
  const requested = typeof args?.path === 'string' ? args.path.trim() : ''
  let endpoint = workspace
  let singleFile
  if (requested.length > 0) {
    const absolute = requested.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(requested) || requested.startsWith('\\\\')
    const resolved = absolute ? normalizePath(requested) : joinPath(workspace, requested)
    if (!isInsidePath(workspace, resolved)) {
      return 'memory_audit: "' + requested + '" is outside the session workspace. Only files inside the project can be audited.'
    }
    const type = await reader.pathType(resolved, workspace, signal)
    if (type === 'missing') return 'memory_audit: "' + requested + '" does not exist.'
    if (type === 'file') singleFile = resolved
    else endpoint = resolved
  }
  const collected = await collectAuditFiles(reader, settings, workspace, endpoint, singleFile, signal)
  const checkReference = await buildReferenceChecker(collected.files, reader, workspace, signal)
  const audit = auditMemoryFiles(collected.files, { checkReference })
  const proposals = await loadProposals(proposalPath(workspace))
  logInfo(state, 'memoryLint: audited ' + collected.files.length + ' file(s), ' + audit.total + ' finding(s), reader=' + reader.kind)
  return renderAuditReport({
    files: collected.files,
    audit,
    skipped: collected.skipped,
    proposals,
    projectRoot: collected.projectRoot,
  })
}

/** memory_propose implementation. */
async function runPropose(ctx, settings, state, args, exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) return 'memory_propose must be called by the model from an agent turn (no session is attached).'
  const workspace = workspaceOf(ctx, session)
  if (workspace === undefined) return 'memory_propose: the workingDirectory service is unavailable, so the proposal store cannot be located. Nothing was written.'
  const text = typeof args?.text === 'string' ? args.text : ''
  if (text.trim().length === 0) return 'memory_propose: text must be a non-empty rule or convention. Nothing was written.'
  const file = proposalPath(workspace)
  try {
    return await withFileLock(file, async () => {
      const entries = await loadProposals(file)
      const plan = planProposalAppend({
        entries,
        text,
        reason: typeof args?.reason === 'string' ? args.reason : '',
        maxProposals: settings.maxProposals,
        createdAt: new Date().toISOString(),
        sessionId: sessionIdOf(session),
      })
      if (plan.status !== 'added') return renderProposalResult({ status: plan.status, entries: plan.entries })
      await writeProposalFile(file, plan.entries)
      logInfo(state, 'memoryLint: proposal recorded (' + plan.entries.length + ' pending, removed=' + plan.removed + ')')
      return renderProposalResult({ status: 'added', entries: plan.entries, removed: plan.removed })
    })
  } catch (error) {
    logWarn(state, 'memoryLint: proposal store write failed: ' + describe(error))
    return 'memory_propose: could not write the proposal (' + describe(error) + '). No instruction file was modified.'
  }
}

/** One-time pending-proposal notice; null when nothing should be injected. */
async function pendingNotice(ctx, settings, state, injectedAgents, exec) {
  const agent = exec?.agent
  const session = agent?.session
  if (agent === undefined || agent === null || session === undefined || session === null) return null
  try {
    if (injectedAgents.has(agent)) return null
  } catch {
    return null
  }
  const workspace = workspaceOf(ctx, session)
  if (workspace === undefined) return null
  const count = await pendingProposalCount(workspace)
  if (count <= 0) return null
  try { injectedAgents.add(agent) } catch { return null }
  logInfo(state, 'memoryLint: injected pending-proposal notice (' + count + ')')
  return makeNoticeMessage(renderPendingNotice(count), count + ' pending memory proposals')
}

/** Build the registry-ready tool definitions for one install. */
function createToolFactories(ctx, settings, state) {
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
  return [
    () => ({
      name: 'memory_audit',
      description: 'Audit the project instruction files (AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md chain from the project root to the working directory) for duplicate headings, contradictory rules, dead @imports or relative links, oversized files, empty files and stale TODO markers. Read-only: it never edits AGENTS.md/CLAUDE.md. Use it before relying on project memory, when the user asks what the agent remembers, or after memory_propose to review pending proposals.',
      parameters: {
        path: { type: 'string', description: 'Optional workspace-relative directory (or one .md file) to audit instead of the session working directory.' },
      },
      output,
      execute: async (args, exec) => runAudit(ctx, settings, state, args ?? {}, exec),
    }),
    () => ({
      name: 'memory_propose',
      description: 'Record a proposed durable rule or convention from the user correction in the plugin memory store (deduplicated, capped by config). This does NOT modify AGENTS.md/CLAUDE.md: the user must confirm and the model edits the instruction file itself. Use it when the user corrects the agent or states a convention that should survive the session.',
      parameters: {
        text: { type: 'string', required: true, description: 'The proposed rule/convention, one or two sentences.' },
        reason: { type: 'string', description: 'Optional short reason: which user correction or incident produced this proposal.' },
      },
      output,
      execute: async (args, exec) => runPropose(ctx, settings, state, args ?? {}, exec),
    }),
  ]
}

/**
 * Install the module.
 * @param ctx - Cordis plugin context.
 * @param config - resolved plugin row config.
 * @param state - shared plugin state with log, sessionState and optional loadHost.
 * @returns a disposer with a .ready promise for the async tool registration.
 */
export function install(ctx, config, state) {
  const settings = resolveSettings(config)
  if (!settings.enabled) return undefined
  let disposed = false
  let active = true
  const cleanups = []
  const injectedAgents = new WeakSet()

  // One-shot notice: only after a tool result, only once per agent, only when
  // the store already has proposals. Appended, so the cache prefix is intact.
  if (settings.injectPending && typeof ctx?.on === 'function') {
    try {
      ctx.on('tools/post-execute', async (exec, _result, next) => {
        let message = null
        try {
          if (active) message = await pendingNotice(ctx, settings, state, injectedAgents, exec)
        } catch (error) {
          logWarn(state, 'memoryLint: pending notice failed: ' + describe(error))
          message = null
        }
        const decision = await next()
        if (message === null) return decision
        return withContext(decision, message)
      }, { prepend: true })
    } catch (error) {
      logWarn(state, 'memoryLint: post-execute listener unavailable: ' + describe(error))
    }
  }

  // Tools need defineTool from the host package; load it lazily and asynchronously
  // so the plugin stays importable in a clean Node environment (unit tests).
  const factories = createToolFactories(ctx, settings, state)
  const ready = (async () => {
    try {
      if (typeof ctx?.tools?.register !== 'function') {
        logWarn(state, 'memoryLint: ctx.tools.register is unavailable; memory_audit/memory_propose not registered')
        return
      }
      const host = typeof state?.loadHost === 'function' ? state.loadHost : loadHost
      let toolsModule
      try { toolsModule = await host('@deepseek-ai/dsh-tools') } catch { toolsModule = undefined }
      if (disposed) return
      const define = typeof toolsModule?.defineTool === 'function' ? toolsModule.defineTool : (definition) => definition
      for (const factory of factories) {
        const definition = factory()
        try {
          const cleanup = ctx.tools.register(define(definition))
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        } catch (error) {
          logWarn(state, 'memoryLint: could not register ' + definition.name + ': ' + describe(error))
        }
      }
      logInfo(state, 'memoryLint active (memory_audit/memory_propose registered)')
    } catch (error) {
      logWarn(state, 'memoryLint: tool registration failed: ' + describe(error))
    }
  })()

  const disposer = () => {
    disposed = true
    active = false
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup() } catch { /* disposal must not throw */ }
    }
  }
  disposer.ready = ready
  return disposer
}
