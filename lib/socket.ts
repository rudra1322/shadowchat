import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null

/** Single shared connection so route changes do not open extra sockets. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket',
      transports: ['polling'],
      autoConnect: false,
      reconnectionAttempts: 8,
      reconnectionDelay: 700,
    })
  }
  return socket
}

export function disposeSocket() {
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }
}
