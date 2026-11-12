/**
 * reviewGate — deterministic pre-completion diff review.
 *
 * Registers `review_diff`: it runs git in the session working directory, parses
 * the unified diff, applies four deterministic checks (secrets, conflict
 * markers, debug prints, large deletions), renders a risk-first report with a
 * human checklist, and records evidence for goalGate.requireReview.
 *
 * Everything is fail-open: missing git, a missing working directory, an invalid
 * model argument or an internal error produces an explicit "unavailable,
 * nothing guessed" report and never throws to the host. No review record is
 * written when no diff was actually examined.
 */
import { errorText, loadHost, logWarn, runCommand as defaultRunCommand } from './shared.js'
import {
  GIT_TIMEOUT_MS,
  REVIEW_CONTRACT,
  buildGitInvocation,
  buildGitPlan,
  buildReviewRecord,
  parseStatusPorcelain,
  parseUnifiedDiff,
  renderReviewReport,
  renderUnavailableReview,
  resolveReviewConfig,
  runChecks,
  truncateDiff,
  normalizePaths,
  validateRef,
} from './pure/review-core.js'

/** Registered tool name. */
const TOOL_NAME = REVIEW_CONTRACT.toolName

/** Plugin-state field holding the per-agent review evidence weak map. */
const REVIEWS_FIELD = REVIEW_CONTRACT.recordField

/** Canonical output: one text report. */
const REVIEW_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { report: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.report }],
}

const REVIEW_DESCRIPTION = 'Deterministically review the current git diff before claiming completion: reports '
  + 'secret-looking additions, unresolved merge-conflict markers, debug prints and unusually large deletions, with '
  + 'a risk-first list, a suggested fix per finding and a closing human checklist. Runs git in the session working '
  + 'directory (working tree + index against HEAD, or against the supplied base). Use it right before telling the '
  + 'user the work is done or marking a goal complete, especially when goalGate.requireReview is enabled. It is a '
  + 'deterministic checklist, not a full code review, and it never modifies files.'

/**
 * Read the latest review evidence for one agent.
 *
 * Statuses: missing (never reviewed), blocked (blockers found), stale (outside
 * the freshness window) or ok (fresh, no blockers). Missing/broken state reads
 * report "missing" rather than throwing.
 * @param state - shared plugin state (holds the reviews weak map).
 * @param agent - live agent.
 * @param freshWithinMs - freshness window in milliseconds (Infinity when unknown).
 * @param now - current milliseconds.
 * @returns { status, record, ageMs, fresh }.
 */
export function readReview(state, agent, freshWithinMs, now = Date.now()) {
  try {
    const reviews = state !== null && typeof state === 'object' ? state[REVIEWS_FIELD] : undefined
    if (!(reviews instanceof WeakMap) || agent === null || typeof agent !== 'object') return { status: 'missing' }
    const record = reviews.get(agent)
    if (record === null || record === undefined || typeof record !== 'object') return { status: 'missing' }
    const ageMs = Number.isFinite(record.at) ? Math.max(0, now - record.at) : Infinity
    const fresh = !Number.isFinite(freshWithinMs) || ageMs <= freshWithinMs
    if (record.ok !== true || Number(record.findings) > 0) return { status: 'blocked', record, ageMs, fresh }
    if (!fresh) return { status: 'stale', record, ageMs, fresh }
    return { status: 'ok', record, ageMs, fresh }
  } catch {
    return { status: 'missing' }
  }
}

/**
 * Resolve the session working directory through the host service only.
 * There is deliberately no process.cwd() fallback: reviewing the wrong tree is
 * worse than reporting that the review is unavailable.
 * @param ctx - plugin context.
 * @param exec - execution metadata carrying the agent.
 * @returns absolute directory, or undefined.
 */
export function resolveCwd(ctx, exec) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined
    const session = exec?.agent?.session
    if (service === null || service === undefined || typeof service.get !== 'function') return undefined
    if (session === null || session === undefined) return undefined
    const cwd = service.get(session)
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/** First non-empty line of a text, clipped for a report reason. */
function firstLine(text, max = 200) {
  const line = String(text ?? '').split('\n').find((entry) => entry.trim().length > 0) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Run one git probe through the injectable command runner. Never throws. */
async function runGit(state, args, cwd) {
  const invocation = buildGitInvocation(args, process.platform, process.env.ComSpec)
  const runner = typeof state?.runCommand === 'function' ? state.runCommand : defaultRunCommand
  try {
    const run = await runner(invocation.file, invocation.args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
    if (run === null || run === undefined || typeof run !== 'object') {
      return { code: -1, stdout: '', stderr: 'the command runner returned no result', timedOut: false }
    }
    return {
      code: Number.isFinite(run.code) ? run.code : -1,
      stdout: typeof run.stdout === 'string' ? run.stdout : '',
      stderr: typeof run.stderr === 'string' ? run.stderr : '',
      timedOut: run.timedOut === true,
    }
  } catch (error) {
    return { code: -1, stdout: '', stderr: errorText(error), timedOut: false }
  }
}

/**
 * Execute one review_diff call: git probes, checks, evidence record, report.
 * Never throws; never writes a record when no diff could be examined.
 * @param ctx - plugin context.
 * @param settings - normalized review config.
 * @param state - shared plugin state.
 * @param args - model arguments { base, paths, focus }.
 * @param exec - execution metadata.
 * @returns { ok, report, record }.
 */
export async function runReview(ctx, settings, state, args, exec) {
  const startedAt = Date.now()
  const cwd = resolveCwd(ctx, exec)
  if (cwd === undefined) {
    return {
      ok: false,
      report: renderUnavailableReview('the session working directory is unknown (ctx.get("workingDirectory").get(session) returned nothing); no process-wide fallback is used.'),
    }
  }
  const baseResult = validateRef(args?.base)
  if (baseResult.ok !== true) {
    return { ok: false, report: renderUnavailableReview('invalid base argument: ' + baseResult.reason) }
  }
  const pathsResult = normalizePaths(args?.paths)
  if (pathsResult.ok !== true) {
    return { ok: false, report: renderUnavailableReview('invalid paths argument: ' + pathsResult.reason) }
  }
  const status = await runGit(state, ['status', '--porcelain=v1', '--untracked-files=normal'], cwd)
  if (status.code !== 0 || status.timedOut) {
    const detail = status.timedOut ? 'git status timed out' : firstLine(status.stderr, 240) || ('git status exited ' + status.code)
    return { ok: false, report: renderUnavailableReview('git is not usable in ' + cwd + ': ' + detail) }
  }
  const head = await runGit(state, ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)
  const hasHead = head.code === 0
  const steps = buildGitPlan({ base: baseResult.value, paths: pathsResult.paths, hasHead })
  let diffText = ''
  let statText = ''
  let diffFailure = undefined
  for (const step of steps) {
    const run = await runGit(state, step.args, cwd)
    const output = run.stdout.length > 0 ? run.stdout : ''
    if (step.kind === 'stat') {
      if (run.code === 0 && output.length > 0) statText += (statText.length > 0 ? '\n' : '') + output
      continue
    }
    if (run.timedOut || run.code !== 0) {
      const detail = run.timedOut ? 'timed out' : firstLine(run.stderr, 240) || ('exit ' + run.code)
      diffFailure = diffFailure ?? (step.label + ': ' + detail)
    }
    if (output.length > 0) diffText += (diffText.length > 0 ? '\n' : '') + output
  }
  if (diffText.length === 0 && diffFailure !== undefined) {
    return { ok: false, report: renderUnavailableReview('git diff failed in ' + cwd + ': ' + diffFailure + '. No diff was analysed; nothing was guessed.') }
  }
  const statusInfo = parseStatusPorcelain(status.stdout)
  const parsed = parseUnifiedDiff(diffText)
  const truncated = truncateDiff(diffText, settings.maxDiffChars)
  // Checks run only on the analysed (possibly truncated) diff — the report
  // says so explicitly; stats still describe the whole diff.
  const checkedDiff = truncated.truncated ? parseUnifiedDiff(truncated.text) : parsed
  const checks = runChecks({ parsed: checkedDiff, checks: settings.checks, focus: args?.focus, truncated: truncated.truncated })
  const stats = {
    files: parsed.stats.files,
    insertions: parsed.stats.insertions,
    deletions: parsed.stats.deletions,
    untracked: statusInfo.untracked,
  }
  const at = Date.now()
  const record = buildReviewRecord({ at, findings: checks.findings, stats, truncated: truncated.truncated, base: baseResult.value })
  try {
    state[REVIEWS_FIELD] = state[REVIEWS_FIELD] ?? new WeakMap()
    if (exec?.agent !== null && exec?.agent !== undefined && typeof exec.agent === 'object') {
      state[REVIEWS_FIELD].set(exec.agent, record)
    }
  } catch (error) {
    logWarn(state, 'reviewGate: could not record review evidence: ' + describe(error))
  }
  const report = renderReviewReport({
    findings: checks.findings,
    stats,
    untrackedFiles: statusInfo.files.filter((file) => file.code.startsWith('??')).map((file) => file.path),
    statText,
    base: baseResult.value ?? (hasHead ? 'HEAD' : '(unborn HEAD; index/worktree vs empty tree)'),
    cwd,
    diffTruncated: truncated.truncated,
    diffOmittedChars: truncated.omitted,
    maxChars: settings.maxDiffChars,
    elapsedMs: Date.now() - startedAt,
    checkedAt: at,
  })
  return { ok: record.ok, report, record }
}

/** Build the review_diff definition from an injected defineTool. */
export function buildReviewDefinition(defineTool, ctx, settings, state) {
  return defineTool({
    name: TOOL_NAME,
    description: REVIEW_DESCRIPTION,
    parameters: {
      base: { type: 'string', description: 'Optional git revision to diff against (for example HEAD~1 or main). Default: HEAD (worktree + index).' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional path filters, relative to the session working directory.' },
      focus: { type: 'string', description: 'Optional case-insensitive substring; only matching findings are listed.' },
    },
    output: REVIEW_OUTPUT,
    execute: async (args, exec) => {
      try {
        return await runReview(ctx, settings, state, args, exec)
      } catch (error) {
        logWarn(state, 'reviewGate: review_diff failed open: ' + describe(error))
        return { ok: false, report: renderUnavailableReview('internal error: ' + describe(error)) }
      }
    },
  })
}

/**
 * Load the host tools package through an injectable loader; a fake may return
 * the module synchronously or as a promise.
 * @param state - shared plugin state.
 * @param onModule - called with the loaded module.
 * @param onError - called with the load error.
 */
function whenHostTools(state, onModule, onError) {
  const host = typeof state?.loadHost === 'function' ? state.loadHost : loadHost
  try {
    const loaded = host('@deepseek-ai/dsh-tools')
    if (loaded !== null && typeof loaded === 'object' && typeof loaded.then === 'function') {
      void loaded.then((module) => onModule(module)).catch((error) => onError(error))
      return
    }
    onModule(loaded)
  } catch (error) {
    onError(error)
  }
}

/**
 * Install the review gate.
 * @param ctx - plugin context (already inside a ctx.effect scope).
 * @param config - resolved row configuration.
 * @param state - shared plugin state (log, optional loadHost, runCommand).
 * @returns disposer.
 */
export function install(ctx, config, state) {
  const settings = resolveReviewConfig(config)
  const disposers = []
  let disposed = false
  const track = (disposer) => {
    if (typeof disposer !== 'function') return
    if (disposed) {
      try {
        disposer()
      } catch {
        /* disposal must not throw */
      }
      return
    }
    disposers.push(disposer)
  }
  const dispose = () => {
    disposed = true
    for (const entry of disposers.splice(0)) {
      try {
        entry()
      } catch {
        /* disposal must not throw */
      }
    }
  }
  if (!settings.enabled) {
    state.reviewGateReady = false
    return dispose
  }
  // Readiness is what goalGate.requireReview consults: if review_diff could not
  // be registered, completion must not be blocked forever waiting for a tool
  // that does not exist (fail-open beats a configuration trap).
  state.reviewGateReady = false
  try {
    state[REVIEWS_FIELD] = state[REVIEWS_FIELD] ?? new WeakMap()
  } catch {
    /* evidence storage is best-effort; the tool still works without a record */
  }
  if (typeof ctx?.tools?.register !== 'function') {
    logWarn(state, 'reviewGate: ctx.tools.register is unavailable; review_diff not registered')
    return dispose
  }
  whenHostTools(state, (module) => {
    const defineTool = module?.defineTool
    if (typeof defineTool !== 'function') {
      logWarn(state, 'reviewGate: @deepseek-ai/dsh-tools is unavailable; review_diff not registered')
      return
    }
    try {
      track(ctx.tools.register(buildReviewDefinition(defineTool, ctx, settings, state)))
      state.reviewGateReady = true
    } catch (error) {
      logWarn(state, 'reviewGate: could not register review_diff: ' + describe(error))
    }
  }, (error) => {
    logWarn(state, 'reviewGate: host tools package load failed open: ' + describe(error))
  })
  try {
    state?.log?.('info', 'reviewGate active (review_diff registered, maxDiffChars=' + settings.maxDiffChars + ')')
  } catch {
    /* logging is best-effort */
  }
  return dispose
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
