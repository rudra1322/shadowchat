import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { JOIN_RATE, MESSAGE_IP_RATE, MESSAGE_RATE, NETWORK, ROOM } from './config.mjs'
import { persistenceMode } from './persistence.mjs'
import { socketRateKey } from './clientKey.mjs'
import {
  clearDeparture,
  consumeDeparture,
  isValidCode,
  joinRoom,
  leaveRoom,
  listMembers,
  noteDeparture,
  normalizeCode,
  openRoom,
  pushMessage,
  clearMessages,
  getRoom,
  hasPendingReturn,
  sanitizeMessage,
  sanitizeUsername,
} from './rooms.mjs'

function makeId() {
  // randomUUID is CSPRNG-backed, so message ids cannot be guessed or collide,
  // unlike the old Date.now() + Math.random() pair. The column is TEXT, so no
  // schema change is needed.
  return randomUUID()
}

/**
 * Sliding-window counter keyed by network (see server/clientKey.mjs).
 *
 * Used for both join attempts and the per-IP message cap, so the two share one
 * keying strategy. Process-local on purpose: this phase targets a single
 * backend instance. With several replicas each process would allow the full
 * quota, so a shared store (or a limiter at the reverse proxy) would be needed
 * -- see the README.
 */
function createRateLimiter({ windowMs, max }) {
  const attempts = new Map()

  return {
    /** Returns true when this key may proceed. */
    take(key) {
      const now = Date.now()
      const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs)

      // Opportunistic cleanup so idle keys do not accumulate forever.
      if (attempts.size > 5_000) {
        for (const [existing, stamps] of attempts) {
          if (stamps.every((t) => now - t >= windowMs)) attempts.delete(existing)
        }
      }

      if (recent.length >= max) {
        attempts.set(key, recent)
        return false
      }
      recent.push(now)
      attempts.set(key, recent)
      return true
    },
    size() {
      return attempts.size
    },
  }
}

function clientKey(socket) {
  return socketRateKey(socket, { trustProxy: NETWORK.TRUST_PROXY })
}

/**
 * `ioFactory` exists so the offline test suite can inject an in-process fake
 * and drive the real handlers below without opening a socket. Production always
 * uses the default (real socket.io) implementation.
 */
export function attachSocketServer(httpServer, { origin, ioFactory } = {}) {
  // socket.io is resolved lazily so the offline test suite can inject a fake
  // without the real package being installed.
  const createServer =
    ioFactory ??
    ((server, options) => {
      const { Server } = createRequire(import.meta.url)('socket.io')
      return new Server(server, options)
    })
  const io = createServer(httpServer, {
    path: '/socket',
    serveClient: false,
    cors: origin ? { origin, methods: ['GET', 'POST'] } : undefined,
    maxHttpBufferSize: 1e5,
    pingTimeout: 20_000,
  })

  const joinLimiter = createRateLimiter({
    windowMs: JOIN_RATE.WINDOW_MS,
    max: JOIN_RATE.MAX,
  })

  // Second message limiter, keyed by network instead of by connection: the
  // per-connection cap below multiplies with every extra socket a client
  // opens, so on its own it does not bound a flood.
  const messageIpLimiter = createRateLimiter({
    windowMs: MESSAGE_IP_RATE.WINDOW_MS,
    max: MESSAGE_IP_RATE.MAX,
  })

  io.on('connection', (socket) => {
    // Per-connection session state. Never trust client-sent identity later.
    const session = { code: null, username: null, stamps: [] }

    function emitMembers() {
      if (!session.code) return
      io.to(session.code).emit('room:members', {
        members: listMembers(session.code),
      })
    }

    function systemMessage(text) {
      if (!session.code) return
      const message = {
        id: makeId(),
        kind: 'system',
        text,
        username: null,
        at: Date.now(),
      }
      pushMessage(session.code, message)
      io.to(session.code).emit('room:message', message)
    }

    socket.on('room:create', (_payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {}

      // Creating a room costs a join attempt: otherwise room:create would be
      // an unmetered way to spin up rooms.
      if (!joinLimiter.take(clientKey(socket))) {
        respond({ ok: false, error: 'JOIN_RATE_LIMITED' })
        socket.emit('room:error', { error: 'JOIN_RATE_LIMITED' })
        return
      }

      // The code comes from the server's CSPRNG. Anything the client sent is
      // ignored on purpose -- a chosen code could be low-entropy or guessable.
      const created = openRoom()
      if (!created.ok) {
        respond({ ok: false, error: created.error })
        return
      }
      respond({ ok: true, code: created.code })
    })

    socket.on('room:join', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {}

      if (session.code) {
        respond({ ok: false, error: 'ALREADY_IN_ROOM' })
        return
      }

      // Counted before validation: brute-forcing room codes produces mostly
      // *invalid* attempts, so only counting successes would defeat the point.
      if (!joinLimiter.take(clientKey(socket))) {
        respond({ ok: false, error: 'JOIN_RATE_LIMITED' })
        socket.emit('room:error', { error: 'JOIN_RATE_LIMITED' })
        return
      }

      const code = normalizeCode(payload?.code)
      const username = sanitizeUsername(payload?.username)

      if (!isValidCode(code)) {
        respond({ ok: false, error: 'INVALID_CODE' })
        return
      }
      if (!username) {
        respond({ ok: false, error: 'INVALID_USERNAME' })
        return
      }

      const result = joinRoom(code, socket.id, username)
      if (!result.ok) {
        respond({ ok: false, error: result.error })
        return
      }

      session.code = code
      session.username = result.username
      socket.join(code)

      const room = getRoom(code)
      respond({
        ok: true,
        code,
        username: result.username,
        selfId: socket.id,
        members: listMembers(code),
        // One backlog policy everywhere: the room keeps MAX_MESSAGES_PER_ROOM
        // in memory, hydration restores the same number, and a joining or
        // reconnecting client receives the same number.
        messages: room ? room.messages.slice(-ROOM.MAX_MESSAGES_PER_ROOM) : [],
        persistence: persistenceMode(),
      })

      // A socket that dropped and came straight back is a reconnect, not a new
      // participant, so it does not get another "joined" line.
      const reconnected = consumeDeparture(code, result.username)
      if (!reconnected) systemMessage(`${result.username} joined the room`)
      emitMembers()
    })

    socket.on('message:send', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {}

      if (!session.code || !session.username) {
        respond({ ok: false, error: 'NOT_IN_ROOM' })
        return
      }

      const now = Date.now()
      session.stamps = session.stamps.filter((t) => now - t < MESSAGE_RATE.WINDOW_MS)
      if (session.stamps.length >= MESSAGE_RATE.MAX) {
        respond({ ok: false, error: 'RATE_LIMITED' })
        return
      }

      // Checked before the message is accepted, so a throttled message is
      // never broadcast, never persisted, and never refreshes room activity.
      if (!messageIpLimiter.take(clientKey(socket))) {
        respond({ ok: false, error: 'MESSAGE_RATE_LIMITED' })
        return
      }
      session.stamps.push(now)

      const text = sanitizeMessage(payload?.text)
      if (!text) {
        respond({ ok: false, error: 'EMPTY_MESSAGE' })
        return
      }

      const message = {
        id: makeId(),
        kind: 'chat',
        text,
        username: session.username,
        authorId: socket.id,
        at: now,
      }

      // pushMessage refreshes room activity and queues the Postgres write.
      pushMessage(session.code, message)
      io.to(session.code).emit('room:message', message)
      // `persistence` tells the client what was actually guaranteed: the
      // message is delivered either way, but "degraded"/"off" means it may not
      // survive a restart. Never claim durability we did not achieve.
      respond({ ok: true, id: message.id, persistence: persistenceMode() })
    })

    socket.on('typing', (payload) => {
      if (!session.code || !session.username) return
      socket.to(session.code).emit('room:typing', {
        username: session.username,
        active: Boolean(payload?.active),
      })
    })

    socket.on('room:clear', (_payload, ack) => {
  const respond = typeof ack === 'function' ? ack : () => {}

  if (!session.code || !session.username) {
    respond({ ok: false, error: 'NOT_IN_ROOM' })
    return
  }

  const code = session.code

  const cleared = clearMessages(code)

  if (!cleared) {
    respond({ ok: false, error: 'ROOM_NOT_FOUND' })
    return
  }

  // Tell every currently connected client to remove its local timeline.
  io.to(code).emit('room:cleared')

  respond({
    ok: true,
    persistence: persistenceMode(),
  })
})

    socket.on('room:leave', (_payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {}
      if (!session.code) {
        respond({ ok: true })
        return
      }

      const code = session.code
      const username = session.username
      socket.to(code).emit('room:typing', { username, active: false })
      systemMessage(`${username} left the room`)
      socket.leave(code)
      leaveRoom(code, socket.id)
      session.code = null
      session.username = null

      io.to(code).emit('room:members', { members: listMembers(code) })
      respond({ ok: true })
    })

    socket.on('disconnect', () => {
      if (!session.code) return
      const code = session.code
      const username = session.username
      const member = leaveRoom(code, socket.id)
      if (member) {
        // Announce the drop only if the same handle has not come back inside
        // the grace window -- a flaky connection should not spam the timeline.
        noteDeparture(code, username)
        setTimeout(() => {
          if (!hasPendingReturn(code, username)) return
          clearDeparture(code, username)
          const room = getRoom(code)
          if (!room) return
          const message = {
            id: makeId(),
            kind: 'system',
            text: `${username} disconnected`,
            username: null,
            at: Date.now(),
          }
          pushMessage(code, message)
          io.to(code).emit('room:message', message)
        }, ROOM.RECONNECT_GRACE_MS).unref?.()
      }
      io.to(code).emit('room:typing', { username, active: false })
      io.to(code).emit('room:members', { members: listMembers(code) })
    })
  })

  return io
}
