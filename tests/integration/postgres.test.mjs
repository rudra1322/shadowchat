// Real PostgreSQL integration test.
//
// The unit suite fakes the query layer so it can run anywhere. This file talks
// to an actual database and is therefore NOT part of `npm test`. Run it with
// the Compose database up:
//
//   docker compose up -d db
//   DATABASE_URL=postgres://shadowchat:<password>@localhost:5432/shadowchat \
//     npm run test:integration
//
// Without DATABASE_URL (or without the `pg` package installed) it skips
// cleanly, so CI never fails because an external service is missing.

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.log('\nintegration: SKIP (set DATABASE_URL to run against a real PostgreSQL)')
  process.exit(0)
}

const require = createRequire(import.meta.url)
let pg
try {
  pg = require('pg')
} catch {
  console.log('\nintegration: SKIP (the `pg` package is not installed)')
  process.exit(0)
}

const { closePool, migrate, query, setPool } = await import('../../server/db.mjs')
const {
  configurePersistence,
  deleteExpiredRooms,
  flushPersistence,
  hydrateFromDatabase,
  recordMessage,
  recordRoomActivity,
} = await import('../../server/persistence.mjs')

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

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
setPool(pool)
configurePersistence({ enabled: true, query })

const active = '7TG4CT1V'
const stale = '7TGS4R3X'

console.log('\nintegration: real PostgreSQL')

await check('migrations apply cleanly (and are idempotent)', async () => {
  await migrate({ log: () => {} })
  await migrate({ log: () => {} })
  const { rows } = await query(
    "SELECT table_name FROM information_schema.tables WHERE table_name IN ('rooms','messages')",
  )
  assert(rows.length === 2, `expected both tables, found ${rows.length}`)
})

// Start from a clean slate for this room pair only.
await query('DELETE FROM rooms WHERE code = ANY($1)', [[active, stale]])

await check('a room row is created', async () => {
  recordRoomActivity(active, { force: true })
  await flushPersistence()
  const { rows } = await query('SELECT code FROM rooms WHERE code = $1', [active])
  assert(rows.length === 1, 'the room should exist in Postgres')
})

const messageId = randomUUID()

await check('a message is persisted', async () => {
  recordMessage(active, {
    id: messageId,
    kind: 'chat',
    username: 'ghost',
    authorId: 'socket-1',
    text: 'integration hello',
    at: Date.now(),
  })
  await flushPersistence()
  const { rows } = await query('SELECT body FROM messages WHERE id = $1', [messageId])
  assert(rows.length === 1 && rows[0].body === 'integration hello', 'the message row is missing')
})

await check('room activity is refreshed by a message', async () => {
  const before = await query('SELECT last_active_at FROM rooms WHERE code = $1', [active])
  await query("UPDATE rooms SET last_active_at = now() - INTERVAL '1 hour' WHERE code = $1", [active])
  recordRoomActivity(active, { force: true })
  await flushPersistence()
  const after = await query('SELECT last_active_at FROM rooms WHERE code = $1', [active])
  assert(before.rows.length === 1, 'the room must exist')
  assert(
    new Date(after.rows[0].last_active_at).getTime() > Date.now() - 60_000,
    'activity should be brought back to now',
  )
})

await check('hydration reloads the room and its messages', async () => {
  const result = await hydrateFromDatabase()

  assert(
    result.rooms.length >= 1,
    `expected at least one hydrated room, got ${result.rooms.length}`,
  )

  const hydratedRoom = result.rooms.find((room) => room.code === active)

  assert(hydratedRoom, 'the active room should be hydrated')

  assert(
    hydratedRoom.messages.length >= 1,
    `expected at least one hydrated message, got ${hydratedRoom.messages.length}`,
  )
})

await check('the sweeper deletes only expired rooms', async () => {
  await query('INSERT INTO rooms (code) VALUES ($1) ON CONFLICT (code) DO NOTHING', [stale])
  await query("UPDATE rooms SET last_active_at = now() - INTERVAL '30 days' WHERE code = $1", [stale])
  const removed = await deleteExpiredRooms()
  assert(removed.includes(stale), 'the stale room should be swept')
  assert(!removed.includes(active), 'an active room must survive the sweep')
})

await check('deleting a room cascades to its messages', async () => {
  const orphanId = randomUUID()
  await query('INSERT INTO rooms (code) VALUES ($1) ON CONFLICT (code) DO NOTHING', [stale])
  await query(
    'INSERT INTO messages (id, room_code, kind, username, author_id, body) VALUES ($1,$2,$3,$4,$5,$6)',
    [orphanId, stale, 'chat', 'ghost', 'socket-2', 'cascade me'],
  )
  await query('DELETE FROM rooms WHERE code = $1', [stale])
  const { rows } = await query('SELECT id FROM messages WHERE id = $1', [orphanId])
  assert(rows.length === 0, 'the foreign key must remove messages with their room')
})

await query('DELETE FROM rooms WHERE code = ANY($1)', [[active, stale]])
await closePool()

if (failures > 0) {
  console.error(`\n${failures} integration assertion(s) failed`)
  process.exit(1)
}
console.log('\nintegration: all assertions passed')
process.exit(0)
