// Migration transactions.
//
// A pool hands out a different connection per query, so BEGIN/COMMIT sent
// through pool.query() is not a real transaction. These tests pin the fixed
// behaviour: one dedicated client, rollback on failure, no schema_migrations
// row after a failure, and the client always released.

import { migrate, setPool, withTransaction } from '../server/db.mjs'

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

/**
 * Fake pg pool. `failOn` makes the client reject the first query whose text
 * contains that fragment, simulating a broken migration file.
 */
function makePool({ failOn = null, appliedNames = [] } = {}) {
  const state = { poolQueries: [], clientQueries: [], connects: 0, releases: 0 }

  const client = {
    async query(text, params) {
      state.clientQueries.push({ sql: String(text).trim(), params })
      if (failOn && String(text).includes(failOn)) {
        throw new Error('syntax error at or near "BROKEN"')
      }
      return { rows: [] }
    },
    release() {
      state.releases += 1
    },
  }

  return {
    state,
    async connect() {
      state.connects += 1
      return client
    },
    async query(text, params) {
      const sql = String(text).trim()
      state.poolQueries.push({ sql, params })
      if (sql.startsWith('SELECT name FROM schema_migrations')) {
        return { rows: appliedNames.map((name) => ({ name })) }
      }
      return { rows: [] }
    },
  }
}

const clientSql = (pool) => pool.state.clientQueries.map((q) => q.sql)

console.log('\nmigrations')

await check('a successful migration commits on one dedicated client', async () => {
  const pool = makePool()
  setPool(pool)
  const result = await migrate({ log: () => {} })

  const sql = clientSql(pool)
  assert(pool.state.connects === 1, 'exactly one client should be checked out')
  assert(sql[0] === 'BEGIN', `first statement should be BEGIN, got ${sql[0]}`)
  assert(sql.at(-1) === 'COMMIT', `last statement should be COMMIT, got ${sql.at(-1)}`)
  assert(!sql.includes('ROLLBACK'), 'a successful migration must not roll back')
  assert(result.applied >= 1, 'at least one migration file should have been applied')
})

await check('the migration and its schema_migrations row share one transaction', async () => {
  const pool = makePool()
  setPool(pool)
  await migrate({ log: () => {} })

  const record = pool.state.clientQueries.find((q) =>
    q.sql.includes('INSERT INTO schema_migrations'),
  )
  assert(record, 'the migration record must be written on the transaction client')
  assert(record.params?.[0]?.endsWith('.sql'), 'the filename must be a bound parameter')
  const poolInserts = pool.state.poolQueries.filter((q) =>
    q.sql.includes('INSERT INTO schema_migrations'),
  )
  assert(poolInserts.length === 0, 'the record must not be written through the pool')
})

await check('BEGIN/COMMIT never go through the pool', async () => {
  const pool = makePool()
  setPool(pool)
  await migrate({ log: () => {} })

  const strays = pool.state.poolQueries.filter((q) =>
    ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q.sql),
  )
  assert(strays.length === 0, `pool-level transaction control found: ${JSON.stringify(strays)}`)
})

await check('a failing migration rolls back and rethrows', async () => {
  const pool = makePool({ failOn: 'CREATE TABLE' })
  setPool(pool)

  let thrown = null
  try {
    await migrate({ log: () => {} })
  } catch (error) {
    thrown = error
  }

  assert(thrown, 'migrate() must reject when a migration fails')
  assert(/migration .*\.sql failed/.test(thrown.message), thrown.message)
  assert(clientSql(pool).includes('ROLLBACK'), 'the transaction must roll back')
  assert(!clientSql(pool).includes('COMMIT'), 'a failed migration must not commit')
})

await check('no migration record is inserted after a failure', async () => {
  const pool = makePool({ failOn: 'CREATE TABLE' })
  setPool(pool)
  await migrate({ log: () => {} }).catch(() => {})

  const record = pool.state.clientQueries.find((q) =>
    q.sql.includes('INSERT INTO schema_migrations'),
  )
  assert(!record, 'the migration must be retried on the next boot, so record nothing')
})

await check('the client is released on success and on failure', async () => {
  const ok = makePool()
  setPool(ok)
  await migrate({ log: () => {} })
  assert(ok.state.releases === ok.state.connects, 'every client must be released on success')

  const bad = makePool({ failOn: 'CREATE TABLE' })
  setPool(bad)
  await migrate({ log: () => {} }).catch(() => {})
  assert(bad.state.releases === bad.state.connects, 'the client must be released on failure too')
})

await check('already-applied migrations are skipped', async () => {
  const pool = makePool({ appliedNames: ['001_init.sql'] })
  setPool(pool)
  const result = await migrate({ log: () => {} })
  assert(result.applied === 0, 'a recorded migration must not run twice')
  assert(pool.state.connects === 0, 'no transaction is needed when nothing is pending')
})

await check('withTransaction surfaces the original error', async () => {
  const pool = makePool()
  setPool(pool)

  let thrown = null
  try {
    await withTransaction(async () => {
      throw new Error('boom')
    })
  } catch (error) {
    thrown = error
  }

  assert(thrown?.message === 'boom', 'the caller must see the real error')
  assert(clientSql(pool).includes('ROLLBACK'), 'the helper must roll back')
  assert(pool.state.releases === 1, 'the client must be released')
})

setPool(null)

if (failures > 0) {
  console.error(`\n${failures} migration assertion(s) failed`)
  process.exit(1)
}
console.log('\nmigrations: all assertions passed')
