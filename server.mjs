import next from 'next'
import { createServer } from 'node:http'
import { attachSocketServer } from './server/socket.mjs'
import { hydrateRoom, roomStats } from './server/rooms.mjs'
import { closePool, migrate } from './server/db.mjs'
import { assertProductionCredentials } from './server/config.mjs'
import {
  flushPersistence,
  getRecentActivity,
  hydrateFromDatabase,
  persistenceStats,
  recordSecurityEvent,
  startExpirationSweeper,
  startPersistence,
  stopExpirationSweeper,
} from './server/persistence.mjs'

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)

// Set REQUIRE_DATABASE=false only for a throwaway demo.
// In normal operation, PostgreSQL is required.
const requireDatabase = process.env.REQUIRE_DATABASE !== 'false'

// A production deployment still using the repository's development database
// password is a configuration accident, not a valid setup.
// Fail before the port is bound rather than serving traffic against a
// guessable database.
assertProductionCredentials()

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// -----------------------------------------------------------------------------
// DATABASE INITIALIZATION
// -----------------------------------------------------------------------------

// Start PostgreSQL persistence before accepting HTTP traffic.
// If the database is required and unavailable, fail loudly instead of
// silently running without persistence.
const persistent = await startPersistence({
  required: requireDatabase,
})

if (persistent) {
  // A half-applied schema is worse than refusing to start.
  // Migration failure is fatal when the database is required.
  try {
    await migrate()
  } catch (error) {
    console.error('[shadowchat] migration failed:', error?.message || error)

    if (requireDatabase) {
      process.exit(1)
    }

    throw error
  }

  // Restore active rooms and remove stale database records after startup.
  const { rooms, swept } = await hydrateFromDatabase()

  for (const room of rooms) {
    hydrateRoom(room.code, room.messages)
  }

  console.log(
    `[shadowchat] hydrated ${rooms.length} room(s) from Postgres, swept ${swept} stale`,
  )

  // Continue checking for expired rooms periodically.
  startExpirationSweeper()
}

await app.prepare()

// -----------------------------------------------------------------------------
// HTTP SERVER
// -----------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // ---------------------------------------------------------------------------
  // HEALTH CHECK
  // ---------------------------------------------------------------------------

  // Tiny health endpoint for Docker/Compose and uptime checks.
  if (req.url === '/healthz') {
    const { mode, pending, errors } = persistenceStats()

    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')

    // Deliberately coarse:
    // - no database connection strings
    // - no SQL errors
    // - no internal stack traces
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

  // ---------------------------------------------------------------------------
  // ADMIN ACTIVITY
  // ---------------------------------------------------------------------------

  // Returns metadata only.
  // Message bodies/content are never exposed here.
  if (req.url === '/activity') {
    try {
      const events = await getRecentActivity(25)

      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')

      res.end(
        JSON.stringify({
          ok: true,
          events,
        }),
      )
    } catch (error) {
      console.error(
        '[shadowchat] activity request error',
        error,
      )

      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')

      res.end(
        JSON.stringify({
          ok: false,
          error: 'ACTIVITY_UNAVAILABLE',
        }),
      )
    }

    return
  }

  // ---------------------------------------------------------------------------
  // TEMPORARY SECURITY TEST ENDPOINT
  // ---------------------------------------------------------------------------
  //
  // TEST ONLY.
  //
  // This endpoint intentionally creates a SERVER_ERROR security event so
  // persistence of SERVER_ERROR can be verified safely during local testing.
  //
  // REMOVE THIS ENTIRE BLOCK after the security test is complete.
  //


  // ---------------------------------------------------------------------------
  // NEXT.JS REQUEST HANDLER
  // ---------------------------------------------------------------------------

  handle(req, res).catch((error) => {
    console.error('[shadowchat] request error', error)

    // Record unexpected HTTP/server failures without exposing internal
    // error details to the client.
    recordSecurityEvent('SERVER_ERROR', {
      details: 'Unhandled HTTP request error',
    })

    res.statusCode = 500
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('cache-control', 'no-store')

    res.end('Internal server error')
  })
})

// -----------------------------------------------------------------------------
// SOCKET.IO
// -----------------------------------------------------------------------------

// Attach Socket.IO to the same HTTP server.
attachSocketServer(server, {
  origin: process.env.SOCKET_ORIGIN,
})

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------

server.listen(port, hostname, () => {
  console.log(`[shadowchat] ready on http://localhost:${port}`)

  console.log(
    `[shadowchat] persistence: ${
      persistent
        ? 'temporary postgres (active rooms survive a restart)'
        : 'none configured (rooms are lost on restart)'
    }`,
  )
})

// -----------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// -----------------------------------------------------------------------------

// Flush queued writes before exiting so the last few messages are not lost.
let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return

    shuttingDown = true

    console.log(
      `\n[shadowchat] ${signal} received, draining...`,
    )

    server.close()

    stopExpirationSweeper()

    await flushPersistence()
    await closePool()

    process.exit(0)
  })
}