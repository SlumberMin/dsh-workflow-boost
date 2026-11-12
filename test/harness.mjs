/** Tiny dependency-free test harness shared by every case file. */
const tests = []
const state = { failures: [], passed: 0 }

export function test(name, fn) {
  tests.push({ name, fn })
}

export function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed')
}

export function assertEqual(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error((message ?? 'not equal') + ': expected ' + right + ', got ' + left)
}

/** Run every registered test sequentially (async-safe). */
export async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn()
      state.passed += 1
    } catch (error) {
      state.failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return state
}

export function summary() {
  for (const failure of state.failures) console.error('FAIL ' + failure)
  console.log('unit: ' + state.passed + '/' + (state.passed + state.failures.length) + ' passed')
  return state.failures.length === 0 ? 0 : 1
}
