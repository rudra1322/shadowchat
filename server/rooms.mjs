// Live room state.
//
// Memory is the hot path: presence and the recent timeline live here so socket
// fan-out never waits on the database. Every mutation is mirrored to Postgres
// through server/persistence.mjs (write-behind), and the server hydrates live
// rooms back from Postgres on boot. Rooms still vanish when empty -- the TTL
// deletes the room row and cascades its messages away.

import {
  recordMessage,
  recordRoomActivity,
  recordRoomClosed,
  clearRoomMessages,
  recordActivity,
} from './persistence.mjs'
import { ROOM } from './config.mjs'
import { generateUniqueRoomCode, isValidRoomCode } from './roomCode.mjs'

const {
  MAX_MESSAGES_PER_ROOM,
  EMPTY_ROOM_TTL_MS,
  MAX_MEMBERS_PER_ROOM,
  RECONNECT_GRACE_MS,
} = ROOM

/** @type {Map<string, {code: string, members: Map<string, {id: string, username: string, joinedAt: number}>, messages: Array<object>, createdAt: number, reaper: NodeJS.Timeout | null}>} */
const rooms = new Map()

export function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 8)
}

export function isValidCode(code) {
  // Crockford base32 minus I, L, O, U to avoid look-alikes. Shared with the
  // generator in server/roomCode.mjs so both halves can never drift apart.
  return isValidRoomCode(code)
}

export function sanitizeUsername(raw) {
  const cleaned = String(raw || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
  return cleaned.length >= 2 ? cleaned : ''
}

export function sanitizeMessage(raw) {
  const cleaned = String(raw || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
  return cleaned.slice(0, 2000)
}

/**
 * Creates a room with a server-generated code.
 *
 * The client never supplies the code: it could otherwise pick something
 * guessable ("AAAAAAAA") and throw away the 40 bits of entropy that keep a
 * room private. Collisions are retried against live rooms.
 */
export function openRoom() {
  const code = generateUniqueRoomCode((candidate) => rooms.has(candidate))
  if (!code) return { ok: false, error: 'ROOM_CODE_UNAVAILABLE' }

  const room = createRoom(code)
  // Nobody has joined yet, so it must be reaped like any other empty room if
  // the creator never arrives.
  scheduleReaper(code, room)
  return { ok: true, code }
}

function createRoom(code) {
  const room = {
    code,
    members: new Map(),
    messages: [],
    createdAt: Date.now(),
    reaper: null,
  }
  rooms.set(code, room)
recordRoomActivity(code)
recordActivity('ROOM_CREATED', {
  roomCode: code,
})
return room
}

/**
 * Rebuilds a room from Postgres at boot. The room starts with no members, so
 * it also gets a reaper: if nobody reconnects it disappears like any other
 * empty room.
 */
export function hydrateRoom(code, messages = []) {
  if (!isValidCode(code) || rooms.has(code)) return null
  const room = {
    code,
    members: new Map(),
    messages: messages.slice(-MAX_MESSAGES_PER_ROOM),
    createdAt: Date.now(),
    reaper: null,
  }
  rooms.set(code, room)
  scheduleReaper(code, room)
  return room
}

function scheduleReaper(code, room) {
  if (room.reaper) return
  room.reaper = setTimeout(() => {
    const current = rooms.get(code)
    if (current && current.members.size === 0) {
      rooms.delete(code)
recordRoomClosed(code)
recordActivity('ROOM_EXPIRED', {
  roomCode: code,
})
    }
  }, EMPTY_ROOM_TTL_MS)
  if (typeof room.reaper.unref === 'function') room.reaper.unref()
}

export function getRoom(code) {
  return rooms.get(code) || null
}

export function joinRoom(code, socketId, username) {
  let room = rooms.get(code)
  if (!room) room = createRoom(code)

  if (room.reaper) {
    clearTimeout(room.reaper)
    room.reaper = null
  }

  recordRoomActivity(code)

  if (room.members.size >= MAX_MEMBERS_PER_ROOM && !room.members.has(socketId)) {
    return { ok: false, error: 'ROOM_FULL' }
  }

  // Keep handles unique inside a room so nobody can impersonate.
  const taken = new Set([...room.members.values()].map((m) => m.username.toLowerCase()))
  let handle = username
  let suffix = 2
  while (taken.has(handle.toLowerCase())) {
    handle = `${username.slice(0, 20)}~${suffix}`
    suffix += 1
  }

  room.members.set(socketId, { id: socketId, username: handle, joinedAt: Date.now() })
  recordActivity('USER_JOINED', {
    roomCode: code,
    username: handle,
  })
  return { ok: true, room, username: handle }
}

// Handles that dropped out recently, so a reconnect can be recognised:
// `${code}|${handle}` -> timestamp.
const recentDepartures = new Map()

function departureKey(code, username) {
  return `${code}|${String(username ?? '').toLowerCase()}`
}

/** Records that a handle dropped, so an immediate return counts as a reconnect. */
export function noteDeparture(code, username) {
  if (!username) return
  recentDepartures.set(departureKey(code, username), Date.now())
}

/**
 * True when this handle left the room within the reconnect grace window.
 * Consumes the record, so it only suppresses one join/leave pair.
 */
export function consumeDeparture(code, username) {
  const key = departureKey(code, username)
  const at = recentDepartures.get(key)
  if (at === undefined) return false
  recentDepartures.delete(key)
  return Date.now() - at < RECONNECT_GRACE_MS
}

/**
 * True when a departure has not been claimed by a reconnect yet.
 * `consumeDeparture` removes the record when the handle comes back, and the
 * caller clears it once the grace period has elapsed, so a surviving record
 * means "this person really is gone".
 */
export function hasPendingReturn(code, username) {
  return recentDepartures.has(departureKey(code, username))
}

export function clearDeparture(code, username) {
  recentDepartures.delete(departureKey(code, username))
}

export function leaveRoom(code, socketId) {
  const room = rooms.get(code)
  if (!room) return null

  const member = room.members.get(socketId) || null
  room.members.delete(socketId)

  if (room.members.size === 0) scheduleReaper(code, room)

  return member
}

export function pushMessage(code, message) {
  const room = rooms.get(code)
  if (!room) return null
  // A room is only "stale" if nobody is talking, so real message traffic has
  // to refresh last_active_at -- otherwise a busy room could be swept at the
  // next restart. Throttled so a chatty room does not issue an UPDATE per
  // message; only accepted messages reach this point.
  recordRoomActivity(code, { force: false })

  room.messages.push(message)
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM)
  }
  recordMessage(code, message)
  if (message.kind === 'chat') {
    recordActivity('MESSAGE_SENT', {
      roomCode: code,
      username: message.username,
    })
  }
  return message
}

/**
 * Erases the current chat history while keeping the room and its members alive.
 *
 * Both layers are cleared:
 * 1. The in-memory timeline used by connected sockets.
 * 2. The temporary PostgreSQL message history.
 */
export function clearMessages(code) {
  const room = rooms.get(code)
  if (!room) return false

  room.messages.length = 0
  clearRoomMessages(code)

  // Clearing chat is also valid room activity. Keep the room alive.
  recordRoomActivity(code)

  return true
}

export function listMembers(code) {
  const room = rooms.get(code)
  if (!room) return []
  return [...room.members.values()]
    .map(({ id, username, joinedAt }) => ({ id, username, joinedAt }))
    .sort((a, b) => a.joinedAt - b.joinedAt)
}

export function roomStats() {
  let onlineUsers = 0
  let messages = 0

  for (const room of rooms.values()) {
    onlineUsers += room.members.size
    messages += room.messages.length
  }

  return {
    rooms: rooms.size,
    onlineUsers,
    messages,
  }
}

export const ROOM_LIMITS = {
  MAX_MESSAGES_PER_ROOM,
  EMPTY_ROOM_TTL_MS,
  MAX_MEMBERS_PER_ROOM,
  RECONNECT_GRACE_MS,
}
