// User-facing copy for the machine-readable error codes the socket layer
// returns. Kept in one place so the room screen and the tests read from the
// same source, and so no rate-limiter internals (windows, counters, keys) leak
// into the UI.

export const ERROR_COPY: Record<string, string> = {
  INVALID_CODE: 'That room code is not valid.',
  INVALID_USERNAME: 'Your handle was rejected. Pick another one.',
  ROOM_FULL: 'This room is full (50 members max).',
  ALREADY_IN_ROOM: 'This connection is already in a room. Reload the page.',
  RATE_LIMITED: 'Slow down - too many messages in a short window.',
  MESSAGE_RATE_LIMITED: 'Too many messages from your connection. Wait a moment and try again.',
  JOIN_RATE_LIMITED: 'Too many join attempts. Please wait a moment and try again.',
  ROOM_CODE_UNAVAILABLE: 'Could not create a room right now. Try again.',
  NOT_IN_ROOM: 'You are not connected to the room.',
  EMPTY_MESSAGE: 'Write something first.',
}

export const GENERIC_ERROR = 'Something went wrong. Try again.'

export function errorMessage(code: string | undefined, fallback = GENERIC_ERROR): string {
  if (!code) return fallback
  return ERROR_COPY[code] ?? fallback
}
