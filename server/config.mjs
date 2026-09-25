// Single place for every tunable limit.
//
// Everything here can be overridden with an environment variable so the same
// image can run with tighter limits in production without a code change.

function int(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[shadowchat:config] ${name}="${raw}" is not a positive number, using ${fallback}`)
    return fallback
  }
  return Math.floor(value)
}

function bool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === 'true' || raw === '1'
}

export const ROOM = {
  /** Timeline cap, both in memory and in Postgres. */
  MAX_MESSAGES_PER_ROOM: int('MAX_MESSAGES_PER_ROOM', 250),
  /** How long an empty room survives before it is deleted everywhere. */
  EMPTY_ROOM_TTL_MS: int('EMPTY_ROOM_TTL_MS', 60_000),
  MAX_MEMBERS_PER_ROOM: int('MAX_MEMBERS_PER_ROOM', 50),
  /** A room idle longer than this is never hydrated after a restart. */
  HYDRATE_ACTIVE_WITHIN_MS: int('HYDRATE_ACTIVE_WITHIN_MS', 30 * 60_000),
  HYDRATE_MAX_ROOMS: int('HYDRATE_MAX_ROOMS', 500),
  /**
   * A dropped socket that comes back with the same handle inside this window
   * is treated as a reconnect, so a flaky network does not fill the timeline
   * with "x disconnected" / "x joined" pairs.
   */
  RECONNECT_GRACE_MS: int('RECONNECT_GRACE_MS', 10_000),
}

export const MESSAGE_RATE = {
  WINDOW_MS: int('MESSAGE_RATE_WINDOW_MS', 10_000),
  MAX: int('MESSAGE_ATTEMPTS_PER_WINDOW', 20),
}

/**
 * Second message limiter, keyed by network (see server/clientKey.mjs) instead
 * of by connection. The per-connection limit alone multiplies with every extra
 * socket an attacker opens, so this one caps the whole client.
 *
 * The default allows three busy tabs at the per-connection rate, which is well
 * above normal use but far below a useful flood. Process-local, like every
 * limiter here: multi-instance deployments would need shared state.
 */
export const MESSAGE_IP_RATE = {
  WINDOW_MS: int('MESSAGE_IP_WINDOW_MS', 10_000),
  MAX: int('MESSAGE_IP_RATE', 3),
}

export const JOIN_RATE = {
  WINDOW_MS: int('JOIN_RATE_WINDOW_MS', 60_000),
  MAX: int('JOIN_ATTEMPTS_PER_WINDOW', 10),
}

export const PERSISTENCE = {
  /** Trim in batches: the cap is a ceiling, not an exact count. */
  TRIM_EVERY_N_MESSAGES: int('TRIM_EVERY_N_MESSAGES', 25),
  /**
   * Skip a room-activity UPDATE if one was already sent this recently. Keeps a
   * busy room from issuing an UPDATE per message.
   */
  ACTIVITY_TOUCH_INTERVAL_MS: int('ACTIVITY_TOUCH_INTERVAL_MS', 10_000),
  /**
   * Bounded write-behind retry. A restarting database is usually back within a
   * few seconds; after the last attempt the write is dropped and the server
   * reports "degraded" instead of pretending the row landed.
   */
  WRITE_MAX_ATTEMPTS: int('WRITE_MAX_ATTEMPTS', 3),
  WRITE_RETRY_BASE_MS: int('WRITE_RETRY_BASE_MS', 250),
  /**
   * How often the process deletes rooms that idled past
   * ROOM.HYDRATE_ACTIVE_WITHIN_MS. Same TTL definition the boot sweep uses --
   * this only stops stale rows sitting around until the next restart.
   */
  SWEEP_INTERVAL_MS: int('SWEEP_INTERVAL_MS', 5 * 60_000),
}

/** Password the repository ships for local development only. */
export const DEV_DEFAULT_DB_PASSWORD = 'shadowchat'

/**
 * Refuses to boot a production process that is still using the development
 * database password from docker-compose.yml / .env.example. Local development
 * keeps working because the check only runs when NODE_ENV=production.
 *
 * The password itself is never logged.
 */
export function assertProductionCredentials({
  nodeEnv = process.env.NODE_ENV,
  databaseUrl = process.env.DATABASE_URL,
  password = process.env.POSTGRES_PASSWORD,
} = {}) {
  if (nodeEnv !== 'production') return

  const candidates = [password]
  if (databaseUrl) {
    try {
      candidates.push(decodeURIComponent(new URL(databaseUrl).password))
    } catch {
      // An unparseable URL is the connection layer's problem, not this check's.
    }
  }

  if (candidates.some((value) => value === DEV_DEFAULT_DB_PASSWORD)) {
    throw new Error(
      'Refusing to start: the database is still using the development password. ' +
        'Set POSTGRES_PASSWORD (and DATABASE_URL) to a unique secret before running with NODE_ENV=production.',
    )
  }
}

export const NETWORK = {
  /**
   * Only read X-Forwarded-For when a trusted reverse proxy sets it. Off by
   * default: a spoofable header must never drive a rate limiter.
   */
  TRUST_PROXY: bool('TRUST_PROXY', false),
}
