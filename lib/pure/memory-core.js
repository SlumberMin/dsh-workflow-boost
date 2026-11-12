/**
 * memoryLint pure core — instruction-file discovery policy, audit rules,
 * proposal bookkeeping and report rendering.
 *
 * Why pure: the rules that decide whether an AGENTS.md/CLAUDE.md file is
 * healthy (duplicate headings, contradictory directives, dead imports, size,
 * TODO residue) are text transforms. Keeping them free of host imports lets a
 * clean Node process test every rule, the proposal dedupe/truncation policy and
 * the report wording without a session, a filesystem or Cordis.
 *
 * Existence checks are injected as a predicate so the same code runs against
 * ctx.fs, node:fs, or a test double.
 *
 * Nothing here imports @deepseek-ai/*.
 */

/** Instruction files the native loader understands, in audit order. */
export const INSTRUCTION_FILE_NAMES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
])

/** Fallback defaults mirror lib/defaults.js section memoryLint. */
export const MEMORY_DEFAULTS = Object.freeze({
  enabled: true,
  maxFiles: 40,
  maxFileBytes: 262144,
  maxProposals: 100,
  injectPending: true,
})

/** Files above either limit are too large to be useful always-on memory. */
export const OVERSIZE_LIMITS = Object.freeze({ maxLines: 500, maxBytes: 32768 })

/** Proposal text is a durable note, not a document; keep the file small. */
export const MAX_PROPOSAL_CHARS = 4000

/** Normalize a path to forward slashes. */
export function toPosixPath(value) {
  return String(value ?? '').replace(/\\/gu, '/')
}

/** Resolve '.' and '..' segments lexically. */
export function normalizePath(value) {
  const source = toPosixPath(value)
  const drive = /^([A-Za-z]):/u.exec(source)
  const prefix = drive === null ? (source.startsWith('/') ? '/' : '') : drive[1] + ':'
  const body = drive === null ? source.slice(prefix.length) : source.slice(2)
  const segments = []
  for (const segment of body.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') { if (segments.length > 0) segments.pop(); continue }
    segments.push(segment)
  }
  return prefix + '/' + segments.join('/')
}

/** Strip a trailing slash for comparisons. */
function trimmed(value) {
  return normalizePath(value).replace(/\/+$/u, '')
}

/** Case-normalized comparison form (Windows drive letters are case-insensitive). */
function comparable(value) {
  const path = trimmed(value)
  return /^[A-Za-z]:/u.test(path) ? path.toLowerCase() : path
}

/** Whether path is root itself or lives below it. */
export function isInsidePath(root, path) {
  const base = comparable(root)
  const target = comparable(path)
  if (base.length === 0 || target.length === 0) return false
  return base === target || target.startsWith(base + '/')
}

/** Workspace-relative POSIX path when inside; otherwise the absolute path. */
export function displayPath(root, path) {
  const base = trimmed(root)
  const target = trimmed(path)
  if (!isInsidePath(base, target)) return target
  if (comparable(base) === comparable(target)) return '.'
  // Slice the original path (not the lowercased comparison form) so the
  // reported file name keeps the user's capitalisation (AGENTS.md, CLAUDE.md).
  return target.slice(base.length + 1)
}

/** Append one path segment with forward slashes. */
export function joinPath(...parts) {
  const filtered = parts.filter((part) => typeof part === 'string' && part.length > 0)
  if (filtered.length === 0) return ''
  return normalizePath(filtered.map(toPosixPath).join('/'))
}

/** Parent directory of a normalized path, or undefined at the filesystem root. */
export function parentPath(path) {
  const normalized = trimmed(path)
  const drive = /^([A-Za-z]):/u.exec(normalized)
  const body = drive === null ? normalized : normalized.slice(2)
  const index = body.lastIndexOf('/')
  if (index <= 0) return drive === null ? (normalized.startsWith('/') ? '/' : undefined) : drive[1] + ':/'
  return (drive === null ? '' : drive[1] + ':') + body.slice(0, index)
}

/**
 * Directories from an ancestor to a descendant, ancestor first.
 * Returns just [endpoint] when the two are unrelated.
 */
export function dirChain(projectRoot, endpoint) {
  const root = trimmed(projectRoot)
  const target = trimmed(endpoint)
  if (!isInsidePath(root, target)) return [target]
  const chain = [target]
  let current = target
  while (comparable(current) !== comparable(root)) {
    const parent = parentPath(current)
    if (parent === undefined || comparable(parent) === comparable(current)) break
    chain.push(parent)
    current = parent
  }
  return chain.reverse()
}

/**
 * Walk from startDir towards the filesystem root looking for a project marker
 * directory (.git). The predicate keeps the search pure and testable.
 * @param startDir - directory to start from.
 * @param isMarkerDir - (absolutePath) => boolean, usually ".git exists".
 * @param maxDepth - safety cap for very deep temporary trees.
 * @returns the directory containing the marker, or startDir when none is found.
 */
export function findProjectRoot(startDir, isMarkerDir, maxDepth = 40) {
  let current = trimmed(startDir)
  for (let depth = 0; depth < maxDepth && current.length > 0; depth += 1) {
    try {
      if (isMarkerDir(joinPath(current, '.git')) === true) return current
    } catch { /* a predicate failure means keep walking */ }
    const parent = parentPath(current)
    if (parent === undefined || comparable(parent) === comparable(current)) break
    current = parent
  }
  return trimmed(startDir)
}

/**
 * Candidate instruction files from the project root down to the endpoint.
 * @param projectRoot - top of the chain.
 * @param endpoint - deepest directory to audit (usually the session cwd).
 * @param maxFiles - hard cap; root files come before nested overrides.
 * @returns [{dir, absolutePath, display, name}]
 */
export function allInstructionCandidates(projectRoot, endpoint) {
  const candidates = []
  for (const dir of dirChain(projectRoot, endpoint)) {
    for (const name of INSTRUCTION_FILE_NAMES) {
      const absolutePath = joinPath(dir, name)
      candidates.push({ dir, name, absolutePath, display: displayPath(endpoint, absolutePath) })
    }
  }
  return candidates
}

/**
 * Candidate instruction files capped at maxFiles. Root files come first so a
 * cap keeps the broadest memory in scope.
 */
export function instructionCandidates(projectRoot, endpoint, maxFiles) {
  const limit = Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0 ? Math.floor(Number(maxFiles)) : MEMORY_DEFAULTS.maxFiles
  return allInstructionCandidates(projectRoot, endpoint).slice(0, limit)
}

/** Strip markdown decoration so rules compare by meaning, not punctuation. */
function normalizeLine(text) {
  return String(text ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
    .replace(/[*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** One heading occurrence with the body that follows it (until the next heading). */
export function parseHeadingSections(text) {
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  const headings = []
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(?:```|~~~)/u.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
    if (match !== null) headings.push({ level: match[1].length, text: match[2].trim(), line: index + 1 })
  }
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].line
    const end = index + 1 < headings.length ? headings[index + 1].line - 1 : lines.length
    headings[index].body = lines.slice(start, end).join('\n').trim()
    headings[index].bodyLines = Math.max(0, end - start)
  }
  return headings
}

/**
 * Rule: the same heading appearing twice with different bodies means the file
 * says two different things under one name. Identical bodies are only noise and
 * are NOT reported.
 */
export function auditDuplicateHeadings(file) {
  const findings = []
  const headings = parseHeadingSections(file?.text)
  const groups = new Map()
  for (const heading of headings) {
    const key = heading.text.toLowerCase().replace(/[\s:：.-]+$/u, '')
    if (key.length === 0) continue
    const list = groups.get(key) ?? []
    list.push(heading)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const bodies = new Set(list.map((heading) => heading.body))
    if (bodies.size < 2) continue
    for (const heading of list.slice(1)) {
      findings.push({
        severity: 'warning',
        rule: 'duplicate-heading',
        file: file.display,
        line: heading.line,
        snippet: ('#' + '#'.repeat(heading.level - 1) + ' ' + heading.text).slice(0, 160),
        message: 'Heading "' + heading.text + '" appears ' + list.length + ' times with different content; merge them or give each section a distinct name.',
      })
    }
  }
  return findings
}

/** Known technology families used to spot "use X" vs "use Y" contradictions. */
const TOOL_FAMILIES = Object.freeze([
  Object.freeze(['npm', 'pnpm', 'yarn', 'bun']),
  Object.freeze(['jest', 'vitest', 'mocha', 'ava', 'uvu']),
  Object.freeze(['prettier', 'biome', 'dprint', 'standard']),
  Object.freeze(['eslint', 'oxlint', 'tslint']),
])

/** Tokens that carry no rule meaning on their own. */
const STOP_TOKENS = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'them', 'existing', 'same', 'project', 'code', 'files', 'file', 'new', 'only', 'always', 'never', 'please', 'should', 'must'])

/** Extract "use/prefer/run tool" and "always/never phrase" directives. */
export function extractDirectives(text) {
  const directives = []
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim().length === 0) continue
    if (raw.trim().startsWith('|')) continue
    const line = normalizeLine(raw).toLowerCase()
    if (line.length === 0) continue
    const lineNumber = index + 1
    const push = (kind, value, topic) => directives.push({ kind, value, topic, line: lineNumber, snippet: raw.trim().slice(0, 160) })

    const preferOver = /(?:prefer|use)\s+([a-z0-9@._/-]+)\s+(?:over|instead of)\s+([a-z0-9@._/-]+)\s*$/u.exec(line)
    if (preferOver !== null) {
      push('positive', cleanToken(preferOver[1]), 'tool')
      push('negative', cleanToken(preferOver[2]), 'tool')
      continue
    }
    const negativeTool = /(?:do not|don't|never|avoid|must not)\s+(?:use|run|install|prefer|add|edit|commit)\s+([a-z0-9@._/-]+)/u.exec(line)
    const negPhrase = /(?:never|must not|do not|don't)\s+(.{3,80})/u.exec(line)
    if (negativeTool !== null) {
      const token = cleanToken(negativeTool[1])
      if (token.length > 0) push('negative', token, 'tool')
    }
    if (negPhrase !== null) push('negative', normalizeLine(negPhrase[1]).toLowerCase(), 'phrase')
    // A negated line ("do not use X") also contains the positive-looking
    // "use X" substring; without this guard the same line would vote both ways.
    const negated = negativeTool !== null || negPhrase !== null
    if (!negated) {
      const positiveTool = /(?:use|prefer|run|install(?: with)?|manage with|switch to)\s+([a-z0-9@._/-]+)/u.exec(line)
      if (positiveTool !== null) {
        const token = cleanToken(positiveTool[1])
        if (token.length > 0) push('positive', token, 'tool')
      }
      const posPhrase = /(?:always|must always)\s+(.{3,80})/u.exec(line)
      if (posPhrase !== null) push('positive', normalizeLine(posPhrase[1]).toLowerCase(), 'phrase')
    }
  }
  return directives
}

/** Trim punctuation and reject meaningless tokens. */
function cleanToken(value) {
  const token = String(value ?? '').toLowerCase().replace(/[.,;:)\]!?]+$/u, '')
  return token.length >= 2 && !STOP_TOKENS.has(token) ? token : ''
}

/** Normalize a directive phrase for overlap comparison. */
function normalizePhrase(value) {
  return normalizeLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 0 && !STOP_TOKENS.has(word))
    .join(' ')
}

/**
 * Rule: contradictory directives. Heuristic, deliberately conservative:
 *  1. the same tool appears in a positive and a negative directive;
 *  2. two different tools from one known family are both mandated;
 *  3. an "always X" phrase and a "never X" phrase normalize to the same target.
 * The message names the rule and both lines so the user can judge the intent.
 */
export function auditConflictingRules(file) {
  const findings = []
  const directives = extractDirectives(file?.text)
  if (directives.length < 2) return findings
  const positive = directives.filter((directive) => directive.kind === 'positive')
  const negative = directives.filter((directive) => directive.kind === 'negative')
  const reported = new Set()

  for (const good of positive) {
    if (good.topic !== 'tool') continue
    const bad = negative.find((directive) => directive.topic === 'tool' && directive.value === good.value)
    if (bad === undefined) continue
    const key = 'tool:' + good.value + ':' + bad.line
    if (reported.has(key)) continue
    reported.add(key)
    findings.push({
      severity: 'error',
      rule: 'conflicting-rule',
      file: file.display,
      line: bad.line,
      snippet: bad.snippet,
      message: 'Contradictory rule: line ' + good.line + ' says to use "' + good.value + '" while line ' + bad.line + ' says not to. Pick one and delete the other.',
    })
  }

  for (const family of TOOL_FAMILIES) {
    const positives = positive.filter((directive) => directive.topic === 'tool' && family.includes(directive.value))
    const unique = []
    for (const directive of positives) if (!unique.some((item) => item.value === directive.value)) unique.push(directive)
    if (unique.length < 2) continue
    const later = unique[1]
    const key = 'family:' + family.join(',') + ':' + later.line
    if (reported.has(key)) continue
    reported.add(key)
    findings.push({
      severity: 'warning',
      rule: 'conflicting-rule',
      file: file.display,
      line: later.line,
      snippet: later.snippet,
      message: 'Conflicting rule candidates: lines ' + unique.map((directive) => directive.line).join(', ') + ' mandate ' +
        unique.map((directive) => '"' + directive.value + '"').join(' and ') + ' for the same job. Keep the canonical one.',
    })
  }

  for (const good of positive) {
    if (good.topic !== 'phrase') continue
    const target = normalizePhrase(good.value)
    if (target.length === 0) continue
    const bad = negative.find((directive) => {
      if (directive.topic !== 'phrase') return false
      const other = normalizePhrase(directive.value)
      if (other.length === 0) return false
      return other === target || other.includes(target) || target.includes(other)
    })
    if (bad === undefined) continue
    const key = 'phrase:' + target + ':' + bad.line
    if (reported.has(key)) continue
    reported.add(key)
    findings.push({
      severity: 'warning',
      rule: 'conflicting-rule',
      file: file.display,
      line: bad.line,
      snippet: bad.snippet,
      message: 'Contradictory always/never rule: line ' + good.line + ' and line ' + bad.line + ' describe the same action with opposite polarity.',
    })
  }
  return findings
}

/** Rule: an always-on memory file that grew past a readable size belongs in a skill. */
export function auditOversized(file) {
  const text = String(file?.text ?? '')
  const lines = text.length === 0 ? 0 : text.replace(/\r\n/gu, '\n').split('\n').length
  const bytes = Number.isFinite(Number(file?.size)) ? Number(file.size) : text.length
  const tooManyLines = lines > OVERSIZE_LIMITS.maxLines
  const tooManyBytes = bytes > OVERSIZE_LIMITS.maxBytes
  if (!tooManyLines && !tooManyBytes) return []
  const reasons = []
  if (tooManyLines) reasons.push(lines + ' lines (limit ' + OVERSIZE_LIMITS.maxLines + ')')
  if (tooManyBytes) reasons.push(bytes + ' bytes (limit ' + OVERSIZE_LIMITS.maxBytes + ')')
  return [{
    severity: 'warning',
    rule: 'oversized-file',
    file: file.display,
    line: 1,
    snippet: file.display,
    message: 'Instruction file is too large to stay always-on: ' + reasons.join(', ') + '. Move the detailed procedure into a skill and keep only the pointers and hard rules here.',
  }]
}

/** Rule: an empty instruction file is either a mistake or dead weight. */
export function auditEmpty(file) {
  const text = String(file?.text ?? '')
  if (text.trim().length > 0) return []
  return [{
    severity: 'info',
    rule: 'empty-file',
    file: file.display,
    line: 1,
    snippet: '',
    message: 'Instruction file is empty. Delete it or write the rules it is supposed to carry.',
  }]
}

/** Rule: stale TODO/FIXME markers left in always-on memory. */
export function auditTodoMarkers(file) {
  const lines = String(file?.text ?? '').replace(/\r\n/gu, '\n').split('\n')
  const hits = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/\b(?:TODO|FIXME|XXX|TBD)\b/u.test(lines[index])) hits.push({ line: index + 1, text: lines[index].trim() })
  }
  if (hits.length === 0) return []
  return [{
    severity: 'info',
    rule: 'todo-marker',
    file: file.display,
    line: hits[0].line,
    snippet: hits[0].text.slice(0, 160),
    message: hits.length + ' TODO/FIXME marker(s) in always-on memory; resolve them or move the pending work into the task list.',
  }]
}

/**
 * Extract @import / @path references and relative markdown links.
 * External URLs, anchors and absolute host paths are ignored: they are not
 * project-relative memory imports.
 */
export function extractReferences(text) {
  const references = []
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const add = (target) => {
      const cleaned = String(target ?? '').trim().replace(/^<|>$/gu, '')
      if (cleaned.length === 0) return
      if (!references.some((item) => item.target === cleaned && item.line === index + 1)) {
        references.push({ target: cleaned, line: index + 1, snippet: line.trim().slice(0, 160) })
      }
    }
    const importLine = /^\s*@import\s+(.+)$/u.exec(line)
    if (importLine !== null) {
      add(importLine[1].replace(/^["']|["']$/gu, '').split(/\s+/u)[0])
    }
    const atMatch = /(?:^|\s)@([^\s"'\u0060<>]+)/gu
    let match
    while ((match = atMatch.exec(line)) !== null) {
      const target = match[1]
      if (target.includes('@')) continue
      if (!/[/.]/u.test(target)) continue
      if (target.startsWith('~/') || target.startsWith('~\\')) continue
      add(target)
    }
    const linkMatch = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu
    while ((match = linkMatch.exec(line)) !== null) {
      const target = match[1]
      if (/^(?:https?:|mailto:|data:|#)/iu.test(target)) continue
      add(target.split('#')[0])
    }
  }
  return references
}

/**
 * Resolve one reference against the file that owns it.
 * @returns the absolute candidate path, or undefined when it must be ignored.
 */
export function referenceCandidate(file, target) {
  if (typeof target !== 'string' || target.length === 0) return undefined
  if (/^(?:[A-Za-z]:[\\/]|\/|\\)/u.test(target)) return undefined
  if (target.startsWith('~/') || target.startsWith('~\\')) return undefined
  if (target.includes('<') || target.includes('{{')) return undefined
  const baseDir = parentPath(file.absolutePath) ?? parentPath(file.display) ?? ''
  return joinPath(baseDir, target)
}

/**
 * Rule: dead @import / relative markdown link.
 * @param checkReference - (absolutePath) => 'file'|'missing'|'unknown'. Unknown
 *   means the caller cannot check (sandbox/permission) and produces no finding.
 */
export function auditReferences(file, checkReference) {
  if (typeof checkReference !== 'function') return []
  const findings = []
  for (const reference of extractReferences(file?.text)) {
    const candidate = referenceCandidate(file, reference.target)
    if (candidate === undefined) continue
    let state
    try { state = checkReference(candidate) } catch { state = 'unknown' }
    if (state !== 'missing') continue
    findings.push({
      severity: 'warning',
      rule: 'broken-reference',
      file: file.display,
      line: reference.line,
      snippet: reference.snippet,
      message: 'Broken reference "' + reference.target + '" (resolved to ' + candidate + '); fix or remove the import/link.',
    })
  }
  return findings
}

/** Sort findings by severity, then file, then line. */
export function sortFindings(findings) {
  const rank = { error: 0, warning: 1, info: 2 }
  return findings.slice().sort((left, right) => {
    const bySeverity = (rank[left.severity] ?? 9) - (rank[right.severity] ?? 9)
    if (bySeverity !== 0) return bySeverity
    if (left.file !== right.file) return left.file < right.file ? -1 : 1
    return left.line - right.line
  })
}

/** Audit one loaded instruction file. */
export function auditMemoryFile(file, options = {}) {
  const findings = []
  findings.push(...auditDuplicateHeadings(file))
  findings.push(...auditConflictingRules(file))
  findings.push(...auditOversized(file))
  findings.push(...auditEmpty(file))
  findings.push(...auditTodoMarkers(file))
  findings.push(...auditReferences(file, options.checkReference))
  return findings
}

/** Audit every loaded instruction file and summarize the result. */
export function auditMemoryFiles(files, options = {}) {
  const list = Array.isArray(files) ? files.filter((file) => file !== null && typeof file === 'object') : []
  const findings = sortFindings(list.flatMap((file) => auditMemoryFile(file, options)))
  const counts = { error: 0, warning: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1
  return { findings, counts, fileCount: list.length, total: findings.length }
}

/** Format a finding as one report line. */
export function formatFinding(finding) {
  const location = finding.file + (finding.line > 0 ? ':' + finding.line : '')
  return '[' + finding.severity + '] ' + finding.rule + '  ' + location + '  ' + finding.message
}

/**
 * Render the memory_audit report.
 * @param input.files - [{display}]
 * @param input.audit - result of auditMemoryFiles.
 * @param input.skipped - [{display, reason}]
 * @param input.proposals - [{text, reason, createdAt}]
 * @param input.projectRoot - project root display (absolute).
 * @param input.maxFindings - cap on rendered findings (default 80).
 */
export function renderAuditReport(input) {
  const files = Array.isArray(input?.files) ? input.files : []
  const audit = input?.audit ?? { findings: [], counts: { error: 0, warning: 0, info: 0 }, total: 0 }
  const skipped = Array.isArray(input?.skipped) ? input.skipped : []
  const proposals = Array.isArray(input?.proposals) ? input.proposals : []
  const maxFindings = Math.max(1, Math.min(200, Math.floor(Number(input?.maxFindings ?? 80) || 80)))
  const lines = []
  lines.push('Memory audit (workflow-boost, read-only): ' + files.length + ' instruction file(s), ' + audit.total +
    ' finding(s) — ' + audit.counts.error + ' error, ' + audit.counts.warning + ' warning, ' + audit.counts.info + ' info.')
  if (typeof input?.projectRoot === 'string' && input.projectRoot.length > 0) lines.push('Project root: ' + input.projectRoot)
  lines.push('Files scanned: ' + (files.length === 0 ? '(none found)' : files.map((file) => file.display).join(', ')))
  if (skipped.length > 0) {
    lines.push('Skipped: ' + skipped.map((entry) => entry.display + ' (' + entry.reason + ')').join(', '))
  }
  if (audit.findings.length === 0) {
    lines.push('No issues found in the audited instruction files.')
  } else {
    const shown = audit.findings.slice(0, maxFindings)
    for (const finding of shown) lines.push(formatFinding(finding))
    if (audit.findings.length > shown.length) lines.push('... ' + (audit.findings.length - shown.length) + ' more finding(s) not shown.')
  }
  if (proposals.length === 0) {
    lines.push('Pending memory proposals: 0.')
  } else {
    lines.push('Pending memory proposals: ' + proposals.length + '. Most recent:')
    for (const proposal of proposals.slice(0, 3)) {
      const text = String(proposal?.text ?? '').replace(/\s+/gu, ' ').slice(0, 120)
      lines.push('  - ' + text + (proposal?.reason ? ' (reason: ' + String(proposal.reason).slice(0, 80) + ')' : ''))
    }
    lines.push('Proposals are recorded only; AGENTS.md/CLAUDE.md are never edited automatically. Confirm with the user, then edit the file yourself.')
  }
  lines.push('This tool never modifies instruction files. Fix findings by editing the file with the user.')
  return lines.join('\n')
}

/** Normalize proposal text for equality checks: whitespace-insensitive, trimmed. */
export function normalizeProposalText(text) {
  return String(text ?? '').replace(/\r\n/gu, '\n').replace(/\s+/gu, ' ').trim()
}

/** Dedupe identity: case-insensitive so "Use pnpm" and "use pnpm" are one rule. */
function proposalCompareKey(text) {
  return normalizeProposalText(text).toLowerCase()
}

/** FNV-1a hash for a short stable proposal id (dedupe identity is the text). */
function shortHash(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Parse the JSONL proposal file; corrupt lines are ignored, never fatal. */
export function parseProposalJsonl(text) {
  const entries = []
  for (const line of String(text ?? '').replace(/\r\n/gu, '\n').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string' && normalizeProposalText(parsed.text).length > 0) {
        entries.push({
          id: typeof parsed.id === 'string' ? parsed.id : shortHash(proposalCompareKey(parsed.text)),
          text: String(parsed.text),
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
          sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
          status: typeof parsed.status === 'string' ? parsed.status : 'pending',
        })
      }
    } catch { /* skip corrupt line */ }
  }
  return entries
}

/** Serialize entries as JSONL with a trailing newline (empty list writes ''). */
export function serializeProposalEntries(entries) {
  const list = Array.isArray(entries) ? entries : []
  return list.map((entry) => JSON.stringify(entry)).join('\n') + (list.length > 0 ? '\n' : '')
}

/**
 * Decide what one memory_propose call does: dedupe by normalized text, append,
 * then keep only the newest maxProposals entries (oldest dropped first).
 * @returns {status:'added'|'duplicate'|'invalid', entries, added?, removed}
 */
export function planProposalAppend(input) {
  const existing = Array.isArray(input?.entries) ? input.entries.slice() : []
  const normalized = normalizeProposalText(input?.text)
  if (normalized.length === 0) return { status: 'invalid', entries: existing, removed: 0 }
  const limit = Math.max(1, Math.floor(Number(input?.maxProposals) || MEMORY_DEFAULTS.maxProposals))
  const key = normalized.toLowerCase()
  const duplicate = existing.find((entry) => proposalCompareKey(entry?.text) === key)
  if (duplicate !== undefined) return { status: 'duplicate', entries: existing, entry: duplicate, removed: 0 }
  const text = String(input?.text ?? '').trim().slice(0, MAX_PROPOSAL_CHARS)
  const entry = {
    id: shortHash(key),
    text,
    reason: typeof input?.reason === 'string' ? input.reason.slice(0, 300) : '',
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    sessionId: typeof input?.sessionId === 'string' ? input.sessionId : '',
    status: 'pending',
  }
  const combined = [...existing, entry]
  const removed = Math.max(0, combined.length - limit)
  return { status: 'added', entries: combined.slice(removed), entry, removed }
}

/** Render the memory_propose tool result. */
export function renderProposalResult(input) {
  const status = input?.status
  const total = Array.isArray(input?.entries) ? input.entries.length : Number(input?.total ?? 0)
  if (status === 'duplicate') {
    return 'memory_propose: an identical proposal is already pending (' + total + ' total). Nothing was written. It will be reviewed on the next memory_audit; this tool never edits AGENTS.md/CLAUDE.md.'
  }
  if (status === 'invalid') return 'memory_propose: text must be a non-empty rule or convention; nothing was written.'
  const removed = Number(input?.removed) || 0
  return 'memory_propose: recorded a new pending proposal (' + total + ' total' + (removed > 0 ? ', ' + removed + ' oldest dropped' : '') +
    '). It is stored under .dsh/workflow-boost/memory-proposals.jsonl and does NOT change AGENTS.md/CLAUDE.md; confirm with the user and edit the instruction file yourself.'
}

/** The one-time pending-proposal notice injected through additionalContexts. */
export function renderPendingNotice(count) {
  const total = Math.max(0, Math.floor(Number(count) || 0))
  if (total === 0) return ''
  return '[workflow-boost memoryLint — automatically injected; not a new user request.] ' + total +
    ' pending memory proposal(s); run memory_audit to review them. Proposals never edit AGENTS.md/CLAUDE.md by themselves.'
}
