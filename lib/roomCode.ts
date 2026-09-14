// Crockford-style base32 without I, L, O, U (no look-alike characters).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const ROOM_CODE_LENGTH = 8

const CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/

/**
 * Room codes are NOT generated here.
 *
 * The server owns generation (server/roomCode.mjs, reached through the
 * `room:create` socket event): a client that picked its own code could choose
 * a low-entropy one and throw away the 40 bits that keep a room unguessable.
 * This module keeps only the validation and formatting the UI needs, using the
 * same alphabet and length as the server.
 *
 * Security note: the identifier is never derived from the visitor's IP
 * address, hostname, or any other network attribute.
 */

/**
 * Detects input that is actually a network address.
 *
 * Without this guard, stripping separators would silently turn "49.36.221.104"
 * into the syntactically valid code "49362211". Room codes are never derived
 * from network addresses, so IP-shaped input is rejected outright instead of
 * being quietly reinterpreted.
 */
export function looksLikeIpAddress(raw: string): boolean {
  const value = raw.trim().replace(/^\[|\]$/g, '').split('/')[0]
  if (value.length === 0) return false

  // IPv4 dotted quad, with or without a port.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(value)) return true

  // Any dotted-numeric shape, e.g. partial or malformed IPv4.
  if (/^\d{1,3}(\.\d{1,3}){2,}$/.test(value)) return true

  // IPv6 and shorthand forms always contain a colon pair or hex groups.
  if (/^[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,}$/.test(value)) return true

  return false
}

/** Uppercases and strips separators so users can paste "K7QF-2M9X". */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, ROOM_CODE_LENGTH)
}

export function isValidRoomCode(code: string): boolean {
  return CODE_PATTERN.test(code)
}

/** Display helper: K7QF2M9X -> K7QF-2M9X */
export function formatRoomCode(code: string): string {
  const normalized = normalizeRoomCode(code)
  if (normalized.length <= 4) return normalized
  return normalized.slice(0, 4) + '-' + normalized.slice(4)
}
