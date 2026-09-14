// Authoritative room-code generation.
//
// The server owns this: if a client could pick its own code it could pick
// "AAAAAAAA" (or reuse one code across many rooms) and throw away the entropy
// that keeps rooms unguessable. lib/roomCode.ts keeps the matching *validation*
// and formatting helpers for the UI, but no longer generates codes.

import { randomBytes } from 'node:crypto'

// Crockford-style base32 without I, L, O, U (no look-alike characters).
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ROOM_CODE_LENGTH = 8
export const CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/

export function isValidRoomCode(code) {
  return CODE_PATTERN.test(String(code ?? ''))
}

/**
 * 8 chars over a 32-symbol alphabet = 40 bits of entropy, drawn from the OS
 * CSPRNG. 256 % 32 === 0, so plain modulo stays uniform.
 *
 * Security note: the identifier is deliberately never derived from the
 * visitor's IP address, hostname, or any other network attribute.
 */
export function generateRoomCode() {
  const bytes = randomBytes(ROOM_CODE_LENGTH)
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return code
}

/**
 * Generates a code that `isTaken` does not already claim.
 *
 * A collision at 40 bits is vanishingly unlikely, but retrying is cheap and
 * silently handing two groups the same room would be a privacy leak. Bounded
 * so a pathological `isTaken` can never spin forever.
 */
export function generateUniqueRoomCode(isTaken, { attempts = 8 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const code = generateRoomCode()
    if (!isTaken(code)) return code
  }
  return null
}
