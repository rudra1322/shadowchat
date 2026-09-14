// Postgres access layer.
//
// `pg` is resolved lazily through createRequire so the offline test suite (and
// `npm test` on a machine with no database) can import this module without the
// driver being installed. Tests inject their own pool instead.

import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '..', 'database', 'migrations')

let pool = null

export function getDatabaseUrl() {
  return process.env.DATABASE_URL || ''
}

/** Test/seam hook: swap in a fake pool without touching the real driver. */
export function setPool(next) {
  pool = next
}

export function getPool() {
  if (pool) return pool

  const connectionString = getDatabaseUrl()
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up`.',
    )
  }

  const { Pool } = createRequire(import.meta.url)('pg')
  pool = new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Managed providers (Neon, Supabase, RDS) terminate plaintext connections.
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  })

  pool.on('error', (error) => {
    console.error('[shadowchat:db] idle client error', error.message)
  })

  return pool
}

export async function query(text, params) {
  return getPool().query(text, params)
}

export async function closePool() {
  if (!pool) return
  const current = pool
  pool = null
  if (typeof current.end === 'function') await current.end()
}

/** Returns true when the database answers, false otherwise. Never throws. */
export async function healthCheck() {
  try {
    await query('SELECT 1')
    return true
  } catch (error) {
    console.error('[shadowchat:db] health check failed:', error.message)
    return false
  }
}

/**
 * Runs `fn` inside a transaction on one dedicated client.
 *
 * A pool hands out a different connection per query, so BEGIN/COMMIT issued
 * through pool.query() can land on different connections and silently lose
 * their atomicity. Everything transactional must go through here.
 */
export async function withTransaction(fn) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      // A dead connection cannot roll back; the server will drop it anyway.
      console.error('[shadowchat:db] rollback failed:', rollbackError.message)
    }
    throw error
  } finally {
    client.release()
  }
}

/**
 * Applies every .sql file in database/migrations in filename order, once.
 *
 * Each file and its schema_migrations row commit together, so a failed
 * migration leaves no record behind and is retried on the next boot.
 */
export async function migrate({ log = console.log } = {}) {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const { rows } = await query('SELECT name FROM schema_migrations')
  const applied = new Set(rows.map((row) => row.name))

  let count = 0
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')

    try {
      await withTransaction(async (client) => {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      })
    } catch (error) {
      throw new Error(`migration ${file} failed: ${error.message}`)
    }

    log(`[shadowchat:db] applied ${file}`)
    count += 1
  }

  if (count === 0) log('[shadowchat:db] schema already up to date')
  return { applied: count, total: files.length }
}
