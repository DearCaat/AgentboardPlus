/**
 * SessionRail - desktop-only bottom status rail (tmux-style status line).
 * Left: hairline-separated segments — name | status | context meta
 * (id, host, project) | PR chips. The id and project badge copy on click,
 * and right-clicking the segments opens the same context menu the
 * session list offers.
 * Right: transient segments (copy mode, jump-to-bottom, selection ready),
 * then a hairline before connection status and session actions
 * (wake / hibernate / an explicit actions menu).
 * Always rendered on md+ — with no selection it degrades to session count
 * plus connection status, like tmux's always-on status line.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSession, Session } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useRemoteSessionId } from '../hooks/useRemoteSessionId'
import { useSettingsStore } from '../stores/settingsStore'
import {
  getSessionDisplayName,
  useSessionOrganizationStore,
} from '../stores/sessionOrganizationStore'
import { getPathLeaf } from '../utils/sessionLabel'
import { copyText } from '../utils/copyText'
import { getConnectionStatusText, getStatusText, statusClass } from '../utils/sessionStatus'
import ProjectBadge from './ProjectBadge'
import HostBadge from './HostBadge'
import { PrChips } from './PrChips'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import {
  ArrowDownIcon,
  DotsHorizontalIcon,
  Copy01Icon,
  Edit05Icon,
  File06Icon,
  Hash01Icon,
  Moon01Icon,
  PlayIcon,
  XCloseIcon,
} from './icons'
import { ICON_SIZE, ROW_ICON_BUTTON_CLASS, iconButtonClass } from './controlStyles'
import { translateServerError, useLocale, useTranslation } from '../locale'

const harnessLabels: Record<string, string> = {
  codex: 'Codex', claude: 'Claude Code', 'claude-rp': 'Claude RP', pi: 'Pi',
  grok: 'Grok', devin: 'Devin', omp: 'OMP', antigravity: 'Antigravity',
}

interface SessionRailProps {
  session: Session | null
  hibernatingSession: AgentSession | null
  hibernatingDisplayName: string
  /** Matches SessionList's showHostInfo: host badge only when >1 host exists */
  showHostBadge: boolean
  sessionCount: number
  connectionStatus: ConnectionStatus
  isSwitching: boolean
  canControl: boolean
  canHibernate: boolean
  modDisplay: string
  onKill: () => void
  onHibernate: () => void
  onWake: () => void
  /** Rename whichever session the rail is showing (live id or agentSessionId) */
  onRename: (newName: string) => void
  /** Duplicate the live session into a new tmux window */
  onDuplicate?: () => void
  /** Move the hibernating session to history */
  onMoveToHistory?: () => void
  isTmuxCopyMode: boolean
  showJumpToBottom: boolean
  onJumpToBottom: () => void
  selectionReady: boolean
  onCopySelection: () => void
  onDismissSelection: () => void
}

const segmentButton =
  'flex h-7 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors active:scale-95'
// Transient segments (copy mode, jump-to-bottom, selection ready) share one
// quiet bordered pill matching the action buttons; state shows as a colored
// dot plus label, with the action appended after a middot.
const transientPill =
  'flex h-7 shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary'
// Pills (badges, PR chips) match the session list's 11px geometry.
const railPill = 'text-[11px]'
const copiedPill =
  'inline-flex shrink-0 items-center rounded-full bg-hover px-1.5 py-0.5 text-[11px] leading-none text-secondary'

const Divider = () => (
  <span aria-hidden className="mx-2 h-5 w-px shrink-0 bg-border" />
)

// Fixed slot sized to the widest status label ("Needs Input") so the
// divider behind it never shifts when status text changes width. ch
// units: this app sets html font-size to 13px, so rem-based widths come
// out 81% of their px expectation — 11ch tracks the glyph count exactly.
const STATUS_SLOT =
  'inline-block w-[11ch] shrink-0 whitespace-nowrap text-left text-xs'

/** Brief "Copied!" swap used by click-to-copy targets (Header.tsx pattern). */
function useCopiedFlag() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const markCopied = useCallback(() => {
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }, [])
  return [copied, markCopied] as const
}

export default function SessionRail({
  session,
  hibernatingSession,
  hibernatingDisplayName,
  showHostBadge,
  sessionCount,
  connectionStatus,
  isSwitching,
  canControl,
  canHibernate,
  modDisplay,
  onKill,
  onHibernate,
  onWake,
  onRename,
  onDuplicate,
  onMoveToHistory,
  isTmuxCopyMode,
  showJumpToBottom,
  onJumpToBottom,
  selectionReady,
  onCopySelection,
  onDismissSelection,
}: SessionRailProps) {
  const t = useTranslation()
  const locale = useLocale((s) => s.locale)
  const showProjectName = useSettingsStore((state) => state.showProjectName)

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameMode, setRenameMode] = useState<'tmux' | 'display' | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const actionsRef = useRef<HTMLButtonElement>(null)
  const [idCopied, markIdCopied] = useCopiedFlag()
  const [pathCopied, markPathCopied] = useCopiedFlag()
  const conversationId = useRemoteSessionId(session)
  const canReadCodexStatus = session?.remote && session.agentType === 'codex'
  const organizationEntry = useSessionOrganizationStore((state) => {
    const id = session?.id ?? hibernatingSession?.sessionId
    return id ? state.organization.sessions[id] : undefined
  })
  const organizationAvailable = useSessionOrganizationStore((state) => state.available)
  const setSessionTitle = useSessionOrganizationStore((state) => state.setSessionTitle)

  const sessionDisplayName = session
    ? getSessionDisplayName(session, organizationEntry)
    : ''
  const tmuxDisplayName = session
    ? session.agentSessionName || session.name
    : hibernatingSession?.displayName ||
      getPathLeaf(hibernatingSession?.projectPath ?? '') ||
      hibernatingSession?.sessionId.slice(0, 8) || ''
  const activeDisplayName = session
    ? sessionDisplayName
    : organizationEntry?.title?.trim() || hibernatingDisplayName
  // Hide the project badge when it just repeats the session name
  const projectLeaf =
    session?.projectPath &&
    getPathLeaf(session.projectPath) !== sessionDisplayName
      ? getPathLeaf(session.projectPath)
      : ''
  const hibernatingProjectLeaf =
    hibernatingSession?.projectPath &&
    getPathLeaf(hibernatingSession.projectPath) !== hibernatingDisplayName
      ? getPathLeaf(hibernatingSession.projectPath)
      : ''
  const agentSessionId = session?.agentSessionId?.trim() || hibernatingSession?.sessionId
  const agentType = session?.agentType ?? hibernatingSession?.agentType
  const harnessLabel = agentType && harnessLabels[agentType]

  // Context group = id / host / project meta; PR chips are their own group
  // and get their own divider, so neither count toward context emptiness.
  const liveContext =
    !!agentSessionId || !!harnessLabel ||
    (showHostBadge && !!session?.host?.trim()) ||
    (showProjectName && !!projectLeaf)
  const hibernatingContext =
    !!agentSessionId || !!harnessLabel ||
    (showHostBadge && !!hibernatingSession?.host?.trim()) ||
    (showProjectName && !!hibernatingProjectLeaf)

  const hasTransients =
    (selectionReady && !!session) ||
    (isTmuxCopyMode && !!session) ||
    (showJumpToBottom && !!session)

  useEffect(() => {
    if (renameMode && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renameMode])

  // Drop an in-flight rename when the rail switches which session it shows —
  // otherwise the input would carry session A's name onto session B.
  const shownSessionId = session?.id ?? hibernatingSession?.sessionId ?? null
  useEffect(() => {
    setRenameMode(null)
  }, [shownSessionId])

  function setRemoteSessionId() {
    const value = window.prompt(t('Enter the full {harness} session ID', { harness: harnessLabel ?? t('harness') }), agentSessionId ?? '')?.trim()
    if (value && value !== agentSessionId) void conversationId.save({ conversationId: value })
  }

  const startRename = useCallback(() => {
    setRenameValue(tmuxDisplayName)
    setRenameMode('tmux')
  }, [tmuxDisplayName])

  const startDisplayNameEdit = useCallback(() => {
    setRenameValue(activeDisplayName)
    setRenameMode('display')
  }, [activeDisplayName])

  const submitRename = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== tmuxDisplayName) onRename(trimmed)
    setRenameMode(null)
  }, [renameValue, tmuxDisplayName, onRename])

  const submitDisplayName = useCallback(() => {
    if (shownSessionId) setSessionTitle(shownSessionId, renameValue.trim() || null)
    setRenameMode(null)
  }, [shownSessionId, renameValue, setSessionTitle])

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems: ContextMenuEntry[] = []
  if (session) {
    menuItems.push(
      { key: 'rename', label: t('Rename'), icon: <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />, onSelect: startRename },
      ...(organizationAvailable
        ? [{
            key: 'display-name',
            label: t('Edit display name'),
            icon: <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            onSelect: startDisplayNameEdit,
          }]
        : []),
      ...(onDuplicate
        ? [{
            key: 'duplicate',
            label: t('Duplicate'),
            icon: <Copy01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            title: t('Create a copy in a new tmux window'),
            onSelect: onDuplicate,
          }]
        : []),
      ...(canHibernate
        ? [{
            key: 'hibernate',
            label: t('Hibernate'),
            icon: <Moon01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            title: t('Close the live window and keep this session ready to wake'),
            onSelect: onHibernate,
          }]
        : []),
      ...(agentSessionId
        ? [{
            key: 'copy-id',
            label: t('Copy full session ID'),
            icon: <Hash01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            title: agentSessionId,
            onSelect: () => copyText(agentSessionId),
          }]
        : []),
      ...(canReadCodexStatus
        ? [{
            key: 'codex-status',
            label: conversationId.pending ? t('Reading session ID…') : t('Read ID from /status'),
            icon: <Hash01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            onSelect: () => void conversationId.save({ source: 'codex-status' }),
          }]
        : []),
      ...(session.remote && session.agentType
        ? [{
            key: 'set-id',
            label: agentSessionId ? t('Edit session ID…') : t('Set session ID…'),
            icon: <Hash01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            onSelect: () => void setRemoteSessionId(),
          }]
        : []),
      ...(session.logFilePath
        ? [{
            key: 'copy-log',
            label: t('Copy Log Path'),
            icon: <File06Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            title: session.logFilePath,
            onSelect: () => copyText(session.logFilePath!),
          }]
        : [])
    )
    if (canControl) {
      menuItems.push('divider', {
        key: 'kill',
        label: t('Kill Session'),
        icon: <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
        danger: true,
        onSelect: onKill,
      })
    }
  } else if (hibernatingSession) {
    menuItems.push(
      { key: 'wake', label: t('Wake'), icon: <PlayIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />, onSelect: onWake },
      { key: 'rename', label: t('Rename'), icon: <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />, onSelect: startRename },
      ...(organizationAvailable
        ? [{
            key: 'display-name',
            label: t('Edit display name'),
            icon: <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            onSelect: startDisplayNameEdit,
          }]
        : []),
      {
        key: 'copy-id',
        label: t('Copy Session ID'),
        icon: <Hash01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
        title: hibernatingSession.sessionId,
        onSelect: () => copyText(hibernatingSession.sessionId),
      },
      ...(hibernatingSession.logFilePath
        ? [{
            key: 'copy-log',
            label: t('Copy Log Path'),
            icon: <File06Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
            title: hibernatingSession.logFilePath,
            onSelect: () => copyText(hibernatingSession.logFilePath!),
          }]
        : [])
    )
    if (onMoveToHistory) {
      menuItems.push('divider', {
        key: 'move-to-history',
        label: t('Move to History'),
        icon: <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
        onSelect: onMoveToHistory,
      })
    }
  }

  const renameInput = (
    <input
      ref={renameInputRef}
      type="text"
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onBlur={renameMode === 'display' ? submitDisplayName : submitRename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (renameMode === 'display') submitDisplayName()
          else submitRename()
        } else if (e.key === 'Escape') {
          setRenameMode(null)
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="w-40 max-w-48 select-text rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
      aria-label={renameMode === 'display' ? t('Set display name') : t('Rename session')}
    />
  )

  const projectBadge = (leaf: string, fullPath: string) =>
    pathCopied ? (
      <span className={copiedPill}>{t('Copied!')}</span>
    ) : (
      <button
        type="button"
        onClick={() => {
          copyText(fullPath)
          markPathCopied()
        }}
        className="shrink-0 cursor-pointer"
        title={fullPath}
        aria-label={t('Copy project path {path}', { path: fullPath })}
      >
        <ProjectBadge name={leaf} fullPath={fullPath} className={railPill} />
      </button>
    )

  const conversation = (
    <>
      {harnessLabel && <span className="shrink-0 text-xs font-medium text-secondary">{harnessLabel}</span>}
      {agentSessionId ? (
        <button type="button" className="min-w-0 break-all text-left font-mono text-xs text-muted hover:text-primary"
          title={t('{id} — click to copy', { id: agentSessionId })} aria-label={t('Copy session ID')}
          onClick={() => { copyText(agentSessionId); markIdCopied() }}>
          {idCopied ? t('Copied!') : agentSessionId}
        </button>
      ) : canReadCodexStatus ? (
        <button type="button" className="shrink-0 text-xs text-muted hover:text-primary"
          disabled={conversationId.pending} onClick={() => void conversationId.save({ source: 'codex-status' })}>
          {conversationId.pending ? t('Reading session ID…') : t('Read ID from /status')}
        </button>
      ) : session?.remote && harnessLabel && (
        <button type="button" className="shrink-0 text-xs text-muted hover:text-primary" onClick={() => void setRemoteSessionId()}>
          {t('Set session ID…')}
        </button>
      )}
      {conversationId.error && <span role="alert" className="text-xs text-danger">{translateServerError(locale, conversationId.error)}</span>}
    </>
  )

  return (
    <footer className="hidden min-h-[40px] shrink-0 select-none items-center justify-between gap-3 border-t border-border bg-elevated px-4 md:flex">
      {/* Left: hairline-separated segments — name | status | context meta
          (id / host / project) | PR chips. The menu wrapper covers the
          segments so right-clicking a PR chip keeps the link's native menu.
          flex-1 sits on the outer div so PrChips gets a real width to
          measure against (basis-0 in a shrink-to-fit parent collapses every
          chip into "+N") */}
      <div className="flex min-w-0 flex-1 items-center">
        {session ? (
          <>
            <div className="flex min-w-0 items-center" onContextMenu={openMenu}>
              {renameMode ? (
                renameInput
              ) : (
                <span className="max-w-48 truncate text-sm font-medium text-primary">
                  {sessionDisplayName}
                </span>
              )}
              <Divider />
              <span className={`${STATUS_SLOT} ${statusClass[session.status]}`}>
                {getStatusText(session.status, t)}
              </span>
              {liveContext && (
                <>
                  <Divider />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 py-1">
                    {conversation}
                    {showHostBadge && session.host?.trim() && (
                      <HostBadge name={session.host.trim()} className={railPill} />
                    )}
                    {showProjectName && projectLeaf &&
                      projectBadge(projectLeaf, session.projectPath)}
                  </div>
                </>
              )}
            </div>
            {session.prs && session.prs.length > 0 && (
              <>
                <Divider />
                <PrChips prs={session.prs} className="min-w-0 flex-1" />
              </>
            )}
          </>
        ) : hibernatingSession ? (
          <>
            <div className="flex min-w-0 items-center" onContextMenu={openMenu}>
              {renameMode ? (
                renameInput
              ) : (
                <span className="max-w-48 truncate text-sm font-medium text-primary">
                  {hibernatingDisplayName}
                </span>
              )}
              <Divider />
              <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
                {t('Hibernating')}
              </span>
              {hibernatingContext && (
                <>
                  <Divider />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 py-1">
                    {conversation}
                    {showHostBadge && hibernatingSession.host?.trim() && (
                      <HostBadge
                        name={hibernatingSession.host.trim()}
                        className={railPill}
                      />
                    )}
                    {showProjectName && hibernatingProjectLeaf &&
                      projectBadge(hibernatingProjectLeaf, hibernatingSession.projectPath)}
                  </div>
                </>
              )}
            </div>
            {hibernatingSession.prs && hibernatingSession.prs.length > 0 && (
              <>
                <Divider />
                <PrChips prs={hibernatingSession.prs} className="min-w-0 flex-1" />
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-muted">
            {sessionCount === 1 ? t('1 session') : t('{count} sessions', { count: sessionCount })}
          </span>
        )}
      </div>

      {/* Right: transient segments | connection, actions */}
      <div className="flex shrink-0 items-center gap-2.5">
        {selectionReady && session && (
          <span className={`${transientPill} cursor-default`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t('Selection ready')}
            <button
              type="button"
              onClick={onCopySelection}
              className="flex h-5 items-center gap-1 rounded px-1 font-medium text-accent hover:text-primary"
              aria-label={t('Copy selection')}
            >
              <Copy01Icon width={ICON_SIZE.pill} height={ICON_SIZE.pill} />
              {t('Copy')}
            </button>
            <button
              type="button"
              onClick={onDismissSelection}
              className={ROW_ICON_BUTTON_CLASS}
              title={t('Dismiss')}
              aria-label={t('Dismiss')}
            >
              <XCloseIcon width={ICON_SIZE.pill} height={ICON_SIZE.pill} />
            </button>
          </span>
        )}
        {isTmuxCopyMode && session ? (
          <button
            type="button"
            onClick={onJumpToBottom}
            className={transientPill}
            title={t('Exit tmux copy mode and return to live output')}
            aria-label={t('Exit copy mode')}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            {t('Copy mode')}
            <span aria-hidden className="text-muted">·</span>
            <span className="font-medium text-amber-400">{t('Exit')}</span>
          </button>
        ) : showJumpToBottom && session ? (
          <button
            type="button"
            onClick={onJumpToBottom}
            className={transientPill}
            title={t('Scroll to bottom')}
            aria-label={t('Scroll to bottom')}
          >
            <ArrowDownIcon width={ICON_SIZE.pill} height={ICON_SIZE.pill} />
            {t('Jump to bottom')}
          </button>
        ) : null}
        {hasTransients && <Divider />}

        {connectionStatus !== 'connected' && (
          <span className="text-xs text-approval">{getConnectionStatusText(connectionStatus, t)}</span>
        )}

        {hibernatingSession && (
          <button
            type="button"
            onClick={onWake}
            className={`${segmentButton} border border-border bg-surface text-secondary hover:bg-hover hover:text-primary`}
          >
            {t('Wake')}
          </button>
        )}
        {session && canHibernate && (
          <button
            onClick={onHibernate}
            className={iconButtonClass('neutral')}
            title={t('Hibernate session')}
            aria-label={t('Hibernate session')}
          >
            <Moon01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
          </button>
        )}
        {menuItems.length > 0 && (
          <button
            ref={actionsRef}
            disabled={isSwitching}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect()
              setMenu(menu ? null : { x: bounds.left, y: bounds.top })
            }}
            className={iconButtonClass('neutral')}
            title={t('Session actions (Kill: {shortcut})', { shortcut: `${modDisplay}X` })}
            aria-label={t('Session actions')}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
          >
            <DotsHorizontalIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
          </button>
        )}
      </div>

      {menu && menuItems.length > 0 && (
        <ContextMenu
          anchor={menu}
          items={menuItems}
          anchorFromBottom
          keyboardNavigation
          returnFocusRef={actionsRef}
          onClose={() => setMenu(null)}
        />
      )}
    </footer>
  )
}
