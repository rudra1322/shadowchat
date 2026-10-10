
import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null

function getSocketUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_SHADOWCHAT_API_URL

  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '')
  }

  if (process.env.NODE_ENV === 'production') {
    return 'https://shadowchat-api-b00l.onrender.com'
  }

  return window.location.origin
}

/** Single shared Socket.IO connection across route changes. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(getSocketUrl(), {
      path: '/socket',
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
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
