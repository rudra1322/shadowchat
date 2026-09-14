'use client'

import { Check, Copy, Eraser, LogOut, Terminal, Users } from 'lucide-react'
import { useState } from 'react'
import { formatRoomCode } from '@/lib/roomCode'
import type { ConnectionStatus } from '@/lib/types'

const STATUS_META: Record<ConnectionStatus, { text: string; color: string; pulse: boolean }> = {
  idle: { text: 'Idle', color: 'var(--color-faint)', pulse: false },
  connecting: { text: 'Connecting', color: 'var(--color-warn)', pulse: true },
  // "Secure" implied E2EE, which this app does not do. The socket is TLS when
  // deployed behind HTTPS, but the server still processes plaintext.
  connected: { text: 'TLS Connected', color: 'var(--color-accent)', pulse: false },
  reconnecting: { text: 'Reconnecting', color: 'var(--color-warn)', pulse: true },
  error: { text: 'Offline', color: 'var(--color-danger)', pulse: false },
}

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const meta = STATUS_META[status]
  return (
    <span className="sc-chip" role="status" aria-live="polite">
      <span
        className={`sc-dot ${meta.pulse ? 'sc-pulse' : ''}`}
        style={{ background: meta.color, boxShadow: `0 0 8px ${meta.color}` }}
      />
      {meta.text}
    </span>
  )
}

/**
 * Shown only while the server reports degraded persistence. Deliberately
 * low-key: live messaging is unaffected, and nothing is known to be lost.
 */
export function PersistenceBadge({ persistence }: { persistence?: string | null }) {
  if (persistence !== 'degraded') return null
  return (
    <span
      className="sc-chip"
      role="status"
      aria-live="polite"
      title="Recent messages may not be saved for restart recovery. Chat is unaffected."
    >
      <span className="sc-dot" style={{ background: 'var(--color-warn)' }} />
      Persistence temporarily degraded
    </span>
  )
}

export function RoomHeader({
  code,
  status,
  memberCount,
  onClear,
  onLeave,
  onToggleMembers,
  persistence,
}: {
  code: string
  status: ConnectionStatus
  memberCount: number
  onClear: () => void
  onLeave: () => void
  onToggleMembers: () => void
  persistence?: string | null
}) {
  const [copied, setCopied] = useState(false)

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(formatRoomCode(code))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[rgba(8,9,11,0.72)] px-4 backdrop-blur-xl sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Terminal className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-tight tracking-tight">
            Shadow<span className="text-[var(--color-accent)]">Chat</span>
          </p>
          <button
            onClick={copyCode}
            className="group mt-0.5 flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[12px] tracking-[0.14em] text-[var(--color-muted)] transition hover:text-[var(--color-text)]"
            aria-label={`Copy room code ${formatRoomCode(code)}`}
          >
            {formatRoomCode(code)}
            {copied ? (
              <Check className="size-3 text-[var(--color-accent)]" />
            ) : (
              <Copy className="size-3 opacity-0 transition group-hover:opacity-100" />
            )}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="hidden md:inline-flex">
          <PersistenceBadge persistence={persistence} />
        </span>
        <span className="hidden sm:inline-flex">
          <ConnectionBadge status={status} />
        </span>
        <button onClick={onClear} className="sc-icon-btn" aria-label="Clear my view of the chat" title="Clear my view">
          <Eraser className="size-4" />
        </button>
        <button
          onClick={onToggleMembers}
          className="sc-icon-btn relative xl:hidden"
          aria-label={`Show members (${memberCount} online)`}
        >
          <Users className="size-4" />
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold text-[#04150e]">
            {memberCount}
          </span>
        </button>
        <button
          onClick={onLeave}
          className="sc-btn sc-btn-ghost h-10 px-3 text-[13px] text-[var(--color-danger)] hover:border-[rgba(240,104,92,0.4)] hover:bg-[rgba(240,104,92,0.1)] hover:text-[var(--color-danger)]"
        >
          <LogOut className="size-4" />
          <span className="hidden sm:inline">Leave</span>
        </button>
      </div>
    </header>
  )
}
