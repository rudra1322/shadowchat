'use client'

import { X } from 'lucide-react'
import type { Member } from '@/lib/types'
import { Avatar } from './Avatar'

function MemberRows({ members, selfId }: { members: Member[]; selfId: string | null }) {
  return (
    <ul className="flex flex-col gap-1">
      {members.map((member) => {
        const isSelf = member.id === selfId
        return (
          <li
            key={member.id}
            className="flex items-center gap-2.5 rounded-[9px] px-2 py-2 transition hover:bg-[var(--color-hover)]"
          >
            <Avatar name={member.username} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-[family-name:var(--font-mono)] text-[13px]">
                {member.username}
                {isSelf ? <span className="ml-1.5 text-[var(--color-faint)]">(you)</span> : null}
              </span>
            </span>
            <span
              className="sc-dot"
              style={{ background: 'var(--color-accent)', boxShadow: '0 0 8px var(--color-accent)' }}
              aria-label="online"
            />
          </li>
        )
      })}
    </ul>
  )
}

function PanelBody({ members, selfId }: { members: Member[]; selfId: string | null }) {
  return (
    <>
      <div className="flex items-center justify-between px-2 pb-3">
        <span className="sc-label">In this room</span>
        <span className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--color-accent)]">
          {members.length}
        </span>
      </div>
      <MemberRows members={members} selfId={selfId} />
      <p className="mt-4 border-t border-[var(--color-line)] px-2 pt-4 text-[11px] leading-5 text-[var(--color-faint)]">
        Presence is live. Leaving or closing the tab removes you immediately.
      </p>
    </>
  )
}

/** Fixed sidebar on wide screens. */
export function MembersSidebar({ members, selfId }: { members: Member[]; selfId: string | null }) {
  return (
    <aside className="sc-scroll hidden w-[248px] shrink-0 overflow-y-auto border-l border-[var(--color-line)] bg-[rgba(16,18,22,0.5)] p-3 xl:block">
      <PanelBody members={members} selfId={selfId} />
    </aside>
  )
}

/** Bottom sheet on narrow screens. */
export function MembersSheet({
  open,
  onClose,
  members,
  selfId,
}: {
  open: boolean
  onClose: () => void
  members: Member[]
  selfId: string | null
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-[rgba(8,9,11,0.7)] backdrop-blur-sm xl:hidden">
      <button className="flex-1" onClick={onClose} aria-label="Close members panel" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Room members"
        className="sc-rise sc-scroll max-h-[70vh] overflow-y-auto rounded-t-[16px] border-t border-[var(--color-line-strong)] bg-[var(--color-surface)] p-4 pb-6"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[14px] font-semibold">Members</span>
          <button onClick={onClose} className="sc-icon-btn" aria-label="Close members panel">
            <X className="size-4" />
          </button>
        </div>
        <PanelBody members={members} selfId={selfId} />
      </div>
    </div>
  )
}
