import { codexFooterSessionId } from './codexStatus'
import { inferAgentType, normalizePaneStartCommand } from './agentDetection'
import { config } from './config'
import { resolveExternalDisplayName } from './displayName'
import { remoteTmuxIdentity } from './tmuxClose'
import { applyRemoteHarnessMetadata, remoteHarnessProbeCommand } from './remoteHarnessMetadata'
import { logger } from './logger'
import { shellQuote } from './shellQuote'
import { remoteSshOptions, splitSshOptions } from './sshOptions'
import {
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
} from './tmuxFormat'
import {
  inferSessionStatus,
  type PaneCacheState,
  type PaneSnapshot,
} from './statusInference'
import type { HostStatus, Session } from '../shared/types'

/**
 * Replace characters that are not safe for use in session IDs.
 * Only allows alphanumeric, underscore, dot, colon, at-sign, and hyphen.
 */
function sanitizeForId(s: string): string {
  return s.replace(/[^A-Za-z0-9_.:@-]/g, '_')
}

const TMUX_LIST_FORMAT = buildTmuxFormat([
  '#{session_name}',
  '#{window_index}',
  '#{window_id}',
  '#{window_name}',
  '#{pane_current_path}',
  '#{window_activity}',
  '#{window_creation_time}',
  '#{pane_start_command}',
  '#{session_id}',
  '#{pid}',
  '#{session_created}',
  '#{pane_current_command}',
  '#{pane_pid}',
])
const PANE_DIMENSIONS_FORMAT = buildTmuxFormat([
  '#{pane_width}',
  '#{pane_height}',
])

// Cache of remote pane content for change detection (mirrors paneContentCache in SessionManager)
const remoteContentCache = new Map<string, PaneCacheState>()

interface RemoteHostCatalog {
  sessions: Session[]
  updatedAt: number
}

interface RemoteHostSnapshot extends RemoteHostCatalog {
  host: string
  ok: boolean
  error?: string
}

interface RemoteHostState {
  latest?: RemoteHostSnapshot
  lastSuccessful?: RemoteHostCatalog
}

export interface RemoteSessionPollerOptions {
  hosts: string[]
  pollIntervalMs: number
  timeoutMs: number
  staleAfterMs: number
  sshOptions?: string
  tmuxSessionPrefix: string
  discoverPrefixes: string[]
  onUpdate?: (hosts: HostStatus[]) => void
  loadSnapshot?: (host: string) => RemoteHostCatalog | undefined
  saveSnapshot?: (host: string, snapshot: RemoteHostCatalog) => void
  boundCodexId?: (session: Session) => string | undefined
}

export class RemoteSessionPoller {
  private readonly hosts: string[]
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly staleAfterMs: number
  private readonly sshOptions: string[]
  private readonly tmuxSessionPrefix: string
  private readonly discoverPrefixes: string[]
  private readonly onUpdate?: (hosts: HostStatus[]) => void
  private readonly saveSnapshot?: RemoteSessionPollerOptions['saveSnapshot']
  private readonly boundCodexId: RemoteSessionPollerOptions['boundCodexId']
  private timer: Timer | null = null
  private inFlight = false
  private lastStatusSnapshot = ''
  private hostStates = new Map<string, RemoteHostState>()

  constructor(options: RemoteSessionPollerOptions) {
    this.hosts = options.hosts
    this.pollIntervalMs = options.pollIntervalMs
    this.timeoutMs = options.timeoutMs
    this.staleAfterMs = options.staleAfterMs
    this.sshOptions = splitSshOptions(options.sshOptions ?? '')
    this.tmuxSessionPrefix = options.tmuxSessionPrefix
    this.discoverPrefixes = options.discoverPrefixes
    this.onUpdate = options.onUpdate
    this.saveSnapshot = options.saveSnapshot
    this.boundCodexId = options.boundCodexId
    for (const host of this.hosts) {
      const lastSuccessful = options.loadSnapshot?.(host)
      if (lastSuccessful) this.hostStates.set(host, { lastSuccessful })
    }
  }

  start(): void {
    if (this.timer || this.hosts.length === 0) {
      return
    }
    void this.poll()
    this.timer = setInterval(() => {
      void this.poll()
    }, this.pollIntervalMs)
  }

  hostAdded(host: string): void {
    if (!this.timer) {
      this.start()
    } else {
      void this.pollOne(host)
    }
  }

  private async pollOne(host: string): Promise<void> {
    try {
      const snapshot = await pollHost(host, remoteSshOptions(host, this.sshOptions), this.timeoutMs, this.tmuxSessionPrefix, this.discoverPrefixes, this.boundCodexId, this.hostStates.get(host)?.lastSuccessful?.sessions)
      this.recordSnapshot(snapshot)
      this.onUpdate?.(this.getHostStatuses())
    } catch {
      // The scheduled poll reports the host state on its next pass.
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getSessions(): Session[] {
    const sessions: Session[] = []
    for (const { lastSuccessful } of this.hostStates.values()) {
      if (lastSuccessful) sessions.push(...lastSuccessful.sessions)
    }
    return sessions
  }

  getHostStatus(host: string): HostStatus {
    const state = this.hostStates.get(host)
    const snapshot = state?.latest
    if (!snapshot) {
      return {
        host,
        ok: false,
        lastUpdated: new Date(state?.lastSuccessful?.updatedAt ?? 0).toISOString(),
      }
    }
    const stale = Date.now() - snapshot.updatedAt > this.staleAfterMs
    const ok = snapshot.ok && !stale
    return {
      host,
      ok,
      lastUpdated: new Date(snapshot.updatedAt).toISOString(),
      error: ok ? undefined : snapshot.error ?? (stale ? 'stale' : undefined),
    }
  }

  getHostStatuses(): HostStatus[] {
    return this.hosts.map((host) => this.getHostStatus(host))
  }

  getLastSuccessfulPollAt(host: string): number {
    return this.hostStates.get(host)?.lastSuccessful?.updatedAt ?? 0
  }

  private recordSnapshot(snapshot: RemoteHostSnapshot): void {
    const previous = this.hostStates.get(snapshot.host)
    if (previous?.latest && previous.latest.updatedAt > snapshot.updatedAt) return
    if (snapshot.ok && previous?.lastSuccessful) {
      const previousById = new Map(previous.lastSuccessful.sessions.map(session => [session.id, session]))
      for (const session of snapshot.sessions) {
        const last = previousById.get(session.id)
        if (!session.lastResponseAt && last && session.agentSessionId &&
            last.agentSessionId === session.agentSessionId && last.remoteTmuxIdentity === session.remoteTmuxIdentity &&
            last.createdAt === session.createdAt) session.lastResponseAt = last.lastResponseAt
      }
    }
    this.hostStates.set(snapshot.host, {
      latest: snapshot,
      lastSuccessful: snapshot.ok ? snapshot : previous?.lastSuccessful,
    })
    if (snapshot.ok) this.saveCatalog(snapshot.host, snapshot, previous?.lastSuccessful)
  }

  private saveCatalog(host: string, catalog: RemoteHostCatalog, previous: RemoteHostCatalog | undefined): void {
    if (!this.saveSnapshot || JSON.stringify(catalog.sessions) === JSON.stringify(previous?.sessions)) return
    try {
      this.saveSnapshot(host, { sessions: catalog.sessions, updatedAt: catalog.updatedAt })
    } catch (error) {
      logger.warn('remote_snapshot_save_failed', { host, error: String(error) })
    }
  }

  private async poll(): Promise<void> {
    if (this.inFlight) {
      return
    }
    this.inFlight = true
    try {
      const results = await Promise.allSettled(
        this.hosts.map((host) => pollHost(host, remoteSshOptions(host, this.sshOptions), this.timeoutMs, this.tmuxSessionPrefix, this.discoverPrefixes, this.boundCodexId, this.hostStates.get(host)?.lastSuccessful?.sessions))
      )

      results.forEach((result, index) => {
        const host = this.hosts[index]
        if (!host) return
        if (result.status === 'fulfilled') {
          this.recordSnapshot(result.value)
        } else {
          this.recordSnapshot({
            host,
            sessions: [],
            ok: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            updatedAt: Date.now(),
          })
        }
      })

      // Clean up stale remote content cache entries
      cleanupRemoteContentCache(this.getSessions())

      const statuses = this.getHostStatuses()
      const nextSnapshot = JSON.stringify(statuses)
      if (nextSnapshot !== this.lastStatusSnapshot) {
        this.lastStatusSnapshot = nextSnapshot
        this.onUpdate?.(statuses)
      }
    } finally {
      this.inFlight = false
    }
  }
}

/**
 * Build a single shell command that captures pane dimensions + content
 * for all sessions, separated by a known marker.
 */
function buildBatchCaptureCommand(sessions: Session[], separator: string): string {
  if (sessions.length === 0) return ''
  return sessions
    .map((s) => {
      const target = shellQuote(s.tmuxWindow)
      // Group dims + capture; suppress stderr so failures produce empty segments
      return (
        `{ tmux -u display-message -t ${target} -p ${shellQuote(PANE_DIMENSIONS_FORMAT)}` +
        ` && tmux -u capture-pane -t ${target} -p -J; } 2>/dev/null; echo ${shellQuote(separator)};`
      )
    })
    .join(' ')
}

/**
 * Parse the batched SSH capture output into per-session pane snapshots.
 * Each segment between separators contains: first line = "WIDTH HEIGHT", rest = pane content.
 */
function parseBatchCaptureOutput(
  output: string,
  sessions: Session[],
  separator: string
): Map<string, PaneSnapshot> {
  const result = new Map<string, PaneSnapshot>()
  const segments = output.split(separator)

  for (let i = 0; i < sessions.length && i < segments.length; i++) {
    const segment = segments[i]!.trim()
    if (!segment) continue

    const lines = segment.split('\n')
    const dimsLine = lines[0]?.trim()
    if (!dimsLine) continue

    const dimsParts = splitTmuxFields(dimsLine, 2)
    if (!dimsParts) continue

    const width = Number.parseInt(dimsParts[0] ?? '', 10) || 80
    const height = Number.parseInt(dimsParts[1] ?? '', 10) || 24

    // Rest is pane content — strip trailing empty lines, take last 30 (matches local behavior)
    const contentLines = lines.slice(1)
    while (
      contentLines.length > 0 &&
      contentLines[contentLines.length - 1]!.trim() === ''
    ) {
      contentLines.pop()
    }
    const content = contentLines.slice(-30).join('\n')

    result.set(sessions[i]!.id, { content, width, height })
  }

  return result
}

/**
 * Enrich sessions with inferred status from captured pane content.
 * Maintains remoteContentCache for change detection across poll cycles.
 */
function enrichSessionsWithStatus(
  sessions: Session[],
  captures: Map<string, PaneSnapshot>,
  now: number,
  workingGracePeriodMs: number
): void {
  for (const session of sessions) {
    const pane = captures.get(session.id)
    if (!pane) continue

    const prev = remoteContentCache.get(session.id)
    const result = inferSessionStatus({
      prev,
      next: pane,
      now,
      workingGracePeriodMs,
    })

    session.status = result.status
    remoteContentCache.set(session.id, result.nextCache)
  }
}

/** Remove cache entries for sessions that no longer exist. */
function cleanupRemoteContentCache(activeSessions: Session[]): void {
  const activeIds = new Set(activeSessions.map((s) => s.id))
  for (const key of remoteContentCache.keys()) {
    if (!activeIds.has(key)) {
      remoteContentCache.delete(key)
    }
  }
}

/**
 * Capture pane content for all sessions on a host via a single batched SSH call,
 * then enrich each session's status via inferSessionStatus.
 */
async function captureRemotePaneStatus(
  sessions: Session[],
  paneKeys: Map<string, string>,
  host: string,
  sshOptions: string[],
  timeoutMs: number,
  codexIds: Record<string, string>,
): Promise<void> {
  const separator = crypto.randomUUID()
  let cmd = buildBatchCaptureCommand(sessions, separator)
  if (!cmd) return
  const probeMarker = separator + ':harness'
  const probeKeys = sessions.flatMap(session => {
    const key = paneKeys.get(session.id)
    return key && (session.agentType !== 'codex' || codexIds[key]) ? [key] : []
  })
  if (probeKeys.length) cmd += ' ' + remoteHarnessProbeCommand(probeMarker, probeKeys, codexIds)

  const args = ['ssh', ...sshOptions, host, cmd]
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }, timeoutMs)

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  clearTimeout(timeout)

  // Don't fail the whole poll if capture fails — sessions keep 'unknown' status
  if (exitCode !== 0) {
    logger.warn('remote_pane_capture_failed', {
      host,
      exitCode,
      stderr: stderr.slice(0, 500),
    })
    return
  }

  const probeIndex = stdout.lastIndexOf(probeMarker + '\n')
  if (probeIndex >= 0) {
    applyRemoteHarnessMetadata(sessions, paneKeys, stdout.slice(probeIndex + probeMarker.length + 1))
  }
  const screen = probeIndex >= 0 ? stdout.slice(0, probeIndex) : stdout
  const captures = parseBatchCaptureOutput(screen, sessions, separator)
  const visibleIds: Record<string, string> = {}
  const segments = screen.split(separator)
  for (const [index, session] of sessions.entries()) {
    if (session.agentType !== 'codex') continue
    const pane = paneKeys.get(session.id)
    const thread = pane && codexFooterSessionId(segments[index] ?? '')
    if (!pane || !thread) continue
    session.codexFooterSessionId = thread
    if (thread === codexIds[pane]) continue
    session.agentSessionId = thread
    session.lastResponseAt = undefined
    visibleIds[pane] = thread
  }
  if (Object.keys(visibleIds).length) {
    const cmd = remoteHarnessProbeCommand(probeMarker, Object.keys(visibleIds), visibleIds)
    const result = Bun.spawn(['ssh', ...sshOptions, host, cmd], { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => { try { result.kill() } catch {} }, timeoutMs)
    try {
      const [exit, payload] = await Promise.all([result.exited, new Response(result.stdout).text()])
      const markerIndex = payload.lastIndexOf(probeMarker + '\n')
      if (exit === 0 && markerIndex >= 0) applyRemoteHarnessMetadata(sessions, paneKeys, payload.slice(markerIndex + probeMarker.length + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  enrichSessionsWithStatus(
    sessions,
    captures,
    Date.now(),
    config.workingGracePeriodMs
  )
}

async function pollHost(
  host: string,
  sshOptions: string[],
  timeoutMs: number,
  tmuxSessionPrefix: string,
  discoverPrefixes: string[],
  boundCodexId?: RemoteSessionPollerOptions['boundCodexId'],
  previousSessions: Session[] = [],
): Promise<RemoteHostSnapshot> {
  const args = ['ssh', ...sshOptions, host, `tmux -u list-windows -a -F ${shellQuote(TMUX_LIST_FORMAT)}`]
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }, timeoutMs)

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  clearTimeout(timeout)

  if (exitCode !== 0 && !(exitCode === 1 && isEmptyRemoteTmux(stderr))) {
    const message = stderr.trim() || `ssh exited with code ${exitCode}`
    logger.warn('remote_host_poll_failed', { host, message })
    return {
      host,
      sessions: [],
      ok: false,
      error: message,
      updatedAt: Date.now(),
    }
  }

  const paneKeys = new Map<string, string>()
  const sessions = parseTmuxWindows(host, stdout, tmuxSessionPrefix, discoverPrefixes, paneKeys)

  // Capture pane content and enrich with inferred status
  if (sessions.length > 0) {
    const codexIds: Record<string, string> = {}
    const previousById = new Map(previousSessions.map(session => [session.id, session]))
    for (const session of sessions) {
      if (session.agentType !== 'codex') continue
      const pane = paneKeys.get(session.id)
      const previous = previousById.get(session.id)
      const observed = previous?.remoteTmuxIdentity === session.remoteTmuxIdentity &&
        previous?.createdAt === session.createdAt && previous?.codexIdentityPane === pane
        ? previous.codexFooterSessionId : undefined
      session.codexIdentityPane = pane
      session.codexFooterSessionId = observed
      const id = observed ?? boundCodexId?.(session)
      if (pane && id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
        session.agentSessionId = id
        codexIds[pane] = id
      }
    }
    await captureRemotePaneStatus(sessions, paneKeys, host, sshOptions, timeoutMs, codexIds)
  }

  return {
    host,
    sessions,
    ok: true,
    updatedAt: Date.now(),
  }
}

function parseTmuxWindows(
  host: string,
  output: string,
  tmuxSessionPrefix: string,
  discoverPrefixes: string[],
  paneKeys?: Map<string, string>,
): Session[] {
  const lines = splitTmuxLines(output)
  const now = Date.now()
  const sessions: Session[] = []
  const wsPrefix = `${tmuxSessionPrefix}-ws-`

  for (const line of lines) {
    const parts = splitTmuxFields(line, 13) ?? splitTmuxFields(line, 12) ?? splitTmuxFields(line, 11)
    if (!parts) {
      continue
    }
    const [
      sessionName,
      windowIndex,
      windowId,
      windowName,
      cwd,
      activityRaw,
      createdRaw,
      command,
      sessionId,
      serverPid,
      sessionCreated,
      currentCommand,
      panePid,
    ] = parts

    if (!sessionName || !windowIndex) {
      continue
    }

    // Skip internal proxy sessions (created by SshTerminalProxy)
    if (sessionName.startsWith(wsPrefix)) {
      continue
    }

    // Apply discover prefix filtering (same logic as SessionManager.listExternalWindows)
    if (sessionName !== tmuxSessionPrefix && discoverPrefixes.length > 0) {
      if (!discoverPrefixes.some((prefix) => sessionName.startsWith(prefix))) {
        continue
      }
    }

    const stableId = windowId?.trim() || windowIndex
    const tmuxWindow = `${sessionName}:${stableId}`
    const createdAt = toIsoFromSeconds(createdRaw, now)
    const lastActivity = toIsoFromSeconds(activityRaw, now)
    const normalizedCommand = normalizePaneStartCommand(command || '')
    const liveAgentType = inferAgentType(currentCommand ?? '')
    const launchedAgentType = inferAgentType(normalizedCommand)
    const agentType = liveAgentType ?? launchedAgentType
    const agentSessionId = agentType && agentType === launchedAgentType
      ? normalizedCommand.match(/^(?:exec\s+)?(?:[^\s]*\/)?(?:codex\s+resume|claude\s+--resume)\s+['"]?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:['"]|\s|$)/i)?.[1]
      : undefined
    const id = buildRemoteSessionId(host, sessionName, windowIndex, windowId)
    if (paneKeys && (!agentType || agentType === 'claude' || agentType === 'claude-rp' || agentType === 'codex') &&
        /^[0-9]+:@[0-9]+:[0-9]+$/.test(`${serverPid}:${windowId}:${panePid}`)) {
      paneKeys.set(id, `${serverPid}:${windowId}:${panePid}`)
    }
    const isManagedSession = sessionName === tmuxSessionPrefix
    const displayName = isManagedSession
      ? (windowName || tmuxWindow)
      : (resolveExternalDisplayName(sessionName, windowName, config.preferWindowName) || tmuxWindow)

    sessions.push({
      id,
      name: displayName,
      tmuxWindow,
      projectPath: (cwd || '').trim(),
      status: 'unknown',
      lastActivity,
      createdAt,
      agentType,
      agentSessionId,
      source: isManagedSession ? 'managed' : 'external',
      host,
      remote: true,
      remoteTmuxIdentity: remoteTmuxIdentity(sessionId, serverPid, sessionCreated),
      command: normalizedCommand || undefined,
    })
  }

  return sessions
}

/** tmux exits 1 when a reachable account has no sessions yet. */
export function isEmptyRemoteTmux(stderr: string): boolean {
  return /^(?:no server running on |no sessions(?:\s|$)|error connecting to .+ \(No such file or directory\))/m.test(stderr)
}

function buildRemoteSessionId(
  host: string,
  sessionName: string,
  windowIndex: string,
  windowId?: string
): string {
  const suffix = windowId?.trim() ? windowId.trim() : windowIndex.trim()
  return `remote:${host}:${sanitizeForId(sessionName)}:${sanitizeForId(suffix)}`
}

function toIsoFromSeconds(value: string | undefined, fallbackMs: number): string {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return new Date(fallbackMs).toISOString()
  }
  return new Date(parsed * 1000).toISOString()
}

// Export for testing
export {
  sanitizeForId,
  parseTmuxWindows,
  buildRemoteSessionId,
  toIsoFromSeconds,
  splitSshOptions,
  buildBatchCaptureCommand,
  parseBatchCaptureOutput,
  enrichSessionsWithStatus,
  cleanupRemoteContentCache,
  remoteContentCache,
}
