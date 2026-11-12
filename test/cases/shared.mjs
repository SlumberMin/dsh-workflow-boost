import { test, assert, assertEqual } from '../harness.mjs'
import {
  estimateTokens, truncateToTokenBudget, shortenMiddle, stableStringify, shortHash,
  fnv1a, shortDigest, clampNumber, roundInt, globMatches, matchesAny, formatBytes, firstLine,
} from '../../lib/shared.js'

test('estimateTokens counts CJK denser than ASCII', () => {
  const ascii = estimateTokens('a'.repeat(400))
  const cjk = estimateTokens('中'.repeat(400))
  assert(ascii > 0 && cjk > ascii, 'CJK must estimate more tokens for the same character count')
})

test('estimateTokens handles empty input', () => {
  assertEqual(estimateTokens(''), 0)
  assertEqual(estimateTokens(undefined), 0)
})

test('truncateToTokenBudget respects the budget', () => {
  const text = 'word '.repeat(2000)
  const clipped = truncateToTokenBudget(text, 100)
  assert(clipped.length < text.length, 'must clip')
  assert(estimateTokens(clipped) <= 100, 'must stay inside the budget')
})

test('shortenMiddle keeps head and tail', () => {
  const text = 'H'.repeat(300) + 'M'.repeat(500) + 'T'.repeat(300)
  const out = shortenMiddle(text, 240, 160)
  assert(out.startsWith('H'), 'head kept')
  assert(out.endsWith('T'), 'tail kept')
  assert(out.includes('truncated'), 'middle marker present')
})

test('stableStringify sorts keys recursively', () => {
  assertEqual(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
})

test('shortHash and shortDigest are deterministic', () => {
  assertEqual(shortHash('hello'), shortHash('hello'))
  assert(shortHash('hello') !== shortHash('world'))
  assertEqual(fnv1a('x'), fnv1a('x'))
  assertEqual(shortDigest('x').length, 8)
})

test('clampNumber and roundInt sanitize values', () => {
  assertEqual(clampNumber('5', 1, 0, 10), 5)
  assertEqual(clampNumber('nope', 3, 0, 10), 3)
  assertEqual(clampNumber(50, 3, 0, 10), 10)
  assertEqual(roundInt(-1, 7), 7)
  assertEqual(roundInt(3.9), 3)
})

test('globMatches supports **, * and ?', () => {
  assert(globMatches('**/*.ts', 'src/lib/a.ts'), 'nested ts')
  assert(globMatches('*.md', 'README.md'), 'root md')
  assert(!globMatches('*.md', 'docs/a.md'), 'star must not cross a slash')
  assert(globMatches('src/**/*.ts', 'src/a/b/c.ts'), 'deep nested')
  assert(globMatches('a?c.js', 'abc.js'), 'single character')
  assert(!globMatches('a?c.js', 'abbc.js'), 'question mark is one character')
  assert(matchesAny(['**/*.js', '**/*.ts'], 'x/y.ts'))
  assert(!matchesAny([], 'x/y.ts'))
})

test('formatBytes and firstLine render compactly', () => {
  assertEqual(formatBytes(0), '0 B')
  assertEqual(formatBytes(1536), '1.5 KB')
  assertEqual(firstLine('\n\nhello world\nsecond'), 'hello world')
  assert(firstLine('x'.repeat(200), 200).length <= 200)
})
