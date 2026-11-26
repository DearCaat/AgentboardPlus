import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@shared/types'
import { useTranslation } from '../locale'

type WorkspaceInfo = { hosts: string[]; canAddRemoteHosts: boolean; localAllowed?: boolean }
type ImageUploadCheck = 'passed' | 'failed' | 'skipped'

const serverCheckMessages: Record<ImageUploadCheck, string> = {
  passed: 'Server added. SSH, tmux, and image upload checks passed.',
  failed: 'Server added. SSH and tmux checks passed, but the image upload check failed.',
  skipped: 'Server added. SSH and tmux checks passed. Image upload requires interactive SSH access.',
}

interface WorkspaceDialogProps {
  initialHost?: string
  onClose: () => void
  onAgentSession: () => void
  onManageTokens?: () => void
  onCreated: (session: Session) => void
}

export default function WorkspaceDialog({
  initialHost = '', onClose, onAgentSession, onManageTokens, onCreated,
}: WorkspaceDialogProps) {
  const t = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'terminal' | 'server'>('terminal')
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [host, setHost] = useState(initialHost)
  const [alias, setAlias] = useState('')
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState('')
  const [serverCheck, setServerCheck] = useState<ImageUploadCheck | 'existing' | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    dialog.current?.showModal()
    const controller = new AbortController()
    fetch('/api/workspace', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load servers')
        const info = await response.json() as WorkspaceInfo
        setWorkspace(info)
        setHost((current) => info.hosts.includes(current) ? current : info.localAllowed === false ? (info.hosts[0] ?? '') : '')
      })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load servers') })
    return () => controller.abort()
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError('')
    const adding = mode === 'server'
    try {
      const response = await fetch(adding ? '/api/workspace/hosts' : '/api/workspace/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adding ? { host: alias } : { host, name, directory }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Request failed')
      if (adding) {
        setServerCheck(result.imageUpload ?? 'existing')
        const infoResponse = await fetch('/api/workspace')
        if (!infoResponse.ok) throw new Error('Server added. Reopen this dialog to refresh the list.')
        const info = await infoResponse.json() as WorkspaceInfo
        setWorkspace(info)
        setHost(info.hosts.includes(result.host) ? result.host : '')
        setAlias('')
        setMode('terminal')
      } else {
        onCreated(result as Session)
        onClose()
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Request failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="workspace-title"
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-lg border border-border bg-elevated p-0 text-primary backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); if (!pending) onClose() }}
    >
      <form onSubmit={submit} className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="workspace-title" className="font-semibold">{mode === 'terminal' ? t('New Terminal') : t('Add Server')}</h2>
          <div className="flex gap-1">
            {workspace?.canAddRemoteHosts && (
              <button type="button" className="btn text-xs" disabled={pending} onClick={() => {
                setError('')
                setServerCheck(null)
                setMode(mode === 'terminal' ? 'server' : 'terminal')
              }}>
                {mode === 'terminal' ? t('Add Server') : t('New Terminal')}
              </button>
            )}
            {workspace?.localAllowed !== false && (
              <button type="button" className="btn text-xs" disabled={pending} onClick={onAgentSession}>{t('Agent Session')}</button>
            )}
            {onManageTokens && (
              <button type="button" className="btn text-xs" disabled={pending} onClick={onManageTokens}>{t('Tokens')}</button>
            )}
          </div>
        </div>
        {mode === 'server' ? (
          <label className="block text-sm">
            {t('SSH alias or hostname')}
            <input value={alias} onChange={(event) => setAlias(event.target.value)} className="input mt-1 w-full" placeholder="compute-01" required />
          </label>
        ) : (
          <>
            <label className="block text-sm">
              {t('Server')}
              <select aria-label={t('Server')} value={host} onChange={(event) => setHost(event.target.value)} className="input mt-1 w-full">
                {workspace?.localAllowed !== false && <option value="">{t('Local')}</option>}
                {workspace?.hosts.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              {t('tmux session name')}
              <input value={name} onChange={(event) => setName(event.target.value)} className="input mt-1 w-full" placeholder="my-work" maxLength={80} required />
            </label>
            <label className="block text-sm text-secondary">
              {t('Starting directory (optional)')}
              <input value={directory} onChange={(event) => setDirectory(event.target.value)} className="input mt-1 w-full" placeholder="/path/to/project" />
            </label>
          </>
        )}
        {serverCheck && (
          <p role="status" className="text-sm text-secondary">
            {t(serverCheck === 'existing' ? 'Server already added.' : serverCheckMessages[serverCheck])}
          </p>
        )}
        {error && <p role="alert" className="break-words text-sm text-secondary">{t(error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={pending || !workspace || (workspace.localAllowed === false && !host)}>
            {mode === 'server' ? (pending ? t('Checking server…') : t('Add Server')) : (pending ? t('Working…') : t('Create Terminal'))}
          </button>
        </div>
      </form>
    </dialog>
  )
}
