'use client'

import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'

const MAX_LENGTH = 2000

export function Composer({
  disabled,
  onSend,
  onTyping,
}: {
  disabled: boolean
  onSend: (text: string) => void
  onTyping: (active: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const typingRef = useRef<number | null>(null)

  // Grow the textarea up to a ceiling instead of scrolling a one-line box.
  useEffect(() => {
    const node = areaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`
  }, [draft])

  useEffect(() => {
    return () => {
      if (typingRef.current) window.clearTimeout(typingRef.current)
    }
  }, [])

  function signalTyping() {
    onTyping(true)
    if (typingRef.current) window.clearTimeout(typingRef.current)
    typingRef.current = window.setTimeout(() => onTyping(false), 1800)
  }

  function submit() {
    const text = draft.trim()
    if (!text || disabled) return
    onSend(text)
    setDraft('')
    onTyping(false)
    if (typingRef.current) window.clearTimeout(typingRef.current)
  }

  const remaining = MAX_LENGTH - draft.length

  return (
    <div className="shrink-0 border-t border-[var(--color-line)] bg-[rgba(8,9,11,0.72)] px-4 py-3.5 backdrop-blur-xl sm:px-6">
      <div className="mx-auto max-w-[720px]">
        <div className="flex items-end gap-2 rounded-[11px] border border-[var(--color-line)] bg-[var(--color-surface)] p-2 transition focus-within:border-[var(--color-accent-line)]">
          <span aria-hidden="true" className="pb-2.5 pl-1.5 font-[family-name:var(--font-mono)] text-[13px] text-[var(--color-accent)]">
            &gt;
          </span>
          <textarea
            ref={areaRef}
            value={draft}
            disabled={disabled}
            onChange={(event) => {
              setDraft(event.target.value.slice(0, MAX_LENGTH))
              signalTyping()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
            rows={1}
            aria-label="Message"
            placeholder={disabled ? 'Reconnecting…' : 'Type a message'}
            className="sc-scroll max-h-[140px] min-h-[26px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-6 outline-none placeholder:text-[var(--color-faint)] disabled:opacity-50"
          />
          <button
            onClick={submit}
            disabled={disabled || draft.trim().length === 0}
            aria-label="Send message"
            className="flex size-10 shrink-0 items-center justify-center rounded-[9px] bg-[var(--color-accent)] text-[#04150e] transition hover:bg-[#48f0b6] disabled:bg-[var(--color-raised)] disabled:text-[var(--color-faint)]"
          >
            <Send className="size-4" />
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between px-1 text-[10.5px] text-[var(--color-faint)]">
          <span>Enter to send · Shift + Enter for a new line</span>
          <span className={remaining < 120 ? 'text-[var(--color-warn)]' : ''}>
            {remaining < 200 ? `${remaining} left` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
