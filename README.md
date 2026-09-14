# ShadowChat

Ephemeral, code-based chat rooms. No accounts, no permanent history.

ShadowChat uses **temporary PostgreSQL persistence** so active rooms and their recent messages can
survive a backend restart. Room data is deleted when the room expires. This is not end-to-end
encrypted: the server processes plaintext messages.

Built as an original implementation for a cybersecurity college project. The room-join UX pattern
is inspired by simple public chat rooms; no third-party code, assets, or branding are reused.

## Security model

| Concern | Decision |
| --- | --- |
| Room identifier | 8 chars of Crockford base32, **generated on the server** with `node:crypto` (40 bits) and returned by `room:create`. The client cannot choose its own code. **Never derived from IP, hostname, or device attributes.** |
| Look-alike chars | `I`, `L`, `O`, `U` removed from the alphabet |
| Persistence | Temporary. Recent messages are stored in Postgres for restart recovery and deleted when the room expires. No E2EE — the server sees plaintext |
| Join flood control | 10 join/create attempts per client key per 60s (`JOIN_ATTEMPTS_PER_WINDOW`, `JOIN_RATE_WINDOW_MS`); process-local, single instance |
| Rate-limit keys | IPv4 per address, IPv6 per **/64 subnet** (so an attacker cannot rotate through a /64), IPv4-mapped IPv6 normalised, malformed addresses bucketed per value. `X-Forwarded-For` is read only when `TRUST_PROXY=true` |
| Room lifetime | Deleted 60s after the last member leaves |
| Identity | Server-side session per socket. The client cannot send its own author name on each message |
| Impersonation | Handles are forced unique inside a room (`alice`, `alice~2`) |
| Input handling | Handles 2-24 chars, messages capped at 2000 chars, control characters stripped |
| Flood control | 20 messages per 10s **per connection** plus 60 messages per 10s **per client key** (`MESSAGE_IP_RATE`, `MESSAGE_IP_WINDOW_MS`), so opening more sockets does not multiply the allowance. Rejected messages are not broadcast, not persisted and do not refresh room activity; the client only gets the code `MESSAGE_RATE_LIMITED` |
| Production credentials | With `NODE_ENV=production`, the server refuses to start if the effective database password is still the development default. The password itself is never logged |
| Room capacity | 50 members |
| Rendering | React escapes all message text; no `dangerouslySetInnerHTML` anywhere |

### Honest limitations

This is **transport-encrypted (TLS), not end-to-end encrypted**. The server sees plaintext while a
room is alive. Anyone with the code can enter — the code is the only access control. Do not claim
E2EE in your report.

All three rate limiters (join, per-connection message, per-IP message) live in the memory of a
single Node process. They are effective for this **single-instance** deployment only: behind a load
balancer each replica would enforce its own quota, so multi-instance deployments need a shared
store and a Socket.IO adapter. Identity is anonymous — a handle is not an account — and PostgreSQL
persistence is temporary recovery storage, not an archive.

### Rate limiting and reconnection

| Behaviour | Detail |
| --- | --- |
| Join / create | 10 attempts per client key per 60s → `JOIN_RATE_LIMITED` |
| Messages, per connection | 20 per 10s → `RATE_LIMITED` |
| Messages, per client key | 60 per 10s across all that client's sockets → `MESSAGE_RATE_LIMITED` |
| Reconnect | `socket.io-client` retries 8 times; the room page rejoins automatically and restores the stored handle |
| Reconnect noise | A handle that returns within `RECONNECT_GRACE_MS` (10s) suppresses both the "disconnected" and the repeat "joined" system line |
| Backlog | **One number everywhere: 250.** `MAX_MESSAGES_PER_ROOM` caps memory, Postgres trimming, boot hydration and the join/rejoin backlog, so the timeline looks the same before and after a reconnect or restart |
| Message sync | The join acknowledgement is **merged** with local state and deduplicated by message id, then sorted by timestamp with an id tie-break — a reconnect never drops a message the client already had |
| Retries exhausted | The room shows "Connection lost. Retry" with a working retry button instead of failing silently |
| Persistence status | `ack.persistence` (`postgres` / `degraded` / `off`) drives a quiet "Persistence temporarily degraded" chip; it disappears on the next successful join once writes recover. Raw database errors are never sent to clients |

## Stack

**Frontend**

- Next.js 15 (App Router) + React 19 + TypeScript
- Tailwind CSS v4 with a CSS-variable design system
- Zustand (persists only the chosen handle)
- `socket.io-client`

**Backend**

- Node.js + Socket.IO on a custom HTTP server (same port as Next.js)
- Server-side sessions, sanitisation, per-connection flood control

**Database**

- PostgreSQL 16 via `pg`, schema in `database/migrations/`
- Migrations run automatically on boot, or with `npm run db:migrate`

## Run it

### Option A — Docker Compose (app + Postgres, one command)

```bash
docker compose up --build      # http://localhost:3000
```

Postgres is exposed on `localhost:5432` (`shadowchat` / `shadowchat` / db `shadowchat`).
The app waits for the database health check, applies migrations, then starts.

### Option B — local Node, Postgres in Docker

```bash
docker run -d --name shadowchat-db -p 5432:5432 \
  -e POSTGRES_USER=shadowchat -e POSTGRES_PASSWORD=shadowchat \
  -e POSTGRES_DB=shadowchat postgres:16-alpine

npm install
cp .env.example .env           # DATABASE_URL already points at the container
npm run db:migrate
npm run dev                    # http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

`GET /healthz` returns `{ ok, persistence, pendingWrites, persistenceErrors, rooms }` for uptime
checks. `persistence` is `postgres`, `degraded` (writes are failing — chat still works, restart
recovery does not) or `off`. Database error details are logged server-side only, never returned to
clients.

## Database

The server **refuses to boot without a reachable Postgres** (set `REQUIRE_DATABASE=false` only for
a throwaway demo where rooms may be lost on restart). Migrations run inside a single transaction on
a dedicated client — a failed migration rolls back and records nothing, and startup aborts.

```
rooms     code (CHAR(8) PK, CHECK constrained to the room-code alphabet)
          created_at, last_active_at
messages  id (PK), room_code -> rooms(code) ON DELETE CASCADE,
          kind ('chat' | 'system'), username, author_id, body, created_at
```

How the two layers cooperate:

- **Memory is the hot path.** Presence and the recent timeline live in `server/rooms.mjs`, so
  socket fan-out never waits on a query.
- **Postgres is temporary recovery storage.** Every room upsert and message insert is queued
  write-behind in `server/persistence.mjs` and flushed in order, with a bounded retry
  (`WRITE_MAX_ATTEMPTS`, default 3, delay `WRITE_RETRY_BASE_MS × attempt`) before a write is
  dropped and the status turns `degraded`. There is no unbounded queue and no retry loop.
  Room activity is refreshed on
  create, join and every *accepted* message (throttled to one UPDATE per 10s per room), so a busy
  room is never treated as stale. A database outage is logged and swallowed — chat keeps working,
  `/healthz` reports `degraded`, and no durability is claimed.
- **Boot hydration.** On start the server deletes rooms idle for more than 30 minutes, then reloads
  the remaining rooms with up to `MAX_MESSAGES_PER_ROOM` (250) messages — the same cap the runtime
  uses, so the timeline looks identical before and after a restart. Expired rooms are gone and can
  never be hydrated.
- **Still ephemeral.** When a room has been empty past its 60s TTL the row is deleted and its
  messages cascade away. Message history is also capped at 250 rows per room.
- **Periodic sweeper.** Every `SWEEP_INTERVAL_MS` (default 5 minutes) the same process deletes
  rooms idle past the existing expiry window — the identical definition hydration uses, not a
  second TTL — so a crash cannot leave stale rows behind until the next boot. Messages follow via
  `ON DELETE CASCADE`, the statement is parameterised, and the timer is cleared during shutdown.
- Every statement uses bound parameters; room codes and message bodies are never string-concatenated
  into SQL.

Because presence is per-process, this is a **single-instance** deployment. All rate limiters are
also process-local, so each replica would allow its own quota. Running multiple replicas needs a
Socket.IO adapter (Redis or Postgres `LISTEN`/`NOTIFY`) and a shared limiter — out of scope for this
phase.

All tunable limits live in `server/config.mjs` and are environment-overridable; see `.env.example`.
Credentials are never hardcoded: `docker-compose.yml` reads `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB` and `DATABASE_URL` from the environment with local-only development defaults. Those
defaults are development-only by design: with `NODE_ENV=production` the server aborts at startup if
the effective password is still `shadowchat`, with a message that names the variable to set but
never echoes the value.

### Automated tests

```bash
npm test
```

165 assertions, no test framework, no network and no database needed. The socket suite injects an in-process
fake (`tests/fake-io.mjs`) via `attachSocketServer(..., { ioFactory })` and drives the real event
handlers, so join/leave, presence, identity spoofing, flood control, backlog trimming and room
reaping are all covered. The room-code suite generates 200,000 codes and checks length, alphabet,
collisions, a chi-square uniformity test, and IP-shaped input rejection. The persistence suite
injects a fake query function, so it asserts the exact SQL, bound parameters, batch trimming,
boot hydration and outage tolerance without a live Postgres. Phase 2 adds suites for server-side
room creation, per-IP message limiting, IPv4/IPv6//64 key normalisation, the production credential
guard, bounded persistence retry, the expiration sweeper, and reconnect merge/dedupe plus the
user-facing error copy.

A **real PostgreSQL integration test** is kept separate so the unit suite never depends on an
external service:

```bash
docker compose up -d db
DATABASE_URL=postgres://shadowchat:<password>@localhost:5432/shadowchat npm run test:integration
```

It covers migrations, room creation, message persistence, activity refresh, hydration, expiration
sweeping and cascade deletion, and skips cleanly when `DATABASE_URL` is unset.

### Testing with two users

Open two browser windows (or one normal + one incognito), generate a code in the first, paste it in
the second. You should see join/leave system lines, live presence, and typing indicators.

## Structure

```
app/
  layout.tsx              root shell, dark theme, metadata
  page.tsx                landing + join screen
  globals.css             design tokens, primitives, animation
  room/[code]/page.tsx    room orchestration (socket lifecycle, state)
components/room/
  RoomHeader.tsx          branding, room code + copy, status, controls
  MessageList.tsx         timeline, grouping, system lines, typing row
  MembersPanel.tsx        sidebar (>=1280px) and bottom sheet (<1280px)
  Composer.tsx            auto-growing textarea, Enter to send
  Avatar.tsx              deterministic per-handle colour
lib/
  roomCode.ts             room-code validation and formatting (generation is server-side)
  errors.ts               server error code -> user-facing copy
  messages.ts             merge/dedupe/sort helpers used on reconnect
  socket.ts               shared Socket.IO client singleton
  store.ts                Zustand handle persistence
  types.ts                shared message/member/status types
  utils.ts                cn, initials, hue, time formatting
server/
  rooms.mjs               live room registry, sanitisation, TTL reaper
  roomCode.mjs            authoritative CSPRNG room codes + collision retry
  clientKey.mjs           IPv4 / IPv6 (/64) rate-limit key normalisation
  config.mjs              env-driven limits + production credential guard
  socket.mjs              Socket.IO event handlers, rate limiting
  db.mjs                  pg pool, health check, migration runner
  persistence.mjs         write-behind Postgres writer + boot hydration
database/migrations/
  001_init.sql            rooms + messages schema, indexes, constraints
scripts/
  migrate.mjs             standalone `npm run db:migrate`
server.mjs                Postgres boot, Next.js + Socket.IO, graceful drain
docker-compose.yml        app + Postgres 16
```

## Socket protocol

| Direction | Event | Payload |
| --- | --- | --- |
| client to server | `room:join` | `{ code, username }` -> ack with members + backlog |
| client to server | `message:send` | `{ text }` -> ack `{ ok }` |
| client to server | `typing` | `{ active }` |
| client to server | `room:leave` | `{}` |
| server to client | `room:message` | chat or system message |
| server to client | `room:members` | `{ members }` |
| server to client | `room:typing` | `{ username, active }` |

## Notes for your report

- `Clear` wipes only your own view. The server copy stays until the room dies — a deliberate
  choice so one member cannot destroy shared evidence for everyone.
- Rooms are created implicitly on first join. There is no room-creation endpoint to enumerate.
- Guessing a room requires ~10^12 attempts against the 40-bit space; add a per-IP join rate limit
  behind a reverse proxy if you want to discuss hardening.
