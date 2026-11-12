/** node --check every source file; run from the package root. */
import { readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry === '.git') continue
    if (statSync(full).isDirectory()) walk(full)
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(full)
  }
}
walk(root)
let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed += 1
    console.error('check failed: ' + file)
    console.error(String(error.stderr ?? error.message).slice(0, 400))
  }
}
console.log('checked ' + files.length + ' files, ' + failed + ' failed')
process.exitCode = failed === 0 ? 0 : 1
