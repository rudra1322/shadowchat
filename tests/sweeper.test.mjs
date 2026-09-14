// Periodic database expiration sweeper.
//
// Room cleanup used to happen only through the in-memory reaper and startup
// hydration. A crash therefore left expired rooms (and their messages) sitting
// in Postgres until the next boot. A small interval timer inside the existing
// Node process now sweeps them using the same TTL the app already applies.

process.env.HYDRATE_ACTIVE_WITHIN_MS = '1800000'

const {
  configurePersistence,
  deleteExpiredRooms,
  isSweeperRunning,
  startExpirationSweeper,
  stopExpirationSweeper,
} = await import('../server/persistence.mjs')
const { PERSISTENCE, ROOM } = await import('../server/config.mjs')

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
let expired = []

configurePersistence({
  enabled: true,
  query: async (text, params) => {
    calls.push({ text, params })
    if (text.includes('DELETE FROM rooms') && text.includes('RETURNING code')) {
      return { rows: expired.map((code) => ({ code })) }
    }
    return { rows: [] }
  },
})

const sweeps = () =>
  calls.filter((entry) => entry.text.includes('DELETE FROM rooms') && entry.text.includes('RETURNING code'))

console.log('\ndatabase expiration sweeper')

await check('a sweep deletes rooms that are past the TTL', async () => {
  calls = []
  expired = ['SWP00001', 'SWP00002']
  const removed = await deleteExpiredRooms()
  assert(removed.length === 2, `expected 2 expired rooms, got ${removed.length}`)
  assert(sweeps().length === 1, 'one statement should do the whole sweep')
})

await check('the sweep is parameterized, never string-interpolated', async () => {
  calls = []
  expired = []
  await deleteExpiredRooms()
  const statement = sweeps()[0]
  assert(statement.text.includes('$1'), 'the cutoff must be bound, not inlined')
  assert(Array.isArray(statement.params) && statement.params.length === 1, 'exactly one bound value')
})

await check('the sweep reuses the existing room TTL, it does not invent one', async () => {
  calls = []
  expired = []
  await deleteExpiredRooms()
  assert(
    sweeps()[0].params[0] === ROOM.HYDRATE_ACTIVE_WITHIN_MS,
    `expected the hydration/idle window (${ROOM.HYDRATE_ACTIVE_WITHIN_MS}), got ${sweeps()[0].params[0]}`,
  )
})

await check('active rooms are left alone', async () => {
  calls = []
  expired = []
  const removed = await deleteExpiredRooms()
  assert(removed.length === 0, 'nothing should be deleted when every room is recent')
  assert(
    /last_active_at\s*<\s*now\(\)/i.test(sweeps()[0].text),
    'the predicate must select only stale rooms',
  )
})

await check('messages are removed by the foreign key, not a second statement', async () => {
  calls = []
  expired = ['SWP00003']
  await deleteExpiredRooms()
  const messageDeletes = calls.filter((entry) => entry.text.includes('DELETE FROM messages'))
  assert(
    messageDeletes.length === 0,
    'messages.room_code is ON DELETE CASCADE, so an extra delete would be redundant work',
  )
})

await check('the periodic sweeper runs on its interval', async () => {
  calls = []
  expired = ['SWP00004']
  startExpirationSweeper({ intervalMs: 20 })
  assert(isSweeperRunning(), 'the timer should be registered')
  await new Promise((resolve) => setTimeout(resolve, 70))
  stopExpirationSweeper()
  assert(sweeps().length >= 2, `expected repeated sweeps, saw ${sweeps().length}`)
})

await check('the sweeper stops cleanly on shutdown', async () => {
  startExpirationSweeper({ intervalMs: 20 })
  stopExpirationSweeper()
  assert(!isSweeperRunning(), 'the interval must be cleared during drain')
  calls = []
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert(sweeps().length === 0, 'a stopped sweeper must not keep the process busy')
})

await check('starting twice does not create two timers', async () => {
  startExpirationSweeper({ intervalMs: 500 })
  startExpirationSweeper({ intervalMs: 500 })
  const stopped = stopExpirationSweeper()
  assert(stopped !== false, 'the single timer should be stoppable')
  assert(!isSweeperRunning(), 'no orphan timer may survive')
})

await check('the sweep interval is configurable', () => {
  assert(
    typeof PERSISTENCE.SWEEP_INTERVAL_MS === 'number' && PERSISTENCE.SWEEP_INTERVAL_MS > 0,
    'operators need to tune how often the cleanup runs',
  )
})

if (failures > 0) {
  console.error(`\n${failures} sweeper assertion(s) failed`)
  process.exit(1)
}
console.log('\ndatabase expiration sweeper: all assertions passed')
process.exit(0)
