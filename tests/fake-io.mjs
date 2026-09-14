/**
 * In-process stand-in for socket.io, used only by the test suite.
 *
 * It records every emit so tests can assert on what the real handlers in
 * server/socket.mjs broadcast, without binding a port or opening a websocket.
 */
export class FakeIoServer {
  constructor(httpServer, options) {
    this.options = options
    this.log = []
    this._onConnection = null
  }

  on(event, handler) {
    if (event === 'connection') this._onConnection = handler
  }

  to(room) {
    const log = this.log
    return {
      emit(event, payload) {
        log.push({ target: 'room', room, event, payload })
      },
    }
  }

  /** Test helper: simulate a client connecting. */
  connect(socket) {
    this._onConnection(socket)
    return socket
  }
}

export function fakeIoFactory(httpServer, options) {
  return new FakeIoServer(httpServer, options)
}

/**
 * Builds a fake socket whose events can be fired synchronously.
 *
 * Each socket gets its own handshake address by default so the per-IP join
 * limiter does not lump unrelated tests together. Pass `address` to simulate
 * several connections coming from one client.
 */
export function makeSocket(io, id, { address, headers } = {}) {
  const handlers = {}
  return {
    id,
    handshake: { address: address ?? `ip-${id}`, headers: headers ?? {} },
    joined: new Set(),
    on(event, handler) {
      handlers[event] = handler
    },
    join(room) {
      this.joined.add(room)
    },
    leave(room) {
      this.joined.delete(room)
    },
    to(room) {
      const log = io.log
      return {
        emit(event, payload) {
          log.push({ target: 'others', room, event, payload })
        },
      }
    },
    emit(event, payload) {
      io.log.push({ target: 'self', socket: id, event, payload })
    },
    fire(event, payload, ack) {
      if (!handlers[event]) throw new Error('no handler registered for ' + event)
      return handlers[event](payload, ack)
    },
  }
}
