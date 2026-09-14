'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Composer } from '@/components/room/Composer'
import { MembersSheet, MembersSidebar } from '@/components/room/MembersPanel'
import { MessageList } from '@/components/room/MessageList'
import { ConnectionBadge, RoomHeader } from '@/components/room/RoomHeader'
import { isValidRoomCode, normalizeRoomCode } from '@/lib/roomCode'
import { disposeSocket, getSocket } from '@/lib/socket'
import { errorMessage } from '@/lib/errors'
import { appendMessage, mergeMessages } from '@/lib/messages'
import { useIdentity } from '@/lib/store'
import type { ChatMessage, ConnectionStatus, JoinAck, Member } from '@/lib/types'

export default function RoomPage() {
  const router = useRouter()
  const params = useParams<{ code: string }>()
  const rawCode = Array.isArray(params.code) ? params.code[0] : params.code
  const code = normalizeRoomCode(rawCode ?? '')

  const username = useIdentity((state) => state.username)

  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [selfId, setSelfId] = useState<string | null>(null)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const [sheetOpen, setSheetOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [hydrated, setHydrated] = useState(false)
  // 'postgres' | 'degraded' | 'off', straight from the server ack.
  const [persistence, setPersistence] = useState<string | null>(null)
  // Socket.IO gave up retrying: the user needs a manual way back in.
  const [retryExhausted, setRetryExhausted] = useState(false)

  // Messages hidden by "clear my view". The server copy is untouched.
  const clearedRef = useRef<Set<string>>(new Set())
  const [clearToken, setClearToken] = useState(0)

  useEffect(() => setHydrated(true), [])

  // Guard: no handle yet, or a malformed code -> back to the join screen.
  useEffect(() => {
    if (!hydrated) return
    if (!isValidRoomCode(code) || username.trim().length < 2) {
      router.replace('/')
    }
  }, [hydrated, code, username, router])

  useEffect(() => {
    if (!hydrated) return
    if (!isValidRoomCode(code) || username.trim().length < 2) return

    const socket = getSocket()
    let cancelled = false

    function join() {
      socket.emit('room:join', { code, username }, (ack: JoinAck) => {
        if (cancelled) return
        if (!ack.ok) {
          setStatus('error')
          setNotice(errorMessage(ack.error, 'Could not join this room.'))
          return
        }
        setStatus('connected')
        setNotice('')
        setRetryExhausted(false)
        setSelfId(ack.selfId)
        setMembers(ack.members)
        setPersistence(ack.persistence ?? null)
        // Merge instead of replace: on a reconnect the local timeline can hold
        // messages the server backlog no longer carries, and replacing would
        // silently drop them. Dedupe is by message id.
        setMessages((current) => mergeMessages(current, ack.messages))
      })
    }

    function onConnect() {
      setStatus('connected')
      join()
    }

    function onDisconnect() {
      setStatus('reconnecting')
      setTypingUsers([])
    }

    function onConnectError() {
      setStatus('error')
      setNotice('Cannot reach the ShadowChat server.')
    }

    function onReconnectFailed() {
      setStatus('error')
      setRetryExhausted(true)
    }

    function onMessage(message: ChatMessage) {
      setMessages((current) => appendMessage(current, message))
    }

    function onMembers(payload: { members: Member[] }) {
      setMembers(payload.members)
    }

    function onTyping(payload: { username: string; active: boolean }) {
      setTypingUsers((current) => {
        const without = current.filter((name) => name !== payload.username)
        return payload.active ? [...without, payload.username] : without
      })
    }

    function onRoomCleared() {
  setMessages([])
  clearedRef.current.clear()
  setClearToken((value) => value + 1)
  setNotice('')
}

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on('room:message', onMessage)
    socket.on('room:members', onMembers)
    socket.on('room:typing', onTyping)
    socket.on('room:cleared', onRoomCleared)
    socket.io.on('reconnect_failed', onReconnectFailed)

    setStatus(socket.connected ? 'connected' : 'connecting')
    if (socket.connected) join()
    else socket.connect()

    return () => {
      cancelled = true
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.off('room:message', onMessage)
      socket.off('room:members', onMembers)
      socket.off('room:typing', onTyping)
      socket.off('room:cleared', onRoomCleared)
      socket.io.off('reconnect_failed', onReconnectFailed)
    }
  }, [hydrated, code, username])

  // Stale typing indicators self-heal if a "stop" event is ever lost.
  useEffect(() => {
    if (typingUsers.length === 0) return
    const timer = window.setTimeout(() => setTypingUsers([]), 4000)
    return () => window.clearTimeout(timer)
  }, [typingUsers])

  const handleSend = useCallback((text: string) => {
    getSocket().emit('message:send', { text }, (ack: { ok: boolean; error?: string }) => {
      if (!ack?.ok && ack?.error) setNotice(errorMessage(ack.error, 'Message not delivered.'))
      else setNotice('')
    })
  }, [])

  const handleTyping = useCallback((active: boolean) => {
    getSocket().emit('typing', { active })
  }, [])

  const handleClear = useCallback(() => {
  const socket = getSocket()

  socket.emit(
    'room:clear',
    {},
    (ack: { ok: boolean; error?: string; persistence?: string }) => {
      if (!ack?.ok) {
        setNotice(errorMessage(ack?.error, 'Could not erase chat history.'))
        return
      }

      setNotice('')
      setMessages([])
      clearedRef.current.clear()
      setClearToken((value) => value + 1)
      setSheetOpen(false)
    },
  )
}, [])

  // Manual retry after Socket.IO exhausted its automatic attempts.
  const handleRetry = useCallback(() => {
    setRetryExhausted(false)
    setStatus('connecting')
    setNotice('')
    getSocket().connect()
  }, [])

  const handleLeave = useCallback(() => {
    const socket = getSocket()
    socket.emit('room:leave', {}, () => {
      disposeSocket()
      router.push('/')
    })
    // Fallback in case the ack never arrives.
    window.setTimeout(() => {
      disposeSocket()
      router.push('/')
    }, 600)
  }, [router])

  const visibleMessages = useMemo(
    () => messages.filter((message) => !clearedRef.current.has(message.id)),
    [messages, clearToken],
  )

  if (!hydrated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)]">
        <span className="sc-chip sc-pulse">Establishing session...</span>
      </main>
    )
  }

  return (
    <main className="sc-grid flex h-screen flex-col overflow-hidden">
      <RoomHeader
        code={code}
        status={status}
        memberCount={members.length}
        onClear={handleClear}
        onLeave={handleLeave}
        onToggleMembers={() => setSheetOpen(true)}
        persistence={persistence}
      />

      {retryExhausted ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-[rgba(232,184,75,0.28)] bg-[rgba(232,184,75,0.1)] px-4 py-2 text-[12px] text-[var(--color-warn)] sm:px-6"
        >
          <span>Connection lost.</span>
          <button onClick={handleRetry} className="shrink-0 underline underline-offset-2">
            Retry
          </button>
        </div>
      ) : null}

      {notice ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-[rgba(240,104,92,0.28)] bg-[rgba(240,104,92,0.1)] px-4 py-2 text-[12px] text-[var(--color-danger)] sm:px-6"
        >
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="shrink-0 underline underline-offset-2">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-4 py-2 sm:hidden">
            <ConnectionBadge status={status} />
            <span className="text-[11px] text-[var(--color-faint)]">{members.length} online</span>
          </div>
          <MessageList messages={visibleMessages} selfId={selfId} typing={typingUsers} />
          <Composer disabled={status !== 'connected'} onSend={handleSend} onTyping={handleTyping} />
        </div>
        <MembersSidebar members={members} selfId={selfId} />
      </div>

      <MembersSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        members={members}
        selfId={selfId}
      />
    </main>
  )
}
