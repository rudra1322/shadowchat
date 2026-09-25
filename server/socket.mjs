import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

import {
  JOIN_RATE,
  MESSAGE_IP_RATE,
  MESSAGE_RATE,
  NETWORK,
  ROOM,
} from './config.mjs'

import {
  persistenceMode,
  recordActivity,
  recordSecurityEvent,
} from './persistence.mjs'

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
  // randomUUID is CSPRNG-backed, so message ids cannot be guessed or collide.
  return randomUUID()
}

/**
 * Sliding-window counter keyed by network.
 *
 * Used for both join attempts and the per-IP message cap.
 * Process-local on purpose: this phase targets a single backend instance.
 */
function createRateLimiter({ windowMs, max }) {
  const attempts = new Map()

  return {
    /** Returns true when this key may proceed. */
    take(key) {
      const now = Date.now()

      const recent = (
        attempts.get(key) ?? []
      ).filter(
        (t) => now - t < windowMs,
      )

      // Temporary security-test diagnostics.
      console.log('[security-test] RATE_LIMIT_CHECK', {
        key,
        max,
        windowMs,
        recentCount: recent.length,
      })

      // Opportunistic cleanup so idle keys do not accumulate forever.
      if (attempts.size > 5_000) {
        for (const [existing, stamps] of attempts) {
          if (
            stamps.every(
              (t) => now - t >= windowMs,
            )
          ) {
            attempts.delete(existing)
          }
        }
      }

      if (recent.length >= max) {
        attempts.set(key, recent)

        console.log('[security-test] RATE_LIMIT_BLOCKED', {
          key,
          max,
          windowMs,
          recentCount: recent.length,
        })

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
  return socketRateKey(socket, {
    trustProxy: NETWORK.TRUST_PROXY,
  })
}

/**
 * `ioFactory` exists so the offline test suite can inject an in-process fake
 * and drive the real handlers below without opening a socket.
 * Production always uses the default Socket.IO implementation.
 */
export function attachSocketServer(
  httpServer,
  { origin, ioFactory } = {},
) {
  // Socket.IO is resolved lazily so the offline test suite can inject a fake.
  const createServer =
    ioFactory ??
    ((server, options) => {
      const { Server } = createRequire(
        import.meta.url,
      )('socket.io')

      return new Server(server, options)
    })

  const io = createServer(httpServer, {
    path: '/socket',
    serveClient: false,

    cors: origin
      ? {
          origin,
          methods: ['GET', 'POST'],
        }
      : undefined,

    maxHttpBufferSize: 1e5,
    pingTimeout: 20_000,
  })

  if (io.engine?.on) {
    io.engine.on('connection_error', (error) => {
      console.error(
        '[shadowchat:security] CONNECTION_ERROR',
        {
          code: error?.code ?? null,
          message:
            error?.message ||
            'Socket connection error',
        },
      )
  
      recordSecurityEvent(
        'CONNECTION_ERROR',
        {
          ipKey: null,
          details:
            error?.message ||
            'Socket connection error',
        },
      )
    })
  }

  const joinLimiter = createRateLimiter({
    windowMs: JOIN_RATE.WINDOW_MS,
    max: JOIN_RATE.MAX,
  })

  const messageIpLimiter = createRateLimiter({
    windowMs: MESSAGE_IP_RATE.WINDOW_MS,
    max: MESSAGE_IP_RATE.MAX,
  })

  // Temporary startup diagnostic.
  console.log('[security-test] JOIN_LIMITER_CONFIG', {
    max: JOIN_RATE.MAX,
    windowMs: JOIN_RATE.WINDOW_MS,
  })

  io.on('connection', (socket) => {
    
    // Per-connection session state.
    // Never trust client-sent identity later.
    const session = {
      code: null,
      username: null,
      stamps: [],
    }

    function emitMembers() {
      if (!session.code) return

      io.to(session.code).emit(
        'room:members',
        {
          members: listMembers(session.code),
        },
      )
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

      pushMessage(
        session.code,
        message,
      )

      io.to(session.code).emit(
        'room:message',
        message,
      )
    }

    // ------------------------------------------------------------
    // ROOM CREATE
    // ------------------------------------------------------------

    socket.on('room:create', (_payload, ack) => {
      console.log('[security-test] ROOM_CREATE_RECEIVED')

      const respond =
        typeof ack === 'function'
          ? ack
          : () => {}

      // Creating a room costs a join attempt.
      const key = clientKey(socket)

      console.log('[security-test] CREATE_RATE_STATE', {
        key,
        max: JOIN_RATE.MAX,
        windowMs: JOIN_RATE.WINDOW_MS,
      })

      const allowed = joinLimiter.take(key)

      console.log('[security-test] CREATE_RATE_RESULT', {
        key,
        allowed,
      })

      if (!allowed) {
        console.log(
          '[security-test] JOIN_RATE_LIMITED',
          {
            ipKey: key,
            source: 'room:create',
          },
        )

        recordSecurityEvent(
          'JOIN_RATE_LIMITED',
          {
            ipKey: key,
            details:
              'Room creation rate limit exceeded',
          },
        )

        respond({
          ok: false,
          error: 'JOIN_RATE_LIMITED',
        })

        socket.emit(
          'room:error',
          {
            error: 'JOIN_RATE_LIMITED',
          },
        )

        return
      }

      // The room code comes from the server CSPRNG.
      const created = openRoom()

      if (!created.ok) {
        respond({
          ok: false,
          error: created.error,
        })

        return
      }

      respond({
        ok: true,
        code: created.code,
      })
    })

    // ------------------------------------------------------------
    // ROOM JOIN
    // ------------------------------------------------------------

    socket.on('room:join', (payload, ack) => {
      const respond =
        typeof ack === 'function'
          ? ack
          : () => {}

      if (session.code) {
        respond({
          ok: false,
          error: 'ALREADY_IN_ROOM',
        })

        return
      }

      // Count before validation so room-code brute force is rate limited.
      const key = clientKey(socket)

      const allowed = joinLimiter.take(key)

      if (!allowed) {
        console.log(
          '[security-test] JOIN_RATE_LIMITED',
          {
            ipKey: key,
            source: 'room:join',
          },
        )

        recordSecurityEvent(
          'JOIN_RATE_LIMITED',
          {
            ipKey: key,
            details:
              'Room join rate limit exceeded',
          },
        )

        respond({
          ok: false,
          error: 'JOIN_RATE_LIMITED',
        })

        socket.emit(
          'room:error',
          {
            error: 'JOIN_RATE_LIMITED',
          },
        )

        return
      }

      const code = normalizeCode(
        payload?.code,
      )

      const username = sanitizeUsername(
        payload?.username,
      )

      if (!isValidCode(code)) {
        console.log('[security-test] INVALID_ROOM_CODE', {
          code,
          username,
          ipKey: key,
        })
      
        recordSecurityEvent(
          'INVALID_ROOM_CODE',
          {
            roomCode: code || null,
            username: username || null,
            ipKey: key,
            details: 'Invalid room code format',
          },
        )
      
        respond({
          ok: false,
          error: 'INVALID_CODE',
        })
      
        socket.emit('room:error', {
          error: 'INVALID_CODE',
        })
      
        return
      }

      if (!username) {
        respond({
          ok: false,
          error: 'INVALID_USERNAME',
        })

        return
      }

      const result = joinRoom(
        code,
        socket.id,
        username,
      )

      if (!result.ok) {
        respond({
          ok: false,
          error: result.error,
        })

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

        messages: room
          ? room.messages.slice(
              -ROOM.MAX_MESSAGES_PER_ROOM,
            )
          : [],

        persistence: persistenceMode(),
      })

      // A reconnect is not treated as a new participant.
      const reconnected = consumeDeparture(
        code,
        result.username,
      )

      if (!reconnected) {
        systemMessage(
          `${result.username} joined the room`,
        )
      }

      emitMembers()
    })

    // ------------------------------------------------------------
    // MESSAGE SEND
    // ------------------------------------------------------------

    socket.on('message:send', (payload, ack) => {
      const respond =
        typeof ack === 'function'
          ? ack
          : () => {}

      if (
        !session.code ||
        !session.username
      ) {
        respond({
          ok: false,
          error: 'NOT_IN_ROOM',
        })

        return
      }

      const now = Date.now()

      // Per-connection message limiter.
      session.stamps = session.stamps.filter(
        (t) =>
          now - t < MESSAGE_RATE.WINDOW_MS,
      )

      if (
        session.stamps.length >=
        MESSAGE_RATE.MAX
      ) {
        respond({
          ok: false,
          error: 'RATE_LIMITED',
        })

        return
      }

      // Network/IP-based limiter.
      // Checked before accepting the message.
      const key = clientKey(socket)

      if (!messageIpLimiter.take(key)) {
        console.log(
          '[security-test] MESSAGE_RATE_LIMITED',
          {
            roomCode: session.code,
            username: session.username,
            ipKey: key,
          },
        )

        recordSecurityEvent(
          'MESSAGE_RATE_LIMITED',
          {
            roomCode: session.code,
            username: session.username,
            ipKey: key,
            details:
              'Network message rate limit exceeded',
          },
        )

        respond({
          ok: false,
          error: 'MESSAGE_RATE_LIMITED',
        })

        return
      }

      session.stamps.push(now)

      const text = sanitizeMessage(
        payload?.text,
      )

      if (!text) {
        respond({
          ok: false,
          error: 'EMPTY_MESSAGE',
        })

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

      // pushMessage refreshes room activity
      // and queues the PostgreSQL write.
      pushMessage(
        session.code,
        message,
      )

      io.to(session.code).emit(
        'room:message',
        message,
      )

      respond({
        ok: true,
        id: message.id,
        persistence: persistenceMode(),
      })
    })

    // ------------------------------------------------------------
    // TYPING
    // ------------------------------------------------------------

    socket.on('typing', (payload) => {
      if (
        !session.code ||
        !session.username
      ) {
        return
      }

      socket
        .to(session.code)
        .emit(
          'room:typing',
          {
            username: session.username,
            active: Boolean(
              payload?.active,
            ),
          },
        )
    })

    // ------------------------------------------------------------
    // CLEAR ROOM
    // ------------------------------------------------------------

    socket.on(
      'room:clear',
      (_payload, ack) => {
        const respond =
          typeof ack === 'function'
            ? ack
            : () => {}

        if (
          !session.code ||
          !session.username
        ) {
          respond({
            ok: false,
            error: 'NOT_IN_ROOM',
          })

          return
        }

        const code = session.code

        const cleared =
          clearMessages(code)

        if (!cleared) {
          respond({
            ok: false,
            error: 'ROOM_NOT_FOUND',
          })

          return
        }

        io.to(code).emit(
          'room:cleared',
        )

        respond({
          ok: true,
          persistence:
            persistenceMode(),
        })
      },
    )

    // ------------------------------------------------------------
    // ROOM LEAVE
    // ------------------------------------------------------------

    socket.on(
      'room:leave',
      (_payload, ack) => {
        const respond =
          typeof ack === 'function'
            ? ack
            : () => {}

        if (!session.code) {
          respond({ ok: true })
          return
        }

        const code = session.code
        const username = session.username

        socket
          .to(code)
          .emit(
            'room:typing',
            {
              username,
              active: false,
            },
          )

        systemMessage(
          `${username} left the room`,
        )

        socket.leave(code)

        leaveRoom(
          code,
          socket.id,
        )

        recordActivity(
          'USER_LEFT',
          {
            roomCode: code,
            username,
          },
        )

        session.code = null
        session.username = null

        io.to(code).emit(
          'room:members',
          {
            members: listMembers(code),
          },
        )

        respond({ ok: true })
      },
    )

    // ------------------------------------------------------------
    // DISCONNECT
    // ------------------------------------------------------------

    socket.on('disconnect', () => {
      if (!session.code) return

      const code = session.code
      const username = session.username

      const member = leaveRoom(
        code,
        socket.id,
      )

      if (member) {
        // Announce the drop only if the same handle
        // has not returned inside the grace window.
        noteDeparture(
          code,
          username,
        )

        setTimeout(() => {
          if (
            !hasPendingReturn(
              code,
              username,
            )
          ) {
            return
          }

          clearDeparture(
            code,
            username,
          )

          const room = getRoom(code)

          if (!room) return

          const message = {
            id: makeId(),
            kind: 'system',
            text: `${username} disconnected`,
            username: null,
            at: Date.now(),
          }

          pushMessage(
            code,
            message,
          )

          io.to(code).emit(
            'room:message',
            message,
          )
        }, ROOM.RECONNECT_GRACE_MS).unref?.()
      }

      io.to(code).emit(
        'room:typing',
        {
          username,
          active: false,
        },
      )

      io.to(code).emit(
        'room:members',
        {
          members: listMembers(code),
        },
      )
    })
  })

  return io
}