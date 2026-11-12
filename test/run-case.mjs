/** Run one case file in isolation: node test/run-case.mjs test/cases/<name>.mjs */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { run, summary } from './harness.mjs'

const target = process.argv[2]
if (!target) {
  console.error('usage: node test/run-case.mjs test/cases/<name>.mjs')
  process.exit(2)
}
await import(pathToFileURL(resolve(process.cwd(), target)).href)
await run()
process.exitCode = summary()
