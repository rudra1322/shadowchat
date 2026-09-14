import { createServer } from 'node:http'
import next from 'next'
import { attachSocketServer } from './server/socket.mjs'
import { hydrateRoom, roomStats } from './server/rooms.mjs'
import { closePool, migrate } from './server/db.mjs'
import { assertProductionCredentials } from './server/config.mjs'
import {
  flushPersistence,
  hydrateFromDatabase,
  persistenceStats,
  startExpirationSweeper,
  startPersistence,
  stopExpirationSweeper,
} from './server/persistence.mjs'

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)
// Set REQUIRE_DATABASE=false only for a throwaway demo: rooms then live purely
// in memory and disappear on restart.
const requireDatabase = process.env.REQUIRE_DATABASE !== 'false'

// A production deployment still using the repository's development database
// password is a configuration accident, not a valid setup. Fail before the
// port is bound rather than serving traffic against a guessable database.
assertProductionCredentials()

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// 1. Database first. If Postgres is required and missing, fail loudly here
//    rather than silently losing every message at runtime.
const persistent = await startPersistence({ required: requireDatabase })

if (persistent) {
  // A half-applied schema is worse than a refusal to start: the app would
  // write against tables that may not exist. Migration failure is fatal when
  // the database is required.
  try {
    await migrate()
  } catch (error) {
    console.error('[shadowchat] migration failed:', error.message)
    if (requireDatabase) process.exit(1)
    throw error
  }

  const { rooms, swept } = await hydrateFromDatabase()
  for (const room of rooms) hydrateRoom(room.code, room.messages)
  console.log(
    `[shadowchat] hydrated ${rooms.length} room(s) from Postgres, swept ${swept} stale`,
  )

  // A crash can kill the in-memory reapers before they delete their rooms, so
  // the same expiry rule also runs on a timer instead of only at boot.
  startExpirationSweeper()
}

await app.prepare()

const httpServer = createServer((req, res) => {
  // Tiny health endpoint for Docker/compose and uptime checks.
  if (req.url === '/healthz') {
    const { mode, pending, errors } = persistenceStats()
    res.setHeader('content-type', 'application/json')
    // Deliberately coarse: no connection strings, no driver error text.
    res.end(
      JSON.stringify({
        ok: true,
        persistence: mode,
        pendingWrites: pending,
        persistenceErrors: errors,
        ...roomStats(),
      }),
    )
    return
  }

  handle(req, res).catch((error) => {
    console.error('[shadowchat] request error', error)
    res.statusCode = 500
    res.end('Internal server error')
  })
})

attachSocketServer(httpServer, { origin: process.env.SOCKET_ORIGIN })

httpServer.listen(port, hostname, () => {
  console.log(`[shadowchat] ready on http://localhost:${port}`)
  console.log(
    `[shadowchat] persistence: ${
      persistent
        ? 'temporary postgres (active rooms survive a restart)'
        : 'none configured (rooms are lost on restart)'
    }`,
  )
})

// Flush queued writes before exiting so the last few messages are not lost.
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[shadowchat] ${signal} received, draining...`)
    httpServer.close()
    stopExpirationSweeper()
    await flushPersistence()
    await closePool()
    process.exit(0)
  })
}
