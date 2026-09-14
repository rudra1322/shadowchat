export type Member = {
  id: string
  username: string
  joinedAt: number
}

export type ChatMessage = {
  id: string
  kind: 'chat' | 'system'
  text: string
  username: string | null
  authorId?: string
  at: number
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

export type JoinAck =
  | {
      ok: true
      code: string
      username: string
      selfId: string
      members: Member[]
      messages: ChatMessage[]
      persistence?: 'postgres' | 'degraded' | 'off'
    }
  | { ok: false; error: string }