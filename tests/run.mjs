import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const run = (file) =>
  spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' }).status ?? 1

run('build-roomcode.mjs')
const failures = [
  'compose.test.mjs',
  'roomCode.test.mjs',
  'socket.test.mjs',
  'persistence.test.mjs',
  'activity.test.mjs',
  'migrate.test.mjs',
  'joinRate.test.mjs',
  'clientKey.test.mjs',
  'roomCreate.test.mjs',
  'ipRate.test.mjs',
  'guard.test.mjs',
  'retry.test.mjs',
  'sweeper.test.mjs',
  'reconnect.test.mjs',
]
  .map(run)
  .filter(Boolean).length

if (failures > 0) {
  console.error(`\n${failures} test file(s) failed`)
  process.exit(1)
}
console.log('\nAll test files passed')
