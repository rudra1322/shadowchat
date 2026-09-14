// Timeline reconciliation.
//
// A reconnect used to do `setMessages(ack.messages)`, which throws away
// anything the client knows that the server backlog does not contain (a
// message that arrived while the ack was in flight, or one older than the
// backlog window). Merging by id keeps both sides and cannot duplicate.

import type { ChatMessage } from '@/lib/types'

/**
 * Deterministic order: by timestamp, then by id so two messages sharing a
 * millisecond never swap places between renders.
 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.at !== b.at) return a.at - b.at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Union of local and incoming messages, deduplicated by id.
 *
 * The server copy wins on conflict: it is the authority for text, handle and
 * timestamp.
 */
export function mergeMessages(
  local: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (incoming.length === 0) return [...local].sort(compareMessages)

  const byId = new Map<string, ChatMessage>()
  for (const message of local) byId.set(message.id, message)
  for (const message of incoming) byId.set(message.id, message)

  return [...byId.values()].sort(compareMessages)
}

/** Appends one live message, ignoring a repeat of an id already held. */
export function appendMessage(
  local: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  if (local.some((item) => item.id === message.id)) return local
  const last = local[local.length - 1]
  // The common case is strictly increasing time, so skip the sort.
  if (!last || compareMessages(last, message) <= 0) return [...local, message]
  return mergeMessages(local, [message])
}
