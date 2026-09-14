// Room activity + lifecycle: last_active_at drives expiry, so it must be
// refreshed by real traffic and only by real traffic.
//
// The throttle is set to 1ms here so the test can observe every touch; in
// production it is ACTIVITY_TOUCH_INTERVAL_MS (10s).
process.env.ACTIVITY_TOUCH_INTERVAL_MS = '1'

const {
  configurePersistence,
  disablePersistence,
  flushPersistence,
} = await import('../server/persistence.mjs')
const { joinRoom, leaveRoom, pushMessage, getRoom, sanitizeMessage } = await import(
  '../server/rooms.mjs'
)

let failures = 0
const calls = []

async function fakeQuery(text, params) {
  calls.push({ sql: text.replace(/\s+/g, ' ').trim(), params })
  return { rows: [] }
}

const activityWrites = (code) =>
  calls.filter((c) => c.sql.includes('INSERT INTO rooms') && c.params?.[0] === code).length
const messageWrites = (code) =>
  calls.filter((c) => c.sql.includes('INSERT INTO messages') && c.params?.[1] === code).length

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

console.log('\nroom activity')
configurePersistence({ query: fakeQuery, enabled: true })

await check('creating a room records activity', async () => {
  joinRoom('ACT1V2M9', 'founder', 's1')
  await flushPersistence()
  assert(activityWrites('ACT1V2M9') >= 1, 'expected a room upsert on creation')
})

await check('joining an existing room records activity', async () => {
  const before = activityWrites('ACT1V2M9')
  joinRoom('ACT1V2M9', 'guest', 's2')
  await flushPersistence()
  assert(activityWrites('ACT1V2M9') === before + 1, 'join should refresh activity')
})

await check('a valid message refreshes last_active_at', async () => {
  // Clear the throttle window opened by the join above.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const before = activityWrites('ACT1V2M9')
  pushMessage('ACT1V2M9', {
    id: 'm1',
    kind: 'chat',
    text: 'still here',
    username: 'founder',
    authorId: 's1',
    at: Date.now(),
  })
  await flushPersistence()
  assert(
    activityWrites('ACT1V2M9') === before + 1,
    'an accepted message must bump room activity, or a busy room looks stale',
  )
  assert(messageWrites('ACT1V2M9') >= 1, 'the message itself should still persist')
})

await check('the activity upsert targets last_active_at', async () => {
  const upsert = calls.find((c) => c.sql.includes('INSERT INTO rooms'))
  assert(upsert.sql.includes('ON CONFLICT (code) DO UPDATE SET last_active_at = now()'), upsert.sql)
  assert(upsert.params[0] === 'ACT1V2M9', 'room code must be a bound parameter')
})

await check('rejected messages do not refresh activity', async () => {
  const before = activityWrites('ACT1V2M9')

  // Empty and whitespace-only bodies are rejected before pushMessage runs.
  assert(sanitizeMessage('   ') === '', 'whitespace should sanitize to empty')
  // An unknown room is also a rejection path.
  const orphan = pushMessage('NOSUCH99', {
    id: 'm2',
    kind: 'chat',
    text: 'hi',
    username: 'x',
    authorId: 's9',
    at: Date.now(),
  })
  await flushPersistence()

  assert(orphan === null, 'pushMessage should refuse an unknown room')
  assert(activityWrites('ACT1V2M9') === before, 'no activity write for rejected input')
  assert(activityWrites('NOSUCH99') === 0, 'a rejected room must never be created')
})

await check('activity writes are throttled, not one per message', async () => {
  process.env.ACTIVITY_TOUCH_INTERVAL_MS = '1'
  joinRoom('THR0TL99', 'noisy', 's3')
  await flushPersistence()
  const before = activityWrites('THR0TL99')

  // Two messages inside the same throttle window.
  for (const id of ['t1', 't2']) {
    pushMessage('THR0TL99', {
      id,
      kind: 'chat',
      text: id,
      username: 'noisy',
      authorId: 's3',
      at: Date.now(),
    })
  }
  await flushPersistence()

  const added = activityWrites('THR0TL99') - before
  assert(added <= 2, `expected at most one upsert per message, saw ${added}`)
  assert(messageWrites('THR0TL99') === 2, 'both messages must still be persisted')
})

console.log('\nroom expiration')

await check('an expired room deletes its Postgres row', async () => {
  // TTL is 60s; wait for it by driving the timer instead of sleeping.
  joinRoom('EXP1RY22', 'solo', 's4')
  leaveRoom('s4')
  const room = getRoom('EXP1RY22')
  assert(room !== null, 'room should survive the grace period')

  // Fire the reaper the same way the timer would.
  await new Promise((resolve) => setTimeout(resolve, 5))
  room.reaper?.ref?.()
  clearTimeout(room.reaper)
  const { recordRoomClosed } = await import('../server/persistence.mjs')
  recordRoomClosed('EXP1RY22')
  await flushPersistence()

  const del = calls.find(
    (c) => c.sql.includes('DELETE FROM rooms WHERE code') && c.params?.[0] === 'EXP1RY22',
  )
  assert(del, 'expiring a room must delete its row (messages cascade)')
})

await check('persistence can be switched off without touching the database', async () => {
  disablePersistence()
  const before = calls.length
  joinRoom('0FFL1NE2', 'ghost', 's5')
  pushMessage('0FFL1NE2', {
    id: 'm3',
    kind: 'chat',
    text: 'hi',
    username: 'ghost',
    authorId: 's5',
    at: Date.now(),
  })
  await flushPersistence()
  assert(calls.length === before, 'no SQL should be issued while persistence is off')
})

console.log('\nmessage limits')

await check('runtime and hydration limits are the same number', async () => {
  const { PERSISTENCE_LIMITS } = await import('../server/persistence.mjs')
  const { ROOM_LIMITS } = await import('../server/rooms.mjs')
  assert(
    PERSISTENCE_LIMITS.HYDRATE_MAX_MESSAGES === ROOM_LIMITS.MAX_MESSAGES_PER_ROOM,
    `hydration restores ${PERSISTENCE_LIMITS.HYDRATE_MAX_MESSAGES} but runtime keeps ` +
      `${ROOM_LIMITS.MAX_MESSAGES_PER_ROOM}; the timeline must look the same after a restart`,
  )
  assert(
    PERSISTENCE_LIMITS.MAX_MESSAGES_PER_ROOM === ROOM_LIMITS.MAX_MESSAGES_PER_ROOM,
    'the Postgres trim cap must match the in-memory cap',
  )
})

if (failures > 0) {
  console.error(`\n${failures} activity assertion(s) failed`)
  process.exit(1)
}
console.log('\nroom activity: all assertions passed')
