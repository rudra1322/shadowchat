'use client'

import { useEffect, useRef } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { ChatMessage } from '@/lib/types'
import { formatTime } from '@/lib/utils'
import { Avatar } from './Avatar'

function SystemLine({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1">
      <span className="h-px flex-1 bg-[var(--color-line)]" />
      <span className="font-[family-name:var(--font-mono)] text-[11px] tracking-[0.08em] text-[var(--color-faint)]">
        {text}
      </span>
      <span className="h-px flex-1 bg-[var(--color-line)]" />
    </div>
  )
}

function Bubble({ message, own, grouped }: { message: ChatMessage; own: boolean; grouped: boolean }) {
  const name = message.username ?? 'unknown'
  return (
    <div className={`sc-rise flex gap-2.5 ${own ? 'flex-row-reverse' : ''}`}>
      <span className="w-8 shrink-0">{grouped ? null : <Avatar name={name} />}</span>
      <div className={`flex min-w-0 max-w-[min(76%,560px)] flex-col gap-1 ${own ? 'items-end' : 'items-start'}`}>
        {grouped ? null : (
          <div className="flex items-baseline gap-2 px-0.5">
            <span className="font-[family-name:var(--font-mono)] text-[12px] font-medium text-[var(--color-text)]">
              {own ? 'you' : name}
            </span>
            <span className="text-[10px] text-[var(--color-faint)]">{formatTime(message.at)}</span>
          </div>
        )}
        <div
          className={
            own
              ? 'rounded-[11px] rounded-tr-[4px] border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] px-3.5 py-2.5 text-[14px] leading-6 whitespace-pre-wrap break-words'
              : 'rounded-[11px] rounded-tl-[4px] border border-[var(--color-line)] bg-[var(--color-raised)] px-3.5 py-2.5 text-[14px] leading-6 whitespace-pre-wrap break-words'
          }
        >
          {message.text}
        </div>
      </div>
    </div>
  )
}

export function MessageList({
  messages,
  selfId,
  typing,
}: {
  messages: ChatMessage[]
  selfId: string | null
  typing: string[]
}) {
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, typing.length])

  return (
    <div className="sc-scroll flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      {/* justify-end keeps the conversation anchored to the composer when short */}
      <div className="mx-auto flex min-h-full max-w-[720px] flex-col justify-end gap-3">
        <div className="mb-1 flex items-center justify-center gap-2 rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 text-[11px] leading-5 text-[var(--color-muted)]">
          <ShieldCheck className="size-3.5 shrink-0 text-[var(--color-accent)]" />
          Ephemeral room. Messages are held in server memory and dropped when the room empties.
        </div>

        {messages.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-[var(--color-faint)]">
            No messages yet. Say something.
          </p>
        ) : null}

        {messages.map((message, index) => {
          if (message.kind === 'system') {
            return <SystemLine key={message.id} text={message.text} />
          }
          const previous = messages[index - 1]
          const grouped =
            previous?.kind === 'chat' &&
            previous.authorId === message.authorId &&
            message.at - previous.at < 120_000
          return (
            <Bubble
              key={message.id}
              message={message}
              own={Boolean(selfId) && message.authorId === selfId}
              grouped={Boolean(grouped)}
            />
          )
        })}

        {typing.length > 0 ? (
          <div className="flex items-center gap-2 px-1 py-1 text-[11px] text-[var(--color-faint)]">
            <span className="sc-dot sc-pulse" style={{ background: 'var(--color-accent)' }} />
            {typing.length === 1 ? `${typing[0]} is typing` : `${typing.length} people are typing`}
          </div>
        ) : null}

        <div ref={endRef} />
      </div>
    </div>
  )
}
