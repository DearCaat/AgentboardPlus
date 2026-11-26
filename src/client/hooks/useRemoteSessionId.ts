import { useState } from 'react'
import type { Session } from '@shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { useSessionOrganizationStore } from '../stores/sessionOrganizationStore'

export function useRemoteSessionId(session: Session | null) {
  const key = session ? JSON.stringify([session.id, session.createdAt]) : undefined
  const [feedback, setFeedback] = useState<{ key: string; pending: boolean; error?: string }>()
  const active = feedback?.key === key ? feedback : undefined

  async function save(input: { conversationId: string } | { source: 'codex-status' }) {
    const profileId = useSessionOrganizationStore.getState().profileId
    if (!session?.remote || !session.agentType || !key || !profileId || active?.pending) return
    setFeedback({ key, pending: true })
    try {
      const response = await fetch('/api/workspace/session-conversation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-AgentBoard-Profile': profileId },
        body: JSON.stringify({ id: session.id, createdAt: session.createdAt, ...input }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Could not save session ID')
      if (useSessionOrganizationStore.getState().profileId === profileId) useSessionStore.getState().updateSession(data)
      setFeedback((current) => current?.key === key ? undefined : current)
    } catch (error) {
      setFeedback((current) => current?.key === key
        ? { key, pending: false, error: error instanceof Error ? error.message : 'Could not save session ID' }
        : current)
    }
  }

  return { save, error: active?.error, pending: active?.pending ?? false }
}
