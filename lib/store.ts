import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type IdentityState = {
  username: string
  setUsername: (username: string) => void
}

/** Only the chosen handle survives a reload. Messages are never persisted. */
export const useIdentity = create<IdentityState>()(
  persist(
    (set) => ({
      username: '',
      setUsername: (username) => set({ username: username.slice(0, 24) }),
    }),
    { name: 'shadowchat.identity' },
  ),
)
