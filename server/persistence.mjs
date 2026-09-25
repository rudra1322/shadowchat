// Write-behind Postgres persistence for rooms and messages (Option B:
// ephemeral rooms with temporary persistence).
//
// Why write-behind: every socket handler in server/socket.mjs is synchronous,
// which keeps message fan-out on the hot path free of database latency. Writes
// are pushed onto a serial queue here and flushed in order. On boot the server
// hydrates live rooms back into memory (see hydrateFromDatabase), so a restart
// does not drop an in-progress conversation.
//
// Trade-off worth knowing: in-memory presence makes this a single-instance
// design. Running several replicas needs a Socket.IO adapter (Redis or
// Postgres LISTEN/NOTIFY) -- see the README.

import { healthCheck, query as defaultQuery } from './db.mjs'
import { PERSISTENCE, ROOM } from './config.mjs'

// Hydration restores the same number of messages the runtime keeps, so the
// timeline looks identical before and after a restart.
const HYDRATE_MAX_MESSAGES = ROOM.MAX_MESSAGES_PER_ROOM

let enabled = false
let queryFn = defaultQuery
let chain = Promise.resolve()
let pending = 0
let sweepTimer = null
let sweeping = false
const insertsSinceTrim = new Map()
const lastTouchedAt = new Map()
const stats = { writes: 0, errors: 0, retries: 0, dropped: 0, lastErrorAt: null }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Turns persistence on. `query` is injectable so tests can assert the exact
 * SQL without a running database.
 */
export function configurePersistence({ query = defaultQuery, enabled: on = true } = {}) {
  queryFn = query
  enabled = on
}

export function disablePersistence() {
  enabled = false
  chain = Promise.resolve()
  pending = 0
  insertsSinceTrim.clear()
  lastTouchedAt.clear()
  stopExpirationSweeper()
}

export function isPersistenceEnabled() {
  return enabled
}

/**
 * What the server can honestly claim right now:
 * - "off"      persistence is not configured
 * - "degraded" configured, but the last writes failed
 * - "postgres" writes are landing
 */
export function persistenceMode() {
  if (!enabled) return 'off'
  const recentFailure =
    stats.lastErrorAt !== null && Date.now() - stats.lastErrorAt < 30_000
  return recentFailure ? 'degraded' : 'postgres'
}

export function persistenceStats() {
  return { ...stats, pending, mode: persistenceMode() }
}

/**
 * Queues one database write, retried a bounded number of times.
 *
 * A brief outage (a database restart, a failover) is the common case, so the
 * write is retried with a growing delay before it is given up on. Retries are
 * bounded and happen on the shared serial chain, which keeps ordering intact
 * and makes a retry storm impossible: at most one write is in flight.
 *
 * Failures are never thrown at the caller -- a database hiccup must not break a
 * live chat room -- but they are recorded so persistenceMode() stops claiming
 * durability. Writes are idempotent (`ON CONFLICT DO NOTHING` for messages,
 * `DO UPDATE` for rooms), so a retry cannot duplicate a row.
 */
function enqueue(label, run) {
  if (!enabled) return
  pending += 1
  chain = chain
    .then(async () => {
      const attempts = Math.max(1, PERSISTENCE.WRITE_MAX_ATTEMPTS)
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await run()
          stats.writes += 1
          return
        } catch (error) {
          stats.errors += 1
          stats.lastErrorAt = Date.now()
          // Log the driver message server-side only; clients get a generic notice.
          console.error(
            `[shadowchat:db] ${label} failed (attempt ${attempt}/${attempts}):`,
            error.message,
          )
          if (attempt === attempts) {
            stats.dropped += 1
          
            console.error(
              `[shadowchat:db] ${label} dropped after ${attempts} attempts`,
            )
          
            // Record the failure without attempting another database write.
            console.error(
              '[shadowchat:security] PERSISTENCE_FAILURE',
              { operation: label },
            )
          
            return
          }
          stats.retries += 1
          // Linear-ish backoff: 250ms, 500ms, ... Short enough that a restarting
          // database is caught, long enough not to hammer it.
          await sleep(PERSISTENCE.WRITE_RETRY_BASE_MS * attempt)
        }
      }
    })
    .finally(() => {
      pending -= 1
    })
}

/** Waits for every queued write. Used by tests and by graceful shutdown. */
export async function flushPersistence() {
  await chain
}

/**
 * Creates the room row, or bumps last_active_at if it exists.
 *
 * `force` skips the throttle. Room creation and joins always write; per-message
 * activity is throttled so a busy room does not issue an UPDATE per message.
 */
export function recordRoomActivity(code, { force = true } = {}) {
  if (!enabled) return false

  const now = Date.now()
  if (!force) {
    const last = lastTouchedAt.get(code) ?? 0
    if (now - last < PERSISTENCE.ACTIVITY_TOUCH_INTERVAL_MS) return false
  }
  lastTouchedAt.set(code, now)

  enqueue('room upsert', () =>
    queryFn(
      `INSERT INTO rooms (code) VALUES ($1)
       ON CONFLICT (code) DO UPDATE SET last_active_at = now()`,
      [code],
    ),
  )
  return true
}

export function recordActivity(
  event,
  { roomCode = null, username = null } = {},
) {
  if (!enabled) return false

  enqueue('activity log insert', () =>
    queryFn(
      `INSERT INTO activity_logs (
         event,
         room_code,
         username
       )
       VALUES ($1, $2, $3)`,
      [
        event,
        roomCode,
        username,
      ],
    ),
  )

  return true
}

export function recordSecurityEvent(
  event,
  {
    roomCode = null,
    username = null,
    ipKey = null,
    details = null,
  } = {},
) {
  if (!enabled) return false

  enqueue('security event insert', () =>
    queryFn(
      `INSERT INTO security_events (
         event,
         room_code,
         username,
         ip_key,
         details
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event,
        roomCode,
        username,
        ipKey,
        details,
      ],
    ),
  )

  return true
}

export async function getRecentSecurityEvents(
  limit = 25,
) {
  if (!enabled) return []

  const safeLimit = Math.min(
    Math.max(Number(limit) || 25, 1),
    100,
  )

  const result = await queryFn(
    `SELECT
       id,
       event,
       room_code,
       username,
       ip_key,
       details,
       created_at
     FROM security_events
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit],
  )

  return result.rows
}

export async function getRecentActivity(limit = 25) {
  if (!enabled) return []

  const safeLimit = Math.min(
    Math.max(Number(limit) || 25, 1),
    100,
  )

  const result = await queryFn(
    `SELECT
       id,
       event,
       room_code,
       username,
       created_at
     FROM activity_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit],
  )

  return result.rows
}

export function recordMessage(code, message) {
  enqueue('message insert', async () => {
    await queryFn(
      `INSERT INTO messages (id, room_code, kind, username, author_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [
        message.id,
        code,
        message.kind,
        message.username ?? null,
        message.authorId ?? null,
        message.text ?? '',
        message.at,
      ],
    )

    // Trim in batches instead of on every insert -- the delete is the
    // expensive half and the cap is a ceiling, not an exact count.
    const seen = (insertsSinceTrim.get(code) ?? 0) + 1
    if (seen < PERSISTENCE.TRIM_EVERY_N_MESSAGES) {
      insertsSinceTrim.set(code, seen)
      return
    }
    insertsSinceTrim.set(code, 0)
    await queryFn(
      `DELETE FROM messages
        WHERE room_code = $1
          AND id NOT IN (
            SELECT id FROM messages
             WHERE room_code = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2
          )`,
      [code, ROOM.MAX_MESSAGES_PER_ROOM],
    )
  })
}

/** The room emptied out and its TTL expired: erase every trace of it. */
export function recordRoomClosed(code) {
  insertsSinceTrim.delete(code)
  lastTouchedAt.delete(code)
  enqueue('room delete', () => queryFn('DELETE FROM rooms WHERE code = $1', [code]))
}

/**
 * Permanently erases the chat history for a live room.
 *
 * The room itself remains alive; only its persisted messages are deleted.
 * The operation is queued on the same write-behind chain so it stays ordered
 * with message inserts.
 */
export function clearRoomMessages(code) {
  if (!enabled) return false

  insertsSinceTrim.delete(code)

  enqueue('message history clear', () =>
    queryFn('DELETE FROM messages WHERE room_code = $1', [code]),
  )

  return true
}

function rowToMessage(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.body,
    username: row.username ?? null,
    authorId: row.author_id ?? null,
    at: new Date(row.created_at).getTime(),
  }
}

/**
 * Loads recently active rooms and their backlog so a redeploy or crash does
 * not wipe a live conversation. Rooms idle past the activity window are
 * expired in the same pass, which is why they can never be hydrated.
 */
export async function hydrateFromDatabase() {
  if (!enabled) return { rooms: [], swept: 0 }

  const sweptCodes = await deleteExpiredRooms()

  const live = await queryFn(
    `SELECT code FROM rooms
      ORDER BY last_active_at DESC
      LIMIT $1`,
    [ROOM.HYDRATE_MAX_ROOMS],
  )

  const rooms = []
  for (const room of live.rows ?? []) {
    const code = String(room.code).trim()
    const backlog = await queryFn(
      `SELECT id, kind, username, author_id, body, created_at
         FROM messages
        WHERE room_code = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [code, HYDRATE_MAX_MESSAGES],
    )
    // Newest-first from the index, oldest-first for the timeline.
    rooms.push({ code, messages: (backlog.rows ?? []).map(rowToMessage).reverse() })
  }

  return { rooms, swept: sweptCodes.length }
}

/**
 * Deletes rooms that idled past ROOM.HYDRATE_ACTIVE_WITHIN_MS -- the single
 * expiration definition the boot sweep already used. Messages go with them
 * through the ON DELETE CASCADE foreign key in the migration, so no second
 * query is needed.
 */
export async function deleteExpiredRooms() {
  const result = await queryFn(
    `DELETE FROM rooms
      WHERE last_active_at < now() - ($1::bigint * INTERVAL '1 millisecond')
      RETURNING code`,
    [ROOM.HYDRATE_ACTIVE_WITHIN_MS],
  )
  return (result.rows ?? []).map((row) => String(row.code))
}

/**
 * Runs deleteExpiredRooms() on a timer.
 *
 * Without it, a process that is killed before its reapers fire leaves stale
 * rows behind until the next boot. Rooms held in memory keep refreshing
 * last_active_at, so an active room is never a sweep target. One sweep at a
 * time; the timer is unref'd so it never holds the process open.
 */
export function startExpirationSweeper({ intervalMs = PERSISTENCE.SWEEP_INTERVAL_MS } = {}) {
  if (sweepTimer || !enabled) return null

  sweepTimer = setInterval(async () => {
    if (sweeping) return
    sweeping = true
    try {
      const codes = await deleteExpiredRooms()
      if (codes.length > 0) {
        console.log(`[shadowchat:db] swept ${codes.length} expired room(s)`)
      }
    } catch (error) {
      stats.errors += 1
      stats.lastErrorAt = Date.now()
      console.error('[shadowchat:db] expiration sweep failed:', error.message)
    } finally {
      sweeping = false
    }
  }, intervalMs)

  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  return sweepTimer
}

/** Called on SIGINT/SIGTERM so shutdown is not held up by a pending sweep. */
export function stopExpirationSweeper() {
  if (!sweepTimer) return false
  clearInterval(sweepTimer)
  sweepTimer = null
  return true
}

export function isSweeperRunning() {
  return sweepTimer !== null
}

/**
 * Called once at boot. Returns false when no DATABASE_URL is configured or the
 * database is unreachable, so the caller can decide whether to abort.
 */
export async function startPersistence({ required = true } = {}) {
  if (!process.env.DATABASE_URL) {
    if (required) {
      throw new Error(
        'DATABASE_URL is required. Copy .env.example to .env or run `docker compose up`.',
      )
    }
    console.warn(
      '[shadowchat:db] DATABASE_URL unset -- rooms will not survive a restart',
    )
    return false
  }

  const alive = await healthCheck()
  if (!alive) {
    if (required) throw new Error('Postgres is unreachable. Check DATABASE_URL.')
    return false
  }

  configurePersistence({ enabled: true })
  return true
}

export const PERSISTENCE_LIMITS = {
  MAX_MESSAGES_PER_ROOM: ROOM.MAX_MESSAGES_PER_ROOM,
  TRIM_EVERY_N_MESSAGES: PERSISTENCE.TRIM_EVERY_N_MESSAGES,
  HYDRATE_MAX_ROOMS: ROOM.HYDRATE_MAX_ROOMS,
  HYDRATE_MAX_MESSAGES,
  ACTIVITY_TOUCH_INTERVAL_MS: PERSISTENCE.ACTIVITY_TOUCH_INTERVAL_MS,
  WRITE_MAX_ATTEMPTS: PERSISTENCE.WRITE_MAX_ATTEMPTS,
  SWEEP_INTERVAL_MS: PERSISTENCE.SWEEP_INTERVAL_MS,
}
