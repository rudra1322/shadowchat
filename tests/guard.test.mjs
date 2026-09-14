// Production database credential guard.
//
// The compose file ships a throwaway password so `docker compose up` works out
// of the box. The risk is that the same file gets deployed unchanged, leaving a
// public database with a password published in the repository. In production
// the process refuses to start instead.

import { assertProductionCredentials, DEV_DEFAULT_DB_PASSWORD } from '../server/config.mjs'

let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL  ${name}\n        ${error.message}\n`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function throws(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

const devUrl = `postgres://shadowchat:${DEV_DEFAULT_DB_PASSWORD}@db:5432/shadowchat`
const safeUrl = 'postgres://shadowchat:S0me-Long-Random-Secret@db:5432/shadowchat'

console.log('\nproduction credential guard')

check('development with the default password still starts', () => {
  const error = throws(() =>
    assertProductionCredentials({
      nodeEnv: 'development',
      databaseUrl: devUrl,
      password: DEV_DEFAULT_DB_PASSWORD,
    }),
  )
  assert(error === null, `local development must keep working: ${error?.message}`)
})

check('test environment is unaffected', () => {
  const error = throws(() =>
    assertProductionCredentials({ nodeEnv: 'test', databaseUrl: devUrl, password: DEV_DEFAULT_DB_PASSWORD }),
  )
  assert(error === null, 'the guard is production-only')
})

check('production with the default POSTGRES_PASSWORD refuses to start', () => {
  const error = throws(() =>
    assertProductionCredentials({
      nodeEnv: 'production',
      databaseUrl: safeUrl,
      password: DEV_DEFAULT_DB_PASSWORD,
    }),
  )
  assert(error !== null, 'shipping the development password to production must be fatal')
})

check('production with the default password inside DATABASE_URL also refuses', () => {
  const error = throws(() =>
    assertProductionCredentials({ nodeEnv: 'production', databaseUrl: devUrl, password: '' }),
  )
  assert(error !== null, 'the effective password is the one in the connection string')
})

check('the error explains the fix without leaking the password', () => {
  const error = throws(() =>
    assertProductionCredentials({
      nodeEnv: 'production',
      databaseUrl: devUrl,
      password: DEV_DEFAULT_DB_PASSWORD,
    }),
  )
  assert(/POSTGRES_PASSWORD/.test(error.message), 'the operator needs to know what to set')
  assert(
    !error.message.includes(DEV_DEFAULT_DB_PASSWORD),
    'a credential must never be echoed into logs',
  )
})

check('production with a configured password starts', () => {
  const error = throws(() =>
    assertProductionCredentials({
      nodeEnv: 'production',
      databaseUrl: safeUrl,
      password: 'S0me-Long-Random-Secret',
    }),
  )
  assert(error === null, `a configured secret must be accepted: ${error?.message}`)
})

check('a URL-encoded default password is still detected', () => {
  const error = throws(() =>
    assertProductionCredentials({
      nodeEnv: 'production',
      databaseUrl: 'postgres://shadowchat:shadowchat@db:5432/shadowchat?sslmode=require',
      password: '',
    }),
  )
  assert(error !== null, 'query parameters must not hide the weak credential')
})

check('a malformed DATABASE_URL does not crash the guard', () => {
  const error = throws(() =>
    assertProductionCredentials({ nodeEnv: 'production', databaseUrl: 'not a url', password: 'strong' }),
  )
  assert(error === null, 'connection errors are reported later by the pool, not here')
})

if (failures > 0) {
  console.error(`\n${failures} credential guard assertion(s) failed`)
  process.exit(1)
}
console.log('\nproduction credential guard: all assertions passed')
process.exit(0)
