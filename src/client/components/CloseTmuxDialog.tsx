import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'

interface CloseTarget {
  name: string
  host: string
  identity: string
  windows: number
}

export default function CloseTmuxDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [target, setTarget] = useState<CloseTarget>()
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    dialog.current?.showModal()
    const controller = new AbortController()
    const query = new URLSearchParams({ sessionId: session.id })
    void fetch('/api/workspace/tmux-session?' + query, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Unable to inspect the tmux session')
        setTarget(body as CloseTarget)
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to inspect the tmux session')
      })
    return () => controller.abort()
  }, [session.id])

  async function confirm() {
    if (!target || closing) return
    setClosing(true)
    setError('')
    try {
      const response = await fetch('/api/workspace/close-tmux', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, identity: target.identity }),
      })
      if (!response.ok) {
        const body = await response.json()
        if (response.status === 409) setTarget(undefined)
        throw new Error(body.error || 'Unable to close the tmux session')
      }
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to close the tmux session')
    } finally {
      setClosing(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="close-tmux-title"
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-lg border border-border bg-elevated p-0 text-primary backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); if (!closing) onClose() }}
    >
      <div className="space-y-4 p-4">
        <h2 id="close-tmux-title" className="font-semibold">Close tmux session</h2>
        {target && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 break-all text-sm">
              <dt className="text-secondary">Server</dt><dd>{target.host}</dd>
              <dt className="text-secondary">Session</dt><dd>{target.name}</dd>
              <dt className="text-secondary">Windows</dt><dd>{target.windows}</dd>
            </dl>
            <p className="text-sm text-secondary">Programs in this session’s unshared windows will stop.</p>
          </>
        )}
        {!target && !error && <p role="status" className="text-sm text-secondary">Inspecting tmux session…</p>}
        {error && <p role="alert" className="text-sm text-secondary">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={closing}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={!target || closing}>
            {closing ? 'Closing…' : 'Close session'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
