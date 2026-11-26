import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AgentType, Session } from '@shared/types'
import { getSessionDisplayName, useSessionOrganizationStore, type WorkspaceView } from '../stores/sessionOrganizationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTranslation } from '../locale'

const endpoint = '/api/workspace/presets'
const harnesses: ReadonlyArray<[AgentType, string]> = [
  ['codex', 'Codex'], ['claude', 'Claude Code'], ['claude-rp', 'Claude RP'],
  ['grok', 'Grok'], ['devin', 'Devin'], ['pi', 'Pi'], ['omp', 'OMP'], ['antigravity', 'Antigravity'],
]

interface Preset {
  id: string
  name: string
  count: number
}

interface TerminalSelection {
  id: string
  included: boolean
  harness: AgentType | ''
  conversationId: string
}

interface RestoreResult extends WorkspaceView {
  results: Array<{ label: string; state?: 'attached' | 'started'; error?: string }>
}

export default function WorkspacePresets({
  profileId, sessions, onClose,
}: {
  profileId: string
  sessions: Session[]
  onClose: () => void
}) {
  const t = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const organization = useSessionOrganizationStore(state => state.organization)
  const workspaceId = useSessionOrganizationStore(state => state.workspace.id)
  const [presets, setPresets] = useState<Preset[]>([])
  const [mode, setMode] = useState<'load' | 'save'>('load')
  const [editing, setEditing] = useState<Preset>()
  const [deleting, setDeleting] = useState<string>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState('')
  const [results, setResults] = useState<RestoreResult['results']>()
  const [selections, setSelections] = useState<TerminalSelection[]>([])

  async function request(path: string, options?: RequestInit) {
    const response = await fetch(endpoint + path, {
      ...options, cache: 'no-store', headers: {
        'X-AgentBoard-Profile': profileId,
        ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Preset request failed')
    return data
  }

  useEffect(() => {
    dialog.current?.showModal()
    void request('').then((saved: Preset[]) => {
      setPresets(saved)
      if (!saved.length) editPreset()
    }).catch(() => setFeedback('Could not load presets'))
  }, [profileId])

  function updateSelection(id: string, patch: Partial<TerminalSelection>) {
    setSelections(current => current.map(item => item.id === id ? { ...item, ...patch } : item))
  }

  function showPresets() {
    setEditing(undefined)
    setDeleting(undefined)
    setResults(undefined)
    setFeedback('')
    setMode('load')
  }

  function editPreset(preset?: Preset) {
    setEditing(preset)
    setDeleting(undefined)
    setName(preset?.name ?? '')
    setSelections(sessions.map(session => ({
      id: session.id, included: true, harness: session.agentType ?? '',
      conversationId: session.agentSessionId ?? '',
    })))
    setResults(undefined)
    setFeedback('')
    setMode('save')
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setFeedback('')
    setBusy(editing ? 'Updating…' : 'Saving…')
    setResults(undefined)
    try {
      const layout = {
        ...organization,
        groups: organization.groups.map(group => {
          const members = sessions.filter(session => organization.sessions[session.id]?.groupId === group.id)
          return { ...group, sessionOrder: [...new Set([...(group.sessionOrder ?? []), ...members.map(session => session.id)])] }
        }),
      }
      const preset: Preset = await request(editing ? '/' + encodeURIComponent(editing.id) : '', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({
          name, organization: layout,
          terminals: selections.filter(item => item.included).map(item => ({
            id: item.id, harness: item.harness || undefined,
            conversationId: item.harness ? item.conversationId.trim() || undefined : undefined,
          })),
        }),
      })
      setPresets(current => editing ? current.map(entry => entry.id === preset.id ? preset : entry) : [...current, preset])
      showPresets()
      setFeedback((editing ? 'Updated ' : 'Saved ') + preset.name)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not save preset')
    } finally {
      setBusy('')
    }
  }

  async function deletePreset(preset: Preset) {
    setFeedback('')
    setResults(undefined)
    setBusy('Deleting ' + preset.name + '…')
    try {
      await request('/' + encodeURIComponent(preset.id), { method: 'DELETE' })
      setPresets(current => current.filter(entry => entry.id !== preset.id))
      setDeleting(undefined)
      setFeedback('Deleted ' + preset.name)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not delete preset')
    } finally {
      setBusy('')
    }
  }

  async function openPreset(preset: Preset, action: 'load' | 'restore') {
    setDeleting(undefined)
    setFeedback('')
    setResults(undefined)
    setBusy((action === 'load' ? 'Loading ' : 'Restoring ') + preset.name + '…')
    try {
      await useSessionOrganizationStore.getState().finishSaving()
      const view = await request('/' + preset.id + '/' + action, { method: 'POST' })
      if (useSessionOrganizationStore.getState().profileId !== profileId) return
      useSessionOrganizationStore.getState().applyWorkspace(view)
      if (action === 'load') {
        setFeedback('Loaded ' + preset.name)
        return
      }
      const restored: RestoreResult = view
      const catalog = await fetch('/api/sessions', { cache: 'no-store' }).catch(() => undefined)
      if (catalog?.ok && useSessionOrganizationStore.getState().profileId === profileId) {
        useSessionStore.getState().setSessions(await catalog.json())
      }
      setResults(restored.results)
      const started = restored.results.filter(result => result.state === 'started').length
      setFeedback('Started ' + started + ' missing sessions')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Preset request failed')
    } finally {
      setBusy('')
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="presets-title"
      className="m-auto max-h-[86dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-lg border border-border bg-elevated p-4 text-primary backdrop:bg-black/60"
      onCancel={event => { event.preventDefault(); if (!busy) onClose() }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="presets-title" className="font-semibold">{t('Workspace presets')}</h2>
        <button type="button" className="btn" disabled={!!busy} onClick={onClose}>{t('Close')}</button>
      </div>
      <div className="my-3 flex gap-2">
        <button type="button" className="btn" aria-pressed={mode === 'load'} disabled={!!busy}
          onClick={showPresets}>{t('Load preset')}</button>
        <button type="button" className="btn" aria-pressed={mode === 'save' && !editing} disabled={!!busy}
          onClick={() => editPreset()}>{t('Save current workspace')}</button>
      </div>
      {mode === 'save' ? (
        <form className="space-y-3" onSubmit={save}>
          {editing && <p className="text-sm text-secondary">
            {t('Replace {name} ({count} sessions) with the current workspace and the sessions selected below.', { name: editing.name, count: editing.count })}
          </p>}
          <label className="block text-sm">
            {t('Preset name')}
            <input className="input mt-1 w-full" value={name} onChange={event => setName(event.target.value)} required maxLength={80} />
          </label>
          <fieldset className="space-y-2" disabled={!!busy}>
            <legend className="mb-2 text-sm font-medium">{t('Sessions to restore')}</legend>
            {selections.map(item => {
              const session = sessions.find(entry => entry.id === item.id)
              if (!session) return null
              const label = getSessionDisplayName(session, organization.sessions[item.id])
              return (
                <div key={item.id} className="space-y-2 rounded border border-border p-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={item.included} onChange={event =>
                      updateSelection(item.id, { included: event.target.checked })} />
                    {label}
                  </label>
                  <p className="break-all text-xs text-secondary">{session.host || t('Local')} · {session.tmuxWindow} · {session.projectPath}</p>
                  {item.included && (
                    <div className="flex flex-wrap gap-2">
                      <select aria-label={t('Harness for {name}', { name: label })} className="input text-sm" value={item.harness}
                        onChange={event => updateSelection(item.id, { harness: event.target.value as TerminalSelection['harness'] })}>
                        <option value="">{t('Shell')}</option>
                        {harnesses.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
                      </select>
                      {item.harness && (
                        <input aria-label={t('Session ID for {name}', { name: label })} placeholder={t('Harness session ID')}
                          className="input min-w-[12rem] flex-1 text-sm" value={item.conversationId} maxLength={128}
                          onChange={event => updateSelection(item.id, { conversationId: event.target.value })} />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </fieldset>
          <button type="submit" className="btn btn-primary" disabled={!!busy || !name.trim()}>{editing ? t('Update preset') : t('Save')}</button>
        </form>
      ) : (
        <ul className="divide-y divide-border">
          {presets.map(preset => (
            <li key={preset.id} className="space-y-2 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words"><strong>{preset.name}</strong><span className="ml-2 text-secondary">{t('{count} sessions', { count: preset.count })}</span></span>
                <div className="flex flex-wrap gap-1">
                  {workspaceId === preset.id && preset.count > 0 && (
                    <button type="button" className="btn" disabled={!!busy}
                      onClick={() => void openPreset(preset, 'restore')}>{t('Restore missing sessions')}</button>
                  )}
                  <button type="button" className="btn btn-primary" disabled={!!busy}
                    onClick={() => void openPreset(preset, 'load')}>{t('Load')}</button>
                  <button type="button" className="btn" disabled={!!busy} onClick={() => editPreset(preset)}>{t('Update')}</button>
                  <button type="button" className="btn" disabled={!!busy || deleting === preset.id}
                    onClick={() => { setDeleting(preset.id); setFeedback('') }}>{t('Delete')}</button>
                </div>
              </div>
              {deleting === preset.id && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2">
                  <p>{t('Delete {name} ({count} sessions)?', { name: preset.name, count: preset.count })}</p>
                  <div className="flex flex-wrap gap-1">
                    <button type="button" className="btn" disabled={!!busy} onClick={() => setDeleting(undefined)}>{t('Cancel')}</button>
                    <button type="button" className="btn btn-danger" disabled={!!busy}
                      onClick={() => void deletePreset(preset)}>{t('Delete preset')}</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(busy || feedback) && <p role="status" className="mt-3 text-sm text-secondary">{t(busy || feedback)}</p>}
      {!!results?.some(result => result.error) && (
        <ul className="mt-2 space-y-1 text-sm text-secondary">
          {results.filter(result => result.error).map((result, index) => (
            <li key={index}>{result.label} · {t(result.error ?? '')}</li>
          ))}
        </ul>
      )}
    </dialog>
  )
}
