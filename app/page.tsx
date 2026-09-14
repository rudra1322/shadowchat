'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Dices, KeyRound, ShieldCheck, Terminal, UserRound } from 'lucide-react'
import {
  formatRoomCode,
  isValidRoomCode,
  looksLikeIpAddress,
  normalizeRoomCode,
} from '@/lib/roomCode'
import { getSocket } from '@/lib/socket'
import { useIdentity } from '@/lib/store'

const FACTS = [
  { label: 'Identifier', value: 'Random code — never your IP' },
  { label: 'Storage', value: 'Temporary — wiped when the room expires' },
  { label: 'Lifetime', value: 'Room dies when empty' },
]

export default function JoinPage() {
  const router = useRouter()
  const storedUsername = useIdentity((state) => state.username)
  const setUsername = useIdentity((state) => state.setUsername)

  const [handle, setHandle] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
    if (storedUsername) setHandle(storedUsername)
  }, [storedUsername])

  const trimmedHandle = handle.trim()
  const normalizedCode = normalizeRoomCode(code)
  const canConnect = trimmedHandle.length >= 2 && isValidRoomCode(normalizedCode)

  const codeHint = useMemo(() => {
    if (normalizedCode.length === 0) return 'Paste a code, or generate one'
    if (normalizedCode.length < 8) return `${8 - normalizedCode.length} more characters`
    return isValidRoomCode(normalizedCode) ? 'Code looks valid' : 'Unsupported characters'
  }, [normalizedCode])

  function handleGenerate() {
  const socket = getSocket()

  setError('')

  const requestCode = () => {
    socket.emit('room:create', {}, (ack: { ok: boolean; code?: string; error?: string }) => {
      if (!ack?.ok || !ack.code) {
        setError(
          ack?.error === 'JOIN_RATE_LIMITED'
            ? 'Too many room attempts. Please wait a moment and try again.'
            : 'Could not generate a room code. Please try again.',
        )
        return
      }

      setCode(ack.code)
    })
  }

  if (socket.connected) {
    requestCode()
  } else {
    socket.connect()
    socket.once('connect', requestCode)
  }
}

  function handleConnect(event: React.FormEvent) {
    event.preventDefault()
    if (trimmedHandle.length < 2) {
      setError('Pick a handle with at least 2 characters.')
      return
    }
    if (!isValidRoomCode(normalizedCode)) {
      setError('Room code must be 8 characters (0-9, A-Z without I, L, O, U).')
      return
    }
    setUsername(trimmedHandle)
    router.push(`/shadowchat/room/${normalizedCode}`)
  }

  return (
    <main className="sc-grid relative min-h-screen overflow-hidden">
      <div className="sc-glow sc-scan pointer-events-none absolute inset-0" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-[1080px] flex-col px-6 py-7">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-[9px] border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Terminal className="size-4" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              Shadow<span className="text-[var(--color-accent)]">Chat</span>
            </span>
          </div>
          <span className="sc-chip">v0.1 · ephemeral</span>
        </header>

        <div className="flex flex-1 items-center py-10">
          <div className="grid w-full gap-10 md:grid-cols-[minmax(0,1fr)_400px] md:items-center">
            <section className="sc-rise">
              <p className="sc-label">Temporary rooms · zero accounts</p>
              <h1 className="mt-4 text-[34px] font-semibold leading-[1.12] tracking-tight sm:text-[42px]">
                Spin up a private room.
                <br />
                <span className="text-[var(--color-muted)]">Share the code. Talk. Vanish.</span>
                <span className="sc-caret ml-1 text-[var(--color-accent)]">_</span>
              </h1>
              <p className="mt-5 max-w-[46ch] text-[15px] leading-7 text-[var(--color-muted)]">
                ShadowChat rooms are addressed by a cryptographically random code, not by your
                network address. Recent messages are held in temporary PostgreSQL storage so a
                backend restart does not lose your room, and everything is deleted when the room
                expires.
              </p>

              <dl className="mt-8 grid gap-3 sm:grid-cols-3">
                {FACTS.map((fact) => (
                  <div key={fact.label} className="sc-card p-3.5">
                    <dt className="sc-label">{fact.label}</dt>
                    <dd className="mt-1.5 text-[13px] leading-5 text-[var(--color-text)]">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="sc-card sc-rise p-5 sm:p-6">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-[var(--color-accent)]" />
                <h2 className="text-[15px] font-semibold">Connect to a room</h2>
              </div>

              <form onSubmit={handleConnect} className="mt-5 flex flex-col gap-4" noValidate>
                <label className="flex flex-col gap-2">
                  <span className="sc-label">Handle</span>
                  <span className="relative block">
                    <UserRound className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-faint)]" />
                    <input
                      className="sc-field pl-10"
                      value={handle}
                      onChange={(event) => {
                        setHandle(event.target.value.slice(0, 24))
                        setError('')
                      }}
                      placeholder="ghost_shell"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={24}
                      aria-describedby="handle-hint"
                    />
                  </span>
                  <span id="handle-hint" className="text-[11px] text-[var(--color-faint)]">
                    2–24 characters. Not verified — handles are cosmetic.
                  </span>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="sc-label">Room code</span>
                  <span className="relative block">
                    <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-faint)]" />
                    <input
                      className="sc-field pl-10 pr-[112px] font-[family-name:var(--font-mono)] tracking-[0.24em] uppercase"
                      value={formatRoomCode(code)}
                      onChange={(event) => {
                        const raw = event.target.value
                        setCode(normalizeRoomCode(raw))
                        // Reject network addresses before separators get stripped,
                        // otherwise "49.36.221.104" would collapse into a valid code.
                        setError(
                          looksLikeIpAddress(raw)
                            ? 'ShadowChat rooms are not addressed by IP. Use a generated room code.'
                            : '',
                        )
                      }}
                      placeholder="K7QF-2M9X"
                      autoComplete="off"
                      spellCheck={false}
                      inputMode="text"
                      aria-describedby="code-hint"
                    />
                    <button
                      type="button"
                      onClick={handleGenerate}
                      className="sc-btn sc-btn-ghost absolute right-1.5 top-1/2 h-9 -translate-y-1/2 px-2.5 text-[12px]"
                    >
                      <Dices className="size-3.5" />
                      Generate
                    </button>
                  </span>
                  <span id="code-hint" className="text-[11px] text-[var(--color-faint)]">
                    {codeHint}
                  </span>
                </label>

                {error ? (
                  <p
                    role="alert"
                    className="rounded-[9px] border border-[rgba(240,104,92,0.32)] bg-[rgba(240,104,92,0.1)] px-3 py-2.5 text-[12px] leading-5 text-[var(--color-danger)]"
                  >
                    {error}
                  </p>
                ) : null}

                <button type="submit" className="sc-btn sc-btn-primary w-full" disabled={!hydrated || !canConnect}>
                  Connect
                  <ArrowRight className="size-4" />
                </button>
              </form>

              <p className="mt-4 border-t border-[var(--color-line)] pt-4 text-[11px] leading-5 text-[var(--color-faint)]">
                Anyone holding the code can enter the room. Treat it like a password and share it
                over a channel you already trust.
              </p>
            </section>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] pt-5 text-[11px] text-[var(--color-faint)]">
          <span>College security project · original implementation</span>
          <span className="font-[family-name:var(--font-mono)]">40-bit room entropy · temporary storage, deleted on expiry</span>
        </footer>
      </div>
    </main>
  )
}
