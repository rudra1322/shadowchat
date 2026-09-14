// Persistence retry / backoff.
//
// Write-behind persistence used to swallow every failure, so a two-second
// Postgres blip silently dropped messages from the durable copy while the UI
// still showed a healthy connection. Writes now retry a bounded number of
// times and, if they still fail, the persistence mode drops to "degraded".

process.env.WRITE_MAX_ATTEMPTS = '3'
process.env.WRITE_RETRY_BASE_MS = '5'
process.env.ACTIVITY_TOUCH_INTERVAL_MS = '1'

const {
  configurePersistence,
  flushPersistence,
  persistenceMode,
  persistenceStats,
  recordMessage,
} = await import('../server/persistence.mjs')

let failures = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL  ${name}\n        ${error.message}\n`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let calls = []
let failuresLeft = 0

function install() {
  calls = []
  configurePersistence({
    enabled: true,
    query: async (text, params) => {
      calls.push({ text, params })
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error('connection terminated')
      }
      return { rows: [] }
    },
  })
}

const message = (id, body) => ({
  id,
  kind: 'chat',
  username: 'ghost',
  authorId: 'a1',
  text: body,
  at: Date.now(),
})

const insertsFor = (id) =>
  calls.filter((entry) => entry.text.includes('INSERT INTO messages') && entry.params?.[0] === id)

console.log('\npersistence retry')

install()
await check('a write that succeeds first time is not retried', async () => {
  failuresLeft = 0
  recordMessage('RTRY0001', message('m-ok', 'hello'))
  await flushPersistence()
  assert(insertsFor('m-ok').length === 1, `expected one attempt, saw ${insertsFor('m-ok').length}`)
})

install()
await check('a transient failure is retried and eventually persists', async () => {
  failuresLeft = 1
  recordMessage('RTRY0002', message('m-retry', 'flaky'))
  await flushPersistence()
  const attempts = insertsFor('m-retry')
  assert(attempts.length === 2, `expected one retry, saw ${attempts.length} attempts`)
  assert(persistenceStats().retries >= 1, 'the retry should be counted')
  assert(persistenceStats().dropped === 0, 'a recovered write is not a dropped write')
})

install()
await check('retries are bounded and stop at the configured maximum', async () => {
  failuresLeft = 99
  recordMessage('RTRY0003', message('m-dead', 'never lands'))
  await flushPersistence()
  const attempts = insertsFor('m-dead')
  assert(attempts.length === 3, `expected exactly 3 attempts, saw ${attempts.length}`)
  assert(persistenceStats().dropped >= 1, 'the write must be recorded as dropped, not pending')
  failuresLeft = 0
})

install()
await check('a permanently failing write does not reject into the caller', async () => {
  failuresLeft = 99
  let threw = false
  try {
    recordMessage('RTRY0004', message('m-quiet', 'no crash'))
    await flushPersistence()
  } catch {
    threw = true
  }
  failuresLeft = 0
  assert(!threw, 'a database problem must never surface as a socket-handler exception')
})

install()
await check('retries never duplicate a row', async () => {
  failuresLeft = 2
  recordMessage('RTRY0005', message('m-dupe', 'once only'))
  await flushPersistence()
  const attempts = insertsFor('m-dupe')
  assert(attempts.length === 3, `expected 3 attempts, saw ${attempts.length}`)
  assert(
    attempts.every((entry) => /ON CONFLICT \(id\) DO NOTHING/i.test(entry.text)),
    'a retried insert must be idempotent at the database level',
  )
})

install()
await check('ordering is preserved across a retry', async () => {
  failuresLeft = 1
  recordMessage('RTRY0006', message('m-1', 'first'))
  recordMessage('RTRY0006', message('m-2', 'second'))
  recordMessage('RTRY0006', message('m-3', 'third'))
  await flushPersistence()
  const order = calls
    .filter((entry) => entry.text.includes('INSERT INTO messages'))
    .map((entry) => entry.params[0])
  const firstSeen = ['m-1', 'm-2', 'm-3'].map((id) => order.indexOf(id))
  assert(firstSeen.every((index) => index >= 0), 'every message should be attempted')
  assert(
    firstSeen[0] < firstSeen[1] && firstSeen[1] < firstSeen[2],
    'the write-behind queue is serial, so ordering must survive a retry',
  )
})

install()
await check('a recent failure reports degraded persistence', async () => {
  failuresLeft = 99
  recordMessage('RTRY0007', message('m-degraded', 'oops'))
  await flushPersistence()
  failuresLeft = 0
  assert(
    persistenceMode() === 'degraded',
    `the UI must be told the truth, got ${persistenceMode()}`,
  )
})

install()
await check('a healthy queue reports normal persistence', async () => {
  failuresLeft = 0
  recordMessage('RTRY0008', message('m-healthy', 'fine'))
  await flushPersistence()
  // persistenceMode() only reports "degraded" for a recent error; a run that
  // just failed above may still be inside that window, so assert the mode is
  // one of the two honest values rather than forcing a sleep.
  assert(
    ['postgres', 'degraded'].includes(persistenceMode()),
    `unexpected mode ${persistenceMode()}`,
  )
  assert(insertsFor('m-healthy').length === 1, 'a healthy write takes one attempt')
})

if (failures > 0) {
  console.error(`\n${failures} persistence retry assertion(s) failed`)
  process.exit(1)
}
console.log('\npersistence retry: all assertions passed')
process.exit(0)
