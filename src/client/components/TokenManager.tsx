import { useEffect, useRef, useState, type FormEvent } from 'react'
import SessionAccessForm from './SessionAccessForm'
import { translateServerError, useLocale, useTranslation } from '../locale'

interface Grant {
  id: string
  label: string
  hosts: string[]
  createdAt: string
  revokedAt?: string
}
interface GrantList { hosts: string[]; grants: Grant[] }

export default function TokenManager({ onClose }: { onClose: () => void }) {
  const t = useTranslation()
  const locale = useLocale((s) => s.locale)
  const dialog = useRef<HTMLDialogElement>(null)
  const [data, setData] = useState<GrantList>()
  const [label, setLabel] = useState('')
  const [hosts, setHosts] = useState<string[]>([])
  const [editing, setEditing] = useState<string>()
  const [revoke, setRevoke] = useState<Grant>()
  const [newToken, setNewToken] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const response = await fetch('/api/access/grants', { cache: 'no-store' })
    if (!response.ok) throw new Error('Could not load access tokens')
    setData(await response.json() as GrantList)
  }

  useEffect(() => {
    dialog.current?.showModal()
    void refresh().catch(() => setFeedback('Could not load access tokens'))
  }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFeedback('')
    try {
      const response = await fetch(editing ? '/api/access/grants/' + editing : '/api/access/grants', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, hosts }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save access token')
      setNewToken(result.token || '')
      setEditing(undefined)
      setLabel('')
      setHosts([])
      await refresh()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not save access token')
    } finally {
      setBusy(false)
    }
  }

  async function revokeToken() {
    if (!revoke) return
    setBusy(true)
    setFeedback('')
    try {
      const response = await fetch('/api/access/grants/' + revoke.id, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not revoke access token')
      if (editing === revoke.id) {
        setEditing(undefined)
        setLabel('')
        setHosts([])
      }
      setRevoke(undefined)
      setNewToken('')
      await refresh()
    } catch {
      setFeedback('Could not revoke access token')
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="tokens-title"
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg border border-border bg-elevated p-0 text-primary backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h2 id="tokens-title" className="font-semibold">{t('Access Tokens')}</h2>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Close')}</button>
        </div>
        {newToken && (
          <div className="space-y-2 rounded border border-border p-3">
            <label className="block text-sm">
              {t('Copy this token now. It is shown once.')}
              <input aria-label={t('New access token')} className="input mt-1 w-full font-mono" readOnly value={newToken} onFocus={(event) => event.target.select()} />
            </label>
            <button type="button" className="btn" onClick={() => {
              void navigator.clipboard.writeText(newToken).then(() => setFeedback('Token copied'),
                () => setFeedback('Select and copy the token from the field'))
            }}>{t('Copy token')}</button>
          </div>
        )}
        <form onSubmit={save} className="space-y-3">
          <label className="block text-sm">
            {t('Token name')}
            <input className="input mt-1 w-full" value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={80} />
          </label>
          <fieldset className="flex flex-wrap gap-3 text-sm">
            <legend className="mb-2">{t('Allowed servers')}</legend>
            {data?.hosts.map((host) => (
              <label key={host} className="flex items-center gap-1.5">
                <input type="checkbox" checked={hosts.includes(host)} onChange={(event) => {
                  const checked = event.target.checked
                  setHosts(current => checked ? [...current, host] : current.filter(entry => entry !== host))
                }} />
                {host}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={busy || !label.trim() || !hosts.length}>
              {editing ? t('Save access') : t('Create token')}
            </button>
            {editing && <button type="button" className="btn" onClick={() => {
              setEditing(undefined)
              setLabel('')
              setHosts([])
            }}>{t('Cancel edit')}</button>}
          </div>
        </form>
        {feedback && <p role="status" className="text-sm text-secondary">{translateServerError(locale, feedback)}</p>}
        {data?.grants.length ? (
          <ul className="divide-y divide-border border-t border-border">
            {data.grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 break-words">
                  <strong>{grant.label}</strong>
                  <span className="block text-xs text-secondary">{grant.hosts.join(', ')}</span>
                </span>
                {grant.revokedAt ? <span className="text-xs text-secondary">{t('Revoked')}</span> : (
                  <span className="flex gap-1">
                    <button type="button" className="btn text-xs" disabled={busy} onClick={() => {
                      setEditing(grant.id)
                      setLabel(grant.label)
                      setHosts(grant.hosts)
                      setRevoke(undefined)
                      setNewToken('')
                    }}>{t('Edit access')}</button>
                    <button type="button" className="btn text-xs" disabled={busy} onClick={() => setRevoke(grant)}>{t('Revoke')}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        <SessionAccessForm />
        {revoke && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
            <p>{t('Revoke {name} and disconnect its open terminals?', { name: revoke.label })}</p>
            <button type="button" className="btn" onClick={() => setRevoke(undefined)} disabled={busy}>{t('Cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={() => void revokeToken()} disabled={busy}>{t('Revoke token')}</button>
          </div>
        )}
      </div>
    </dialog>
  )
}
