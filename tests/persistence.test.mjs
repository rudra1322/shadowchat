// Postgres persistence tests.
//
// These run with no database and no `pg` installed: configurePersistence takes
// an injected query function, so we can assert the exact SQL and parameters
// the server would send, plus how database rows map back into messages.

import assert from 'node:assert/strict'
import {
  configurePersistence,
  disablePersistence,
  flushPersistence,
  hydrateFromDatabase,
  persistenceStats,
  recordMessage,
  recordRoomActivity,
  recordRoomClosed,
  PERSISTENCE_LIMITS,
} from '../server/persistence.mjs'
import { getRoom, hydrateRoom, joinRoom, leaveRoom, pushMessage } from '../server/rooms.mjs'

let passed = 0
let failed = 0
const calls = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + name + '\n        ' + error.message)
  }
}

/** Records every statement and returns whatever the test queued up next. */
let nextResults = []
function fakeQuery(text, params) {
  calls.push({ sql: text.replace(/\s+/g, ' ').trim(), params })
  return Promise.resolve(nextResults.shift() ?? { rows: [] })
}

function find(fragment) {
  return calls.filter((call) => call.sql.includes(fragment))
}

function reset() {
  calls.length = 0
  nextResults = []
}

configurePersistence({ query: fakeQuery })

console.log('\n=== room persistence ===')

await check('creating a room upserts the room row', async () => {
  reset()
  joinRoom('K7QF2M9X', 'sock-1', 'ghost_shell')
  await flushPersistence()
  const upserts = find('INSERT INTO rooms')
  assert.ok(upserts.length >= 1, 'expected an INSERT INTO rooms')
  assert.deepEqual(upserts[0].params, ['K7QF2M9X'])
  assert.ok(
    upserts[0].sql.includes('ON CONFLICT (code) DO UPDATE SET last_active_at = now()'),
    'upsert must bump last_active_at instead of failing',
  )
})

await check('room code is passed as a parameter, never interpolated', async () => {
  reset()
  joinRoom('ABCDEFGH', 'sock-inject', 'sqli')
  await flushPersistence()
  for (const call of calls) {
    assert.ok(!call.sql.includes('ABCDEFGH'), 'code leaked into the SQL string')
  }
})

await check('a message insert carries every column with bound params', async () => {
  reset()
  const message = {
    id: 'msg-1',
    kind: 'chat',
    text: 'ping',
    username: 'ghost_shell',
    authorId: 'sock-1',
    at: 1_700_000_000_000,
  }
  pushMessage('K7QF2M9X', message)
  await flushPersistence()

  const inserts = find('INSERT INTO messages')
  assert.equal(inserts.length, 1)
  assert.deepEqual(inserts[0].params, [
    'msg-1',
    'K7QF2M9X',
    'chat',
    'ghost_shell',
    'sock-1',
    'ping',
    1_700_000_000_000,
  ])
  assert.ok(
    inserts[0].sql.includes('ON CONFLICT (id) DO NOTHING'),
    'a replayed id must not crash the writer',
  )
})

await check('system messages persist with a null username', async () => {
  reset()
  pushMessage('K7QF2M9X', {
    id: 'msg-sys',
    kind: 'system',
    text: 'ghost_shell joined the room',
    username: null,
    at: 1_700_000_001_000,
  })
  await flushPersistence()
  const [insert] = find('INSERT INTO messages')
  assert.equal(insert.params[3], null)
  assert.equal(insert.params[4], null)
  assert.equal(insert.params[2], 'system')
})

await check('message text is never concatenated into the SQL', async () => {
  reset()
  pushMessage('K7QF2M9X', {
    id: 'msg-xss',
    kind: 'chat',
    text: "'); DROP TABLE messages; --",
    username: 'attacker',
    authorId: 'sock-1',
    at: 1_700_000_002_000,
  })
  await flushPersistence()
  const [insert] = find('INSERT INTO messages')
  assert.ok(!insert.sql.includes('DROP TABLE'))
  assert.equal(insert.params[5], "'); DROP TABLE messages; --")
})

await check('trim runs in batches, not on every insert', async () => {
  // A room of its own: the batch counter is per-room, so reusing a room that
  // earlier tests wrote to would start the count mid-batch.
  const code = 'B4TCH2M9'
  joinRoom(code, 'sock-batch', 'batcher')
  reset()

  const { TRIM_EVERY_N_MESSAGES, MAX_MESSAGES_PER_ROOM } = PERSISTENCE_LIMITS
  const push = (id) =>
    pushMessage(code, {
      id,
      kind: 'chat',
      text: 'x',
      username: 'batcher',
      authorId: 'sock-batch',
      at: Date.now(),
    })

  for (let i = 0; i < TRIM_EVERY_N_MESSAGES - 1; i += 1) push(`batch-${i}`)
  await flushPersistence()
  assert.equal(find('DELETE FROM messages').length, 0, 'trimmed too eagerly')

  push('batch-trigger')
  await flushPersistence()
  const trims = find('DELETE FROM messages')
  assert.equal(trims.length, 1, 'expected exactly one trim per batch')
  assert.deepEqual(trims[0].params, [code, MAX_MESSAGES_PER_ROOM])
  leaveRoom(code, 'sock-batch')
})

await check('closing a room deletes the row (messages cascade)', async () => {
  reset()
  recordRoomClosed('K7QF2M9X')
  await flushPersistence()
  const deletes = find('DELETE FROM rooms WHERE code = $1')
  assert.equal(deletes.length, 1)
  assert.deepEqual(deletes[0].params, ['K7QF2M9X'])
})

await check('a failing database does not break the room', async () => {
  reset()
  const before = persistenceStats().errors
  configurePersistence({
    query: () => Promise.reject(new Error('connection terminated')),
  })

  joinRoom('S0N2V5H8', 'sock-fail', 'resilient')
  const message = {
    id: 'msg-fail',
    kind: 'chat',
    text: 'still delivered',
    username: 'resilient',
    authorId: 'sock-fail',
    at: Date.now(),
  }
  assert.equal(pushMessage('S0N2V5H8', message)?.id, 'msg-fail', 'push must still succeed')
  await flushPersistence()

  assert.ok(persistenceStats().errors > before, 'the error should be counted')
  assert.equal(getRoom('S0N2V5H8').messages.at(-1).text, 'still delivered')
  leaveRoom('S0N2V5H8', 'sock-fail')
  configurePersistence({ query: fakeQuery })
})

console.log('\n=== hydration on boot ===')

await check('hydration sweeps stale rooms and loads live ones oldest-first', async () => {
  reset()
  nextResults = [
    { rows: [{ code: 'DEADAAAA' }] },
    { rows: [{ code: 'TRZM4K7B' }] },
    {
      rows: [
        {
          id: 'b',
          kind: 'chat',
          username: 'two',
          author_id: 's2',
          body: 'newer',
          created_at: '2026-01-01T00:00:02.000Z',
        },
        {
          id: 'a',
          kind: 'chat',
          username: 'one',
          author_id: 's1',
          body: 'older',
          created_at: '2026-01-01T00:00:01.000Z',
        },
      ],
    },
  ]

  const { rooms, swept } = await hydrateFromDatabase()

  assert.equal(swept, 1, 'the stale room should be reported as swept')
  assert.ok(find('DELETE FROM rooms WHERE last_active_at').length === 1)
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0].code, 'TRZM4K7B')
  // The index returns newest-first; the timeline needs oldest-first.
  assert.deepEqual(
    rooms[0].messages.map((m) => m.text),
    ['older', 'newer'],
  )
})

await check('database rows map onto the wire message shape', async () => {
  reset()
  nextResults = [
    { rows: [] },
    { rows: [{ code: 'FQ0D2M9X' }] },
    {
      rows: [
        {
          id: 'm-1',
          kind: 'system',
          username: null,
          author_id: null,
          body: 'ghost_shell joined the room',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  ]

  const { rooms } = await hydrateFromDatabase()
  assert.deepEqual(rooms[0].messages[0], {
    id: 'm-1',
    kind: 'system',
    text: 'ghost_shell joined the room',
    username: null,
    authorId: null,
    at: Date.parse('2026-01-01T00:00:00.000Z'),
  })
})

await check('a hydrated room serves its backlog to the next joiner', async () => {
  reset()
  hydrateRoom('TRZM4K7B', [
    { id: 'old-1', kind: 'chat', text: 'from before the restart', username: 'ghost', authorId: 'x', at: 1 },
  ])
  const room = getRoom('TRZM4K7B')
  assert.ok(room, 'the room should exist in memory after hydration')
  assert.equal(room.messages.length, 1)
  assert.equal(room.members.size, 0, 'hydration must not invent presence')

  const join = joinRoom('TRZM4K7B', 'sock-late', 'latecomer')
  assert.equal(join.ok, true)
  assert.equal(getRoom('TRZM4K7B').messages[0].text, 'from before the restart')
  leaveRoom('TRZM4K7B', 'sock-late')
})

await check('hydration refuses an invalid or duplicate code', async () => {
  assert.equal(hydrateRoom('192.168.1.1', []), null, 'IP-shaped code must be refused')
  assert.equal(hydrateRoom('IIIILLLL', []), null, 'excluded letters must be refused')
  assert.equal(hydrateRoom('TRZM4K7B', []), null, 'already-loaded room must not be clobbered')
})

console.log('\n=== persistence disabled ===')

await check('with persistence off, no SQL is issued at all', async () => {
  disablePersistence()
  reset()
  joinRoom('CAPAAAAA', 'sock-off', 'offline')
  pushMessage('CAPAAAAA', {
    id: 'no-db',
    kind: 'chat',
    text: 'memory only',
    username: 'offline',
    authorId: 'sock-off',
    at: Date.now(),
  })
  await flushPersistence()
  assert.equal(calls.length, 0)
  assert.equal(getRoom('CAPAAAAA').messages.length, 1, 'chat must work without a database')
})

console.log(`\npersistence: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
