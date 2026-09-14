#!/usr/bin/env node
// Standalone migration runner: `npm run db:migrate`
//
// Useful in CI, in a container entrypoint, or before a deploy. server.mjs also
// runs migrate() on boot, so this is for cases where you want schema changes
// applied without starting the app.

import { closePool, migrate } from '../server/db.mjs'

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.')
  process.exit(1)
}

try {
  const result = await migrate()
  console.log(`[shadowchat:db] ${result.applied} of ${result.total} migration(s) applied`)
} catch (error) {
  console.error('[shadowchat:db] migration failed:', error.message)
  process.exitCode = 1
} finally {
  await closePool()
}
