import { useEffect, useState, type FormEvent } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useTranslation } from '../locale'

interface SessionAccess {
  grantId: string | null
  grants: Array<{ id: string; label: string }>
}

const endpoint = '/api/workspace/session-owner'

export default function SessionAccessForm() {
  const t = useTranslation()
  const sessions = useSessionStore(state => state.sessions)
  const [sessionId, setSessionId] = useState('')
  const [access, setAccess] = useState<SessionAccess>()
  const [grantId, setGrantId] = useState('')
  const [feedback, setFeedback] = useState('')
  const [saving, setSaving] = useState(false)
  const listedSessions = new Set<string>()
  const remoteSessions = sessions.filter(session => {
    if (!session.remote || !session.host || session.source !== 'external') return false
    const key = session.host + '/' + session.tmuxWindow.slice(0, session.tmuxWindow.lastIndexOf(':'))
    if (listedSessions.has(key)) return false
    listedSessions.add(key)
    return true
  })
  const activeId = remoteSessions.find(session => session.id === sessionId)?.id ?? ''

  useEffect(() => {
    setAccess(undefined)
    setFeedback('')
    if (!activeId) return
    const request = new AbortController()
    void (async () => {
      try {
        const response = await fetch(endpoint + '?' + new URLSearchParams({ sessionId: activeId }), {
          cache: 'no-store', signal: request.signal,
        })
        if (!response.ok) throw new Error('Could not load session access')
        const current: SessionAccess = await response.json()
        if (request.signal.aborted) return
        setAccess(current)
        setGrantId(current.grants.some(grant => grant.id === current.grantId) ? current.grantId! : '')
      } catch {
        if (!request.signal.aborted) setFeedback('Could not load session access')
      }
    })()
    return () => request.abort()
  }, [activeId])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!activeId || !access) return
    setSaving(true)
    setFeedback('')
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeId, grantId: grantId || null }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save session access')
      setAccess({ ...access, grantId: grantId || null })
      setFeedback('Session access saved')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not save session access')
    } finally {
      setSaving(false)
    }
  }

  if (!remoteSessions.length) return null
  return (
    <form className="space-y-2 border-t border-border pt-3" onSubmit={save}>
      <h3 className="text-sm font-semibold">{t('Session access')}</h3>
      <label className="block text-sm">
        {t('Remote tmux session')}
        <select className="input mt-1 w-full" value={activeId} disabled={saving}
          onChange={event => setSessionId(event.target.value)}>
          <option value="">{t('Choose a session')}</option>
          {remoteSessions.map(session => (
            <option key={session.id} value={session.id}>
              {session.host} / {session.tmuxWindow.slice(0, session.tmuxWindow.lastIndexOf(':'))}
            </option>
          ))}
        </select>
      </label>
      {access && (
        <label className="block text-sm">
          {t('Shared token')}
          <select className="input mt-1 w-full" value={grantId} disabled={saving}
            onChange={event => setGrantId(event.target.value)}>
            <option value="">{t('Administrator only')}</option>
            {access.grants.map(grant => <option key={grant.id} value={grant.id}>{grant.label}</option>)}
          </select>
        </label>
      )}
      {access && <button type="submit" className="btn" disabled={saving || (grantId || null) === access.grantId}>{t('Save session access')}</button>}
      {feedback && <p className="text-sm text-secondary" role="status">{feedback}</p>}
    </form>
  )
}
