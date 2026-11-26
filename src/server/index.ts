import { SessionActivityClient } from './sessionActivityClient'
import { startOwnedTerminal, sshTerminalSessionName } from './terminal/startOwnedTerminal'
import { activityKey } from './sessionActivityProtocol'
import { TerminalRelayClient } from './relay/client'
import type { RelayToParent } from './relay/protocol'
import { copyModeCommand, CopyModeQuery, resolveLocalCopyModeTarget } from './copyModeQuery'
import { capturePaneSnapshot } from './paneSnapshot'
import { SessionReadClient } from './sessionReadClient'
import type { Server, ServerWebSocket } from 'bun'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Hono, type Context } from 'hono'
import { serveStatic } from 'hono/bun'
import { bodyLimit } from 'hono/body-limit'
import { parseSessionOrganization } from './sessionOrganization'
import { mapWithConcurrency } from './mapWithConcurrency'
import { presetHarnesses, remapPresetOrganization, validPresetConversationId, type PresetTerminal, type WorkspacePreset } from './workspacePresets'
import { config, isValidHostname } from './config'
import { PreviewServers } from './outputs/previewServers'
import { PreviewCertificates } from './outputs/certificates'
import { outputRoutes } from './outputs/routes'
import { createPasteFileRoutes } from './routes/pasteFile'
import { OwnershipObserver } from './ownership/observer'
import { OwnershipMatcher } from './ownership/matcher'
import { createLocalOwnershipIO } from './ownership/localIO'
import { probeOwnership } from './ownership/probe'
import { ensureTmux } from './prerequisites'
import { applyNestedTmuxDecision, assertTestTmuxIsolation } from './tmuxIsolation'
import { sanitizedTmuxEnv } from './tmuxEnv'
import { createBoardAccessGate } from './boardAccess'
import { codexStatusSessionId } from './codexStatus'
import { closeTmuxArgs, parseTmuxCloseTarget, remoteTmuxIdentity, TMUX_CLOSE_FORMAT, tmuxSessionName } from './tmuxClose'
import { administrator, canSendBoardMessage, canUseSession, sharedHttpAllowed, visibleBoardMessage, type BoardAccess } from './boardGrants'
import { KillRateLimiter } from './killRateLimit'
import { SessionManager } from './SessionManager'
import { ThrowawayShellReaper } from './throwawayShellReaper'
import { SessionRegistry } from './SessionRegistry'
import { PersistentSessions } from './persistence/manager'
import { refreshDormantConversation } from './persistence/legacyImport'
import type { SavedSession } from '../shared/persistence'
import { PersistenceRuntime } from './persistence/runtime'
import { registerPersistenceRoutes } from './persistence/routes'
import { crossOriginRejection, needsOriginCheck, originPolicy } from './requestOrigin'
import {
  initDatabase,
  type AgentSessionRecord,
  type ClaimCurrentWindowPatch,
} from './db'
import { LogPoller } from './logPoller'
import { toAgentSession as buildAgentSession } from './agentSessions'
import { SessionMetadataClient } from './sessionMetadataClient'
import { SessionMetadataPublisher } from './sessionMetadataViews'
import { MediaThumbnailClient } from './mediaThumbnailClient'
import { createMediaRoutes } from './mediaRoutes'
import { catalogMessage, sessionSummary } from './catalogMessages'
import { CATALOG_VERSION, catalogVersionFromUrl } from '../shared/catalogProtocol'
import { startCatalogUpgradeNotice } from './catalogUpgrade'
import { getCodexSubagentIndex, setCodexSubagentIndexListener } from './subagentLogs'
import { BoardPrStatus } from './boardPrStatus'
import { createPrStatusProvider } from './prStatusProvider'
import { getLogSearchDirs } from './logDiscovery'
import {
  createStartupLifecycle,
  type VerificationDecision,
} from './startupVerify'
import {
  DEFAULT_SCROLLBACK_LINES,
  matchWindowsToLogsByExactRg,
  stripPastePlaceholders,
  verifyWindowLogAssociationDetailed,
  type WindowLogVerificationResult,
} from './logMatcher'
import {
  createTerminalProxy,
  resolveTerminalMode,
  TerminalProxyError,
} from './terminal'
import type { ITerminalProxy } from './terminal'
import { antigravityProjectPath } from './antigravityLogs'
import { resolveProjectPath } from './paths'
import {
  HISTORY_MAX_AGE_MIN_HOURS,
  HISTORY_MAX_AGE_MAX_HOURS,
  type ClientMessage,
  type ServerMessage,
  type TerminalErrorCode,
  type DirectoryListing,
  type DirectoryErrorResponse,
  type AgentSession,
  type AgentType,
  type HostStatus,
  type SessionKillSource,
  type WakeError,
  type Session,
} from '../shared/types'
import {
  SYNCED_SETTINGS_KEYS,
  isSyncedSettingsKey,
  isValidSyncedSetting,
  type SyncedSettings,
} from '../shared/syncedSettings'
import { logger, logLevel, flushLogger } from './logger'
import { acquireInstanceLock, releaseInstanceLock, InstanceLockError } from './instanceLock'
import {
  SessionRefreshWorkerClient,
  SessionRefreshWorkerTimeoutError,
} from './sessionRefreshWorkerClient'
import {
  setForceWorkingUntil,
  applyForceWorkingOverrides,
} from './forceWorkingStatus'
import { TmuxTimeoutError } from './tmuxTimeout'
import {
  MAX_FIELD_LENGTH,
  isValidSessionId,
  isValidTmuxTarget,
} from './validators'
import { RemoteSessionPoller, buildRemoteSessionId, isEmptyRemoteTmux } from './remoteSessions'
import { remoteSshOptions } from './sshOptions'
import { normalizePaneStartCommand } from './agentDetection'
import { generateSessionName } from './nameGenerator'
import { shellQuote } from './shellQuote'
import { SshTerminalProxy } from './terminal/SshTerminalProxy'
import { normalizeCapturedHistory } from './terminal/tmuxText'
import {
  buildTmuxFormat,
  escapeTmuxFormatArg,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from './tmuxFormat'
import { timedSpawnAsync, timedSpawnSync } from './syncSpawnTiming'
import { StallWatchdog } from './stallWatchdog'
import { installSyncIoTiming } from './syncIoTiming'
import { getTailscaleIp } from './tailscale'
import { windowNameError } from './windowName'

function checkPortAvailable(port: number): void {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    // Use -sTCP:LISTEN to only match processes actually listening on the port,
    // not stale/closed connections from other processes (e.g. Playwright/Chrome)
    result = timedSpawnSync(['lsof', '-i', `:${port}`, '-sTCP:LISTEN', '-t'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return
  }
  const pids = result.stdout?.toString().trim() ?? ''
  if (pids) {
    const pidList = pids.split('\n').filter(Boolean)
    const pid = pidList[0]
    // Get process name
    let processName = 'unknown'
    try {
      const nameResult = timedSpawnSync(['ps', '-p', pid, '-o', 'comm='], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      processName = nameResult.stdout?.toString().trim() || 'unknown'
    } catch {
    }
    logger.error('port_in_use', { port, pid, processName })
    // Drain any stream buffer (the pretty-stdout transport) before exiting.
    flushLogger()
    process.exit(1)
  }
}

interface LogLineWindow {
  totalLines: number | null
  startLine: number
  endLine: number
  hasMoreBefore: boolean
  lines: string[]
  lineKeys?: string[]
  startByte?: number
  endByte?: number
}

// Hibernated session logs are static (the session is no longer writing to them),
// so the parsed line array is cached and re-sliced for pagination instead of
// re-scanning the whole file on every "Load earlier" request. Entries are keyed
// by size+mtime so a rewritten log self-invalidates, and the cache is byte-bounded
// so it can't grow without limit.
interface CachedLogLines {
  size: number
  mtimeMs: number
  lines: string[]
}
const LOG_LINE_CACHE = new Map<string, CachedLogLines>()
// Logs larger than this are streamed with a bounded window instead of cached, so
// a pathologically large file never lands in memory whole.
const MAX_CACHEABLE_LOG_BYTES = 4 * 1024 * 1024
// Total budget across all cached logs; oldest entries are evicted past this.
const MAX_LOG_CACHE_BYTES = 16 * 1024 * 1024
let logLineCacheBytes = 0

function enforceLogCacheBudget(): void {
  // Map preserves insertion order, so the first key is the least-recently-used.
  while (logLineCacheBytes > MAX_LOG_CACHE_BYTES) {
    const oldestKey = LOG_LINE_CACHE.keys().next().value
    if (oldestKey === undefined) break
    const evicted = LOG_LINE_CACHE.get(oldestKey)
    LOG_LINE_CACHE.delete(oldestKey)
    if (evicted) logLineCacheBytes -= evicted.size
  }
}

function selectLineWindow(
  lines: string[],
  limit: number,
  beforeLine: number
): LogLineWindow {
  const totalLines = lines.length
  const requestedEndLine = Number.isFinite(beforeLine)
    ? Math.max(0, Math.trunc(beforeLine))
    : totalLines
  const endLine = Math.min(totalLines, requestedEndLine)
  const startLine = Math.max(0, endLine - limit)
  return {
    totalLines,
    startLine,
    endLine,
    hasMoreBefore: startLine > 0,
    lines: lines.slice(startLine, endLine),
  }
}

async function readAllLogLines(logPath: string): Promise<string[]> {
  const lines: string[] = []
  const fileStream = createReadStream(logPath, { encoding: 'utf8' })
  const reader = createInterface({ input: fileStream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      lines.push(line)
    }
  } finally {
    // close() ends the readline interface; destroy() releases the fd even when
    // iteration aborts early (e.g. EIO mid-read), which close() alone won't do.
    reader.close()
    fileStream.destroy()
  }
  return lines
}

// Streaming fallback for compatibility with older beforeLine requests. This still
// scans the whole file, so byte cursors are used for large-log pagination below.
async function streamLogLineWindow(
  logPath: string,
  limit: number,
  beforeLine: number
): Promise<LogLineWindow> {
  const requestedEndLine = Number.isFinite(beforeLine)
    ? Math.max(0, Math.trunc(beforeLine))
    : Number.POSITIVE_INFINITY
  const selectedLines: string[] = []
  let totalLines = 0

  const fileStream = createReadStream(logPath, { encoding: 'utf8' })
  const reader = createInterface({ input: fileStream, crlfDelay: Infinity })

  try {
    for await (const line of reader) {
      if (totalLines < requestedEndLine) {
        selectedLines.push(line)
        if (selectedLines.length > limit) {
          selectedLines.shift()
        }
      }
      totalLines += 1
    }
  } finally {
    reader.close()
    fileStream.destroy()
  }

  const endLine = Math.min(totalLines, requestedEndLine)
  const startLine = Math.max(0, endLine - selectedLines.length)
  return {
    totalLines,
    startLine,
    endLine,
    hasMoreBefore: startLine > 0,
    lines: selectedLines,
  }
}

// Large transcripts should open at the end without counting every preceding
// line. Read backwards in chunks until we have the requested complete lines, then
// return byte cursors so the client can page earlier without a linear scan.
async function readLogLineWindowFromEnd(
  logPath: string,
  stats: { size: number },
  limit: number,
  beforeByte: number
): Promise<LogLineWindow> {
  const endByte = Math.max(0, Math.min(stats.size, Math.trunc(beforeByte)))
  if (endByte === 0) {
    return {
      totalLines: null,
      startLine: 0,
      endLine: 0,
      hasMoreBefore: false,
      lines: [],
      startByte: 0,
      endByte: 0,
    }
  }

  const handle = await fs.open(logPath, 'r')
  const chunkSize = 64 * 1024
  const chunks: Buffer[] = []
  let cursor = endByte
  let newlineCount = 0
  let sawNonEmptyContent = false

  try {
    while (cursor > 0 && newlineCount <= limit) {
      const readSize = Math.min(chunkSize, cursor)
      const start = cursor - readSize
      const buffer = Buffer.allocUnsafe(readSize)
      const { bytesRead } = await handle.read(buffer, 0, readSize, start)
      if (bytesRead <= 0) break
      const chunk = buffer.subarray(0, bytesRead)
      chunks.unshift(chunk)
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1
        if (byte > 0x20) sawNonEmptyContent = true
      }
      cursor = start
    }
  } finally {
    await handle.close()
  }

  const buffer = Buffer.concat(chunks)
  let contentEnd = buffer.length
  if (contentEnd > 0 && buffer[contentEnd - 1] === 0x0a) {
    contentEnd -= 1
  }

  const lineStarts = [0]
  for (let index = 0; index < contentEnd; index += 1) {
    if (buffer[index] === 0x0a) {
      lineStarts.push(index + 1)
    }
  }

  const selectedStarts = lineStarts.slice(-limit)
  const selectedLines = selectedStarts.map((startOffset, index) => {
    const nextStart = selectedStarts[index + 1]
    let endOffset = nextStart === undefined ? contentEnd : nextStart - 1
    if (endOffset > startOffset && buffer[endOffset - 1] === 0x0d) {
      endOffset -= 1
    }
    return buffer.subarray(startOffset, endOffset).toString('utf8')
  })

  if (contentEnd === 0 && !sawNonEmptyContent) {
    return {
      totalLines: null,
      startLine: 0,
      endLine: 0,
      hasMoreBefore: cursor > 0,
      lines: [],
      startByte: endByte,
      endByte,
    }
  }

  const selectedStartByte = selectedStarts[0] ?? contentEnd
  const startByte = Math.max(0, cursor + selectedStartByte)
  const lineKeys = selectedStarts.map((startOffset) => `b:${cursor + startOffset}`)

  return {
    totalLines: null,
    startLine: 0,
    endLine: selectedLines.length,
    hasMoreBefore: startByte > 0,
    lines: selectedLines,
    lineKeys,
    startByte,
    endByte,
  }
}

async function readLogLineWindow(
  logPath: string,
  stats: { size: number; mtimeMs: number },
  limit: number,
  beforeLine: number,
  beforeByte?: number
): Promise<LogLineWindow> {
  // Don't cache oversized logs; stream a bounded window so memory stays in check.
  if (stats.size > MAX_CACHEABLE_LOG_BYTES) {
    if (beforeByte !== undefined && Number.isFinite(beforeByte)) {
      return readLogLineWindowFromEnd(logPath, stats, limit, beforeByte)
    }
    if (!Number.isFinite(beforeLine)) {
      return readLogLineWindowFromEnd(logPath, stats, limit, stats.size)
    }
    return streamLogLineWindow(logPath, limit, beforeLine)
  }

  const cached = LOG_LINE_CACHE.get(logPath)
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    // Refresh recency: re-inserting moves the key to the end of the Map.
    LOG_LINE_CACHE.delete(logPath)
    LOG_LINE_CACHE.set(logPath, cached)
    return selectLineWindow(cached.lines, limit, beforeLine)
  }

  const lines = await readAllLogLines(logPath)
  // Reconcile byte accounting against the CURRENT entry (re-read after the await,
  // not the pre-await `cached`) so two concurrent misses for the same path can't
  // double-count and skew the cache budget.
  const prior = LOG_LINE_CACHE.get(logPath)
  if (prior) {
    LOG_LINE_CACHE.delete(logPath)
    logLineCacheBytes -= prior.size
  }
  LOG_LINE_CACHE.set(logPath, { size: stats.size, mtimeMs: stats.mtimeMs, lines })
  logLineCacheBytes += stats.size
  enforceLogCacheBudget()
  return selectLineWindow(lines, limit, beforeLine)
}


const MAX_DIRECTORY_ENTRIES = 200

function createConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Must run before any tmux spawn: a server started from inside an agentboard
// window inherits $TMUX and would otherwise operate on the live socket.
{
  assertTestTmuxIsolation(process.env)
  const nested = applyNestedTmuxDecision(process.env)
  if (nested.action === 'refuse') {
    logger.error('tmux_nested_refused', {
      inheritedTmux: nested.inheritedTmux,
      paneSession: nested.paneSession,
      message: nested.message,
    })
    flushLogger()
    process.exit(1)
  } else if (nested.action === 'isolate') {
    logger.info('tmux_nested_isolated', {
      inheritedTmux: nested.inheritedTmux,
      tmuxTmpDir: nested.tmuxTmpDir,
    })
  } else if (nested.action === 'allow') {
    logger.warn('tmux_nested_allowed', { inheritedTmux: nested.inheritedTmux })
  }
}
checkPortAvailable(config.port)
// Instrument sync fs/sqlite calls: stall samples show the blocked main
// thread dominated by pread() and JIT'd JS, and no call site is otherwise
// named. Install before initDatabase — its cached prepared statements must
// come through the patched prepare()/query() to be wrapped.
installSyncIoTiming()
// Refuse to share a data dir with a live agentboard server — the reconcile
// loop would orphan that server's session claims (they're windows it can't
// see). Isolated instances set AGENTBOARD_DATA_DIR and lock their own dir.
try {
  acquireInstanceLock(config.dataDir, config.port)
} catch (error) {
  if (error instanceof InstanceLockError) {
    logger.error('instance_lock_held', {
      dataDir: config.dataDir,
      holderPid: error.holder.pid,
      holderPort: error.holder.port,
      holderSince: error.holder.startedAt,
    })
    flushLogger()
    process.exit(1)
  }
  throw error
}
ensureTmux()
const resolvedTerminalMode = resolveTerminalMode()
logger.info('terminal_mode_resolved', {
  configured: config.terminalMode,
  resolved: resolvedTerminalMode,
})

const previewCert = process.env.PREVIEW_TLS_CERT || config.tlsCert
const previewKey = process.env.PREVIEW_TLS_KEY || config.tlsKey
const previewCertificates = new PreviewCertificates(previewCert || previewKey ? { cert: previewCert, key: previewKey } : undefined)
const previews = new PreviewServers({
  hostname: config.hostname,
  getCertificate: hostname => previewCertificates.get(hostname),
  forceTls: Boolean(config.tlsCert && config.tlsKey),
  onTlsError: () => logger.warn('preview_tls_refresh_failed'),
})
const accessGrantsFile = path.join(config.dataDir, 'access-grants.json')
const boardAccess = createBoardAccessGate(process.env.AGENTBOARD_ACCESS_TOKEN_FILE, accessGrantsFile)
const app = new Hono()
// Preview apps run on another port. Reject their requests before any board
// route (including GET endpoints) and before terminal WebSocket upgrades.
app.use('/api/*', async (c, next) => {
  const rejected = crossOriginRejection(c.req.raw, new URL(c.req.url).pathname,
    originPolicy(config.allowedOrigins, config.tlsCert, config.tlsKey), logger.warn)
  if (rejected) return await rejected
  await next()
})
app.route('/api/session-output', outputRoutes({
  getSession: id => db.getSessionById(id), previews, blockedPorts: () => [config.port, httpServer.port!], cacheRoot: process.env.AGENTBOARD_DATA_DIR || path.join(os.homedir(), '.agentboard'),
  ready: () => tailscaleReady,
}))
const db = initDatabase({ exclusive: true })
const sessionReader = db.db?.filename && db.db.filename !== ':memory:'
  ? new SessionReadClient(db.db.filename)
  : undefined

// Read mouse mode setting from DB (default: true)
const TMUX_MOUSE_MODE_KEY = 'tmux_mouse_mode'
const storedMouseMode = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
const initialMouseMode = storedMouseMode === null ? true : storedMouseMode === 'true'

// Read history max age hours setting from DB (default: 24). Keep the DB key
// stable so existing settings survive the rename from Inactive to History.
const HISTORY_MAX_AGE_HOURS_KEY = 'inactive_max_age_hours'
const storedHistoryMaxAgeHours = db.getAppSetting(HISTORY_MAX_AGE_HOURS_KEY)
let runtimeHistoryMaxAgeHours = storedHistoryMaxAgeHours !== null
  ? Number(storedHistoryMaxAgeHours)
  : config.historySessionMaxAgeHours
if (!Number.isFinite(runtimeHistoryMaxAgeHours) || runtimeHistoryMaxAgeHours < 1) {
  runtimeHistoryMaxAgeHours = 24
}

// Read prefer-window-name setting from DB. The env var
// (AGENTBOARD_PREFER_WINDOW_NAME, already folded into config) is only the
// initial default; once set from the UI the stored value wins.
const PREFER_WINDOW_NAME_KEY = 'prefer_window_name'
const storedPreferWindowName = db.getAppSetting(PREFER_WINDOW_NAME_KEY)
if (storedPreferWindowName !== null) {
  config.preferWindowName = storedPreferWindowName === 'true'
}

// Read the global terminal color setting from DB. Enabled by default so an
// ambient NO_COLOR on the Agentboard process does not flatten every managed
// terminal. Once saved from the UI, the persisted value wins.
const TERMINAL_COLORS_ENABLED_KEY = 'terminal_colors_enabled'
const storedTerminalColorsEnabled = db.getAppSetting(TERMINAL_COLORS_ENABLED_KEY)
if (storedTerminalColorsEnabled !== null) {
  config.terminalColorsEnabled = storedTerminalColorsEnabled === 'true'
}

// Reaps the login shells tmux leaks for grouped sessions (see
// tmuxGroupedSession.ts). Grouped-session creation only arms its timer.
const throwawayShellReaper = new ThrowawayShellReaper({
  getServerPid: () => sessionManager.getTmuxServerPid(),
})
const noteGroupedSessionCreated = () => throwawayShellReaper.noteGroupedSessionCreated()

const sessionManager = new SessionManager(undefined, {
  onGroupedSessionCreated: noteGroupedSessionCreated,
  displayNameExists: (name, excludeSessionId) => db.displayNameExists(name, excludeSessionId),
  mouseMode: initialMouseMode,
  terminalColorsEnabled: config.terminalColorsEnabled,
})
// Ensure the base tmux session exists so listing/orphan logic has a real
// session to read from. SessionManager creates it with a placeholder window
// (filtered out of listings) when missing. This stays a synchronous probe at
// module load: ws attach paths and startup auto-resume both assume the base
// exists once the server accepts connections, and its canPruneWsSessions
// verdict is the authoritative decision for ws pruning below — re-probing
// after the session exists would flip an "unreliable" lookup to "reliable"
// and risk pruning sessions the lookup never recovered.
let startupEnsureResult: { canPruneWsSessions: boolean }
try {
  startupEnsureResult = sessionManager.ensureSession()
} catch (error) {
  startupEnsureResult = { canPruneWsSessions: false }
  logger.warn('startup_ensure_session_failed', {
    message: error instanceof Error ? error.message : String(error),
  })
}


function ensureBaseSessionForRefresh(context: string): boolean {
  try {
    sessionManager.ensureSession()
    return true
  } catch (error) {
    logger.warn('base_session_ensure_failed', {
      context,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
// Refresh-tick variant: the steady-state probe runs without blocking the
// event loop (see SessionManager.ensureSessionAsync).
async function ensureBaseSessionForRefreshAsync(context: string): Promise<boolean> {
  try {
    await sessionManager.ensureSessionAsync()
    return true
  } catch (error) {
    logger.warn('base_session_ensure_failed', {
      context,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
const registry = new SessionRegistry()
const thumbnailClient = new MediaThumbnailClient()
const prProvider = createPrStatusProvider(path.join(config.dataDir, 'pr-status.sqlite'), infos => {
  const local = boardPrStatus.changes(infos)
  if (local.length) broadcast({ type: 'pr-status', infos: local })
})
const boardPrStatus = new BoardPrStatus(prProvider)
prProvider.mount(app)
app.route('/api', boardPrStatus.routes())
const metadataPublisher = new SessionMetadataPublisher(registry, config.hostLabel)
const metadataClient = new SessionMetadataClient((record, metadata) => {
  boardPrStatus.discover(metadata.prs)
  metadataPublisher.queue(record, metadata)
})

function toAgentSession(record: AgentSessionRecord): AgentSession {
  metadataClient.queue(record)
  return { ...buildAgentSession(record, { cachedPrsOnly: true }), ...metadataClient.get(record) }
}
// Test adapters may implement SessionDatabase without a SQLite connection.
function persistenceHostId(): string {
  const existing = db.getAppSetting('persistence_host_id')
  if (existing) return existing
  const id = createConnectionId()
  db.setAppSetting('persistence_host_id', id)
  return id
}
const persistence = db.db
  ? new PersistentSessions(db, sessionManager, persistenceHostId(), undefined, undefined, undefined, sessionReader)
  : null
const persistenceRuntime = persistence
  ? new PersistenceRuntime(persistence, db)
  : null
function createPersistentWindow(
  projectPath: string,
  name?: string,
  command?: string,
  options?: { excludeSessionId?: string; operationId?: string }
) {
  return persistence
    ? persistence.launch(projectPath, name, command, options)
    : sessionManager.createWindow(projectPath, name, command, options)
}

interface WSData {
  access: BoardAccess
  catalogVersion: number | null
  stopUpgradeNotice?: () => void
  relay?: boolean
  terminal: ITerminalProxy | null
  currentSessionId: string | null
  currentTmuxTarget: string | null
  connectionId: string
  remoteAddress: string | null
  userAgent: string | null
  terminalHost: string | null
  terminalAttachSeq: number
  copyModeQuery: CopyModeQuery
  lastAttachKey: string | null
  lastAttachTs: number
  clipboardPollTimer: ReturnType<typeof setInterval> | null
  clipboardPollInFlight: boolean
  lastClipboardBufferKey: string | null
  clipboardBufferArmedUntil: number
  // Unix seconds of the arming gesture. Only buffers created at or after this
  // are offered, so an unrelated/pre-existing buffer change during the armed
  // window can't clobber the clipboard.
  clipboardArmedAtSec: number
  // Incremented on every stop/restart of the clipboard watch. Async work
  // (baseline read, in-flight poll) captures the generation at launch and bails
  // if it no longer matches, so a stale completion can't mutate a newer watch.
  clipboardWatchGen: number
}

const sockets = new Set<ServerWebSocket<WSData>>()
// Unit handler tests retain the in-process adapter; real servers use the relay.
const relayEnabled = (process.env.AGENTBOARD_TERMINAL_RELAY ?? (process.env.NODE_ENV === 'test' ? '0' : '1')) !== '0'
let terminalRelay: TerminalRelayClient | null = null
const relayPeers = new Map<string, ServerWebSocket<WSData>>()
const relayLeaseIds = new Set<string>()
const localHostLabel = config.hostLabel
const CLIPBOARD_BUFFER_POLL_MS = 750
const CLIPBOARD_BUFFER_MAX_BYTES = 512 * 1024
const CLIPBOARD_BUFFER_ARM_MS = 5000
const SGR_MOUSE_INPUT_RE = new RegExp(
  `${String.fromCharCode(0x1b)}\\[<(\\d+);\\d+;\\d+[Mm]`,
  'g'
)

interface TmuxBufferSummary {
  name: string
  created: number
  size: number
  // Monotonic index parsed from tmux's automatic buffer name (buffer0001,
  // buffer0002, …); -1 for explicitly named buffers. Used as the recency
  // tiebreaker when buffer_created collides at whole-second resolution.
  order: number
  key: string
}

function stampLocalSession(session: Session): Session {
  return {
    ...session,
    host: localHostLabel,
    remote: false,
  }
}

function stampLocalSessions(sessions: Session[]): Session[] {
  return sessions.map(stampLocalSession)
}

// Remote session create is optimistic (we broadcast `session-created` immediately),
// but the remote poller snapshot can lag behind. Protect newly-created remote ids
// so refresh cycles don't drop them until the poller catches up.
const PROTECTED_REMOTE_SESSION_TTL_MS = 30_000
const protectedRemoteSessionIds = new Map<string, number>()

// Remote control operations (kill/rename) are also optimistic, but refresh cycles rebuild
// remote sessions from the poller snapshot. Track short-lived overrides so stale snapshots
// don't resurrect killed sessions or revert renames.
const REMOTE_SESSION_MUTATION_TTL_MS = Math.max(30_000, config.remoteStaleMs)
const remoteSessionTombstones = new Map<string, number>()
const remoteSessionNameOverrides = new Map<string, { name: string; setAt: number }>()

const wakeInFlight = new Set<string>()
const killRateLimiter = new KillRateLimiter()

function mergeRemoteSessions(sessions: Session[]): Session[] {
  const remoteSessions = (remotePoller?.getSessions() ?? []).map(session => ({
    ...session,
    ...remoteConversationMetadata(session),
    boardGrantId: remoteSessionGrant(session.host, session.remoteTmuxIdentity),
  }))
  const needsMerge =
    protectedRemoteSessionIds.size > 0 ||
    remoteSessionTombstones.size > 0 ||
    remoteSessionNameOverrides.size > 0
  if (!needsMerge) {
    return [...stampLocalSessions(sessions), ...remoteSessions]
  }

  const now = Date.now()
  const remoteIds = new Set(remoteSessions.map((session) => session.id))
  const remoteById = new Map(remoteSessions.map((session) => [session.id, session]))
  const byId = new Map(registry.getAll().map((session) => [session.id, session]))
  const protectedSessions: Session[] = []

  for (const [id, killedAt] of remoteSessionTombstones) {
    const host = remoteById.get(id)?.host
    if (!host || remotePoller.getLastSuccessfulPollAt(host) - killedAt > REMOTE_SESSION_MUTATION_TTL_MS) {
      remoteSessionTombstones.delete(id)
    }
  }

  for (const [id, override] of remoteSessionNameOverrides) {
    const polled = remoteById.get(id)
    if (!polled?.host || polled.name === override.name ||
        remotePoller.getLastSuccessfulPollAt(polled.host) - override.setAt > REMOTE_SESSION_MUTATION_TTL_MS) {
      remoteSessionNameOverrides.delete(id)
    }
  }

  for (const [id, addedAt] of protectedRemoteSessionIds) {
    if (now - addedAt > PROTECTED_REMOTE_SESSION_TTL_MS) {
      protectedRemoteSessionIds.delete(id)
      continue
    }
    if (remoteIds.has(id)) {
      // Poller has discovered it; no longer needs protection.
      protectedRemoteSessionIds.delete(id)
      continue
    }
    const existing = byId.get(id)
    if (existing?.remote) {
      protectedSessions.push(existing)
    } else {
      // Session disappeared from registry (killed/failed); stop protecting it.
      protectedRemoteSessionIds.delete(id)
    }
  }

  const mergedRemote: Session[] = []
  for (const session of remoteSessions) {
    if (remoteSessionTombstones.has(session.id)) continue
    const override = remoteSessionNameOverrides.get(session.id)
    if (override) {
      mergedRemote.push({ ...session, name: override.name })
    } else {
      mergedRemote.push(session)
    }
  }

  return [...stampLocalSessions(sessions), ...protectedSessions, ...mergedRemote]
}

let hostStatuses: HostStatus[] = []
let hostStatusSnapshot = ''

function updateHostStatuses(remoteStatuses: HostStatus[]) {
  const next = [
    {
      host: localHostLabel,
      ok: true,
      lastUpdated: new Date().toISOString(),
    },
    ...remoteStatuses,
  ]
  const snapshot = JSON.stringify(next)
  if (snapshot === hostStatusSnapshot) return
  hostStatusSnapshot = snapshot
  hostStatuses = next
  broadcast({ type: 'host-status', hosts: hostStatuses })
}

const BOARD_REMOTE_HOSTS_KEY = 'board_remote_hosts'
const initialRemoteHosts = new Set(config.remoteHosts)
const canAddRemoteHosts = process.env.AGENTBOARD_REMOTE_ALLOW_ADD_HOSTS === 'true'
try {
  const stored: unknown = JSON.parse(db.getAppSetting(BOARD_REMOTE_HOSTS_KEY) ?? '[]')
  if (Array.isArray(stored)) {
    for (const host of stored) {
      if (typeof host === 'string' && isValidHostname(host) && !config.remoteHosts.includes(host)) {
        config.remoteHosts.push(host)
      }
    }
  }
} catch {
  logger.warn('invalid_stored_remote_hosts')
}

const remotePoller = new RemoteSessionPoller({
  hosts: config.remoteHosts,
  pollIntervalMs: config.remotePollMs,
  timeoutMs: config.remoteTimeoutMs,
  staleAfterMs: config.remoteStaleMs,
  sshOptions: config.remoteSshOpts,
  tmuxSessionPrefix: config.tmuxSession,
  discoverPrefixes: config.discoverPrefixes,
  onUpdate: updateHostStatuses,
  boundCodexId: loadRemoteConversationId,
  loadSnapshot: (host) => {
    try {
      const stored = JSON.parse(db.getAppSetting('remote_session_snapshot:' + host) ?? 'null')
      if (stored && Array.isArray(stored.sessions) && Number.isFinite(stored.updatedAt)) return stored
    } catch {
      logger.warn('invalid_remote_session_snapshot', { host })
    }
    return undefined
  },
  saveSnapshot: (host, snapshot) => db.setAppSetting('remote_session_snapshot:' + host, JSON.stringify(snapshot)),
})
remotePoller.start()
updateHostStatuses(remotePoller.getHostStatuses())

// Lock map for Enter-key lastUserMessage capture: tmuxWindow -> expiry timestamp
// Prevents stale log data from overwriting fresh terminal captures
const lastUserMessageLocks = new Map<string, number>()
const LAST_USER_MESSAGE_LOCK_MS = 60_000 // 60 seconds

const logPoller = new LogPoller(db, registry, {
  reader: sessionReader,
  onSessionUpdated: (record) => {
    if (persistence) refreshDormantConversation(persistence.catalog, record)
    if (record.currentWindow) metadataClient.queue(record)
    if (!record.currentWindow) queueDormantRefresh()
  },
  onSessionOrphaned: (sessionId, supersededBy) => {
    // Scan first: the dormant lists read PRs from the cache this scan fills.
    const session = db.getSessionById(sessionId)
    const orphaned = session ? toAgentSession(session) : null
    updateDormantAgentSessions()
    if (orphaned) {
      broadcast({ type: 'session-orphaned', session: orphaned, supersededBy })
    }
  },
  allowsMatch: (window, sessionId) => ownershipMatcher?.allows(window, sessionId) ?? true,
  onSessionActivated: (sessionId, window) => {
    updateDormantAgentSessions()
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({
        type: 'session-activated',
        session: toAgentSession(session),
        window,
      })
    }
  },
  onOrphanSessionsDiscovered: () => {
    updateDormantAgentSessions()
  },
  isLastUserMessageLocked: (tmuxWindow) =>
    (lastUserMessageLocks.get(tmuxWindow) ?? 0) > Date.now(),
  maxLogsPerPoll: config.logPollMax,
  rgThreads: config.rgThreads,
  matchProfile: config.logMatchProfile,
  matchWorker: config.logMatchWorker,
})
const sessionRefreshWorker = new SessionRefreshWorkerClient()
const lastUserMessageWorker = new SessionRefreshWorkerClient()
const ownershipMatcher = config.ownershipMatching ? new OwnershipMatcher({
  db,
  windows: () => registry.getAll(),
  missing: result => {
    // Queue exact Codex paths through the existing enrichment worker. Claude
    // transcripts enter through normal discovery; their registry has no path.
    if (result.transcript) void logPoller.pollChanged([result.transcript])
  },
  changed: (sessionId, window, previous) => {
    refreshGeneration++
    logger.info('session_matched_by_ownership', { sessionId, window, previous })
    if (previous) {
      const old = db.getSessionById(previous)
      if (old) broadcast({ type: 'session-orphaned', session: toAgentSession(old), supersededBy: sessionId })
    }
    const record = db.getSessionById(sessionId)!
    const live = registry.getAll().find(session => session.tmuxWindow === window && !session.remote)
    if (live) registry.updateSession(live.id, {
      agentSessionId: sessionId, agentSessionName: record.displayName,
      logFilePath: record.logFilePath, lastUserMessage: record.lastUserMessage ?? undefined,
    })
    broadcast({ type: 'session-activated', session: toAgentSession(record), window })
    updateDormantAgentSessions()
    refreshSessions()
  },
}) : null
const ownershipObserver = config.ownershipObserver || ownershipMatcher ? (() => {
  const io = createLocalOwnershipIO({ codexHome: config.codexHomeDir, claudeHome: config.claudeConfigDir })
  return new OwnershipObserver({
    windows: () => registry.getAll(),
    probe: windows => probeOwnership(windows, io),
    accept: (result, window) => ownershipMatcher?.accept(result, window),
    log: (event, data) => {
      if (event === 'ownership_observation_summary') logger.debug(event, data)
      else logger.info(event, data)
    },
  })
})() : null

// Active sessions update on every refresh — cheap (few rows).
// History sessions query is expensive — only run on actual mutations.
function filterExcludedAgentSessions(sessions: AgentSession[]): AgentSession[] {
  const excludedProjects = config.excludeProjects ?? []
  if (excludedProjects.length === 0) {
    return sessions
  }

  return sessions.filter((session) => {
    const projectPath = session.projectPath || ''
    return !excludedProjects.some((excluded) => {
      if (excluded === '<empty>') return projectPath === ''
      return projectPath.startsWith(excluded)
    })
  })
}

function updateActiveAgentSessions() {
  const active = hasConfirmedLocalSessionSnapshot
    ? db.getActiveSessions().map((record) => toAgentSession(record))
    : []
  const current = registry.getAgentSessions()
  registry.setAgentSessions(
    active,
    current.hibernating,
    current.history
  )
}

/**
 * Most recent History rows the sidebar shows. Older rows stay in the database
 * and remain visible to the orphan rematcher, which queries uncapped.
 */
const SIDEBAR_HISTORY_LIMIT = 100

function getDormantRecords() {
  return {
    hibernating: db.getHibernatingSessions(),
    history: db.getHistorySessions({
      maxAgeHours: runtimeHistoryMaxAgeHours,
      limit: SIDEBAR_HISTORY_LIMIT,
    }),
  }
}

// Codex subagent links arrive with the first full poll, after the startup PR
// scan, and in bursts as live links register. Re-queue the dormant rows once
// per burst; the worker revalidates the logs without blocking this thread.
let dormantRescanQueued = false
setCodexSubagentIndexListener(() => {
  if (dormantRescanQueued) return
  dormantRescanQueued = true
  setTimeout(() => {
    dormantRescanQueued = false
    metadataClient.setIndex(getCodexSubagentIndex())
    activityClient.setIndex(getCodexSubagentIndex())
    for (const record of db.getActiveSessions()) metadataClient.queue(record)
    const { hibernating, history } = getDormantRecords()
    for (const record of [...hibernating, ...history]) metadataClient.queue(record)
  }, 0)
})

// A poll can update many dormant rows. Refresh the published sidebar snapshot
// once after that batch, rather than retaining the import-time messages.
let dormantRefreshQueued = false
function queueDormantRefresh() {
  if (dormantRefreshQueued) return
  dormantRefreshQueued = true
  queueMicrotask(() => {
    dormantRefreshQueued = false
    updateDormantAgentSessions()
  })
}

// All views use remembered descriptors. The worker publishes metadata changes
// directly without rebuilding rows or replaying lifecycle state.
function updateDormantAgentSessions() {
  const { hibernating: hibernatingRecords, history: historyRecords } =
    getDormantRecords()
  const hibernating = filterExcludedAgentSessions(
    hibernatingRecords.map((record) => toAgentSession(record))
  )
  const history = filterExcludedAgentSessions(
    historyRecords.map((record) => toAgentSession(record))
  )
  const active = hasConfirmedLocalSessionSnapshot
    ? db.getActiveSessions().map((record) => toAgentSession(record))
    : []
  registry.setAgentSessions(active, hibernating, history)
}

interface HydrateSessionsOptions {
  verifyAssociations?: boolean
  precomputedVerifications?: Map<string, VerificationDecision>
  // tmux server pid reported by the window enumeration; 0 means the
  // enumeration cannot vouch for window identity (skip catalog reconcile).
  serverPid?: number
}


export function hydrateSessionsWithAgentSessions(
  sessions: Session[],
  { verifyAssociations = false, precomputedVerifications, serverPid = 0 }: HydrateSessionsOptions = {}
): Session[] {
  persistence?.beforeSnapshot(sessions, serverPid)
  const activeSessions = db.getActiveSessions()
  // Discovery can be stale or incomplete. Reconcile missing windows without
  // ever turning a background observation into a destructive tmux command.
  const reconciled = [...sessions]
  // An empty snapshot already has a skip-cycle contract. Preserve its rows
  // without synchronous probes; one uncertain probe also ends checks for this
  // cycle so a tmux outage cannot cost one timeout per tracked session.
  let probesAvailable = sessions.length > 0
  const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
  const activeMap = new Map<string, typeof activeSessions[number]>()
  const orphaned: AgentSession[] = []
  const logDirs = verifyAssociations && !precomputedVerifications
    ? getLogSearchDirs()
    : []

  for (const agentSession of activeSessions) {
    const precomputed = precomputedVerifications?.get(agentSession.sessionId)
    const currentWindow = agentSession.currentWindow
    const windowExists = Boolean(currentWindow && windowSet.has(currentWindow))

    if (!windowExists || !currentWindow) {
      if (currentWindow) {
        const presence = probesAvailable ? sessionManager.probeWindow(currentWindow) : 'unknown'
        if (presence === 'unknown') probesAvailable = false
        logger.warn('session_window_missing_from_snapshot', {
          sessionId: agentSession.sessionId,
          currentWindow,
          presence,
          snapshotWindows: [...windowSet],
        })
        if (presence !== 'absent') {
          const previous = registry.get(currentWindow)
          reconciled.push({
            ...(previous && !previous.remote ? previous : {
              id: currentWindow,
              tmuxWindow: currentWindow,
              name: agentSession.displayName,
              projectPath: agentSession.projectPath,
              lastActivity: agentSession.lastActivityAt,
              createdAt: agentSession.createdAt,
              source: currentWindow.startsWith(`${config.tmuxSession}:`)
                ? 'managed' as const
                : 'external' as const,
            }),
            status: 'unknown',
          })
          activeMap.set(currentWindow, agentSession)
          continue
        }
      }
      logger.info('session_orphaned', {
        sessionId: agentSession.sessionId,
        displayName: agentSession.displayName,
        currentWindow: agentSession.currentWindow,
        windowSetSize: windowSet.size,
        windowSetSample: Array.from(windowSet).slice(0, 5),
      })
      // A missing or mismatched identity is not authorization to kill a pane.
      const orphanedSession = db.orphanSession(agentSession.sessionId)
      if (orphanedSession) {
        orphaned.push(toAgentSession(orphanedSession))
      }
      continue
    }

    let verification: WindowLogVerificationResult | null = null
    let nameMatches = false

    const liveWindow = sessions.find(session => session.tmuxWindow === currentWindow)
    // Positive process evidence outranks text, including stale startup worker
    // results. Keep the old claim while a new owned transcript is discovered.
    if (liveWindow && ownershipMatcher?.get({ ...liveWindow,
      agentType: liveWindow.agentType ?? agentSession.agentType, agentSessionId: agentSession.sessionId,
    })) {
      verification = { status: 'verified', bestMatch: null }
    } else if (precomputed) {
      verification = precomputed.verification
      nameMatches = precomputed.nameMatches
    } else if (verifyAssociations) {
      const otherSessionLogPaths = activeSessions
        .filter((s) => s.sessionId !== agentSession.sessionId && s.currentWindow)
        .map((s) => s.logFilePath)

      verification = verifyWindowLogAssociationDetailed(
        currentWindow,
        agentSession.logFilePath,
        logDirs,
        {
          context: {
            agentType: agentSession.agentType,
            projectPath: agentSession.projectPath,
          },
          excludeLogPaths: otherSessionLogPaths,
        }
      )

      const window = sessions.find((s) => s.tmuxWindow === currentWindow)
      nameMatches = Boolean(window && window.name === agentSession.displayName)
    }

    if (verification) {
      let shouldOrphan = false
      let fallbackUsed = false

      if (verification.status === 'verified') {
        shouldOrphan = false
      } else if (nameMatches) {
        shouldOrphan = false
        fallbackUsed = true
      } else {
        shouldOrphan = true
      }

      if (shouldOrphan) {
        logger.info('session_verification_failed', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow,
          logFilePath: agentSession.logFilePath,
          verificationStatus: verification.status,
          verificationReason: verification.reason ?? null,
          nameMatches,
          bestMatchLog: verification.bestMatch?.logPath ?? null,
        })
        const orphanedSession = db.orphanSession(agentSession.sessionId, {
          hibernate: false,
        })
        if (orphanedSession) {
          orphaned.push(toAgentSession(orphanedSession))
        }
        continue
      }

      if (fallbackUsed) {
        logger.info('session_verification_name_fallback', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow,
          verificationStatus: verification.status,
        })
      }
    }

    activeMap.set(currentWindow, agentSession)
  }

  const hydrated = reconciled.map((session) => {
    const agentSession = activeMap.get(session.tmuxWindow)
    if (!agentSession) {
      return session
    }
    if (agentSession.displayName !== session.name) {
      db.updateSession(agentSession.sessionId, { displayName: session.name })
      agentSession.displayName = session.name
    }
    return {
      ...session,
      // Use log-based agentType if command-based detection failed
      agentType: session.agentType ?? agentSession.agentType,
      agentSessionId: agentSession.sessionId,
      agentSessionName: agentSession.displayName,
      logFilePath: agentSession.logFilePath,
      lastUserMessage: agentSession.lastUserMessage ?? session.lastUserMessage,
      ...metadataClient.get(agentSession),
      // Use persisted log times (survives server restarts, works when tmux lacks creation time)
      lastActivity: agentSession.lastActivityAt,
      createdAt: agentSession.createdAt,
      isHibernating: agentSession.isHibernating,
    }
  })

  if (orphaned.length > 0) {
    for (const session of orphaned) {
      broadcast({ type: 'session-orphaned', session })
    }
    updateDormantAgentSessions()
  } else {
    updateActiveAgentSessions()
  }
  persistence?.observe(hydrated)
  return hydrated
}

const activityClient = new SessionActivityClient(patches => {
  const byKey = new Map(patches.map(patch => [patch.key, patch]))
  for (const session of registry.getAll()) {
    const patch = byKey.get(activityKey(session))
    if (patch && !session.remote) registry.updateSession(session.id, { activity: patch.activity })
  }
})
let refreshInFlight = false
// Bumped on optimistic registry mutations (kill, create, resume) so
// in-flight refreshes that started before the mutation discard their stale
// window list instead of reverting the optimistic update.
let refreshGeneration = 0
let hasConfirmedLocalSessionSnapshot = false
let lastSuccessfulRefreshWindowCount = 1
let refreshWindowCountFloor = 0
let startupExpectedWindowCount = 1

function normalizeWindowCount(windowCount: number): number {
  return Math.max(
    1,
    Number.isFinite(windowCount) ? Math.floor(windowCount) : 0
  )
}

function countLocalSessions(sessions: Session[]): number {
  return sessions.filter((session) => !session.remote).length
}

function seedRefreshWindowCountEstimate(localSessionCount: number): void {
  startupExpectedWindowCount = normalizeWindowCount(localSessionCount)
}

function recordSuccessfulRefreshWindowCount(localSessionCount: number): void {
  hasConfirmedLocalSessionSnapshot = true
  lastSuccessfulRefreshWindowCount = normalizeWindowCount(localSessionCount)
  refreshWindowCountFloor = 0
  startupExpectedWindowCount = 1
}

function shouldSkipSyncRefreshFallback(error: unknown): boolean {
  return error instanceof SessionRefreshWorkerTimeoutError
}

function estimateRefreshWindowCount(): number {
  const localSessionCount = registry.getAll().filter((session) => !session.remote).length
  return Math.max(
    1,
    localSessionCount,
    lastSuccessfulRefreshWindowCount,
    refreshWindowCountFloor,
    startupExpectedWindowCount
  )
}

function noteRefreshTimeout(): number {
  const currentEstimate = estimateRefreshWindowCount()
  const nextEstimate = Math.max(currentEstimate + 4, currentEstimate * 2)
  refreshWindowCountFloor = nextEstimate
  return nextEstimate
}

async function refreshSessionsAsync(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    if (!(await ensureBaseSessionForRefreshAsync('async_refresh'))) {
      return
    }
    // Loop: retry once if an optimistic mutation invalidated our snapshot.
    // At most one retry — if another mutation lands during the retry,
    // the next scheduled refresh will pick it up.
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = refreshGeneration
      try {
        const { sessions, tmuxServerPid } = await sessionRefreshWorker.refresh(
          config.tmuxSession,
          config.discoverPrefixes,
          {
            expectedWindowCount: estimateRefreshWindowCount(),
            preferWindowName: config.preferWindowName,
          }
        )
        // Mutation happened while we were listing windows — discard and retry
        if (gen !== refreshGeneration) continue
        // Yield before blocking SQLite work so pending WebSocket buffers flush
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        if (gen !== refreshGeneration) continue
        const tHydrate = performance.now()
        recordSuccessfulRefreshWindowCount(countLocalSessions(sessions))
        const hydrated = hydrateSessionsWithAgentSessions(sessions, { serverPid: tmuxServerPid })
        const observed = activityClient.enrich(hydrated)
        if (gen !== refreshGeneration) continue
        const withOverrides = applyForceWorkingOverrides(observed)
        registry.replaceSessions(mergeRemoteSessions(withOverrides))
        const hydrateMs = Math.round(performance.now() - tHydrate)
        if (hydrateMs > 50) {
          logger.debug('session_refresh_hydrate_slow', { hydrateMs, sessionCount: sessions.length })
        }
        return
      } catch (error) {
        // Fallback to sync on worker failure — sync listWindows sees
        // post-mutation state so no generation check needed here.
        logger.warn('session_refresh_worker_error', {
          message: error instanceof Error ? error.message : String(error),
        })
        if (shouldSkipSyncRefreshFallback(error)) {
          const nextExpectedWindowCount = noteRefreshTimeout()
          logger.warn('session_refresh_sync_fallback_skipped', {
            reason: 'worker_timeout',
            nextExpectedWindowCount,
          })
          return
        }
        const sessions = listWindowsSyncOrNull('worker_fallback')
        if (!sessions) {
          return
        }
        recordSuccessfulRefreshWindowCount(countLocalSessions(sessions))
        const hydrated = hydrateSessionsWithAgentSessions(sessions, {
          serverPid: sessionManager.lastEnumeratedServerPid,
        })
        const observed = activityClient.enrich(hydrated)
        if (gen !== refreshGeneration) continue
        const withOverrides = applyForceWorkingOverrides(observed)
        registry.replaceSessions(mergeRemoteSessions(withOverrides))
        return
      }
    }
  } finally {
    refreshInFlight = false
  }
}

function refreshSessions() {
  void refreshSessionsAsync()
}

function listWindowsSyncOrNull(context: string): Session[] | null {
  try {
    if (!ensureBaseSessionForRefresh(context)) {
      return null
    }
    return sessionManager.listWindows()
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      logger.warn('session_refresh_sync_skipped', {
        context,
        reason: 'tmux_timeout',
        timeoutMs: config.tmuxTimeoutMs,
        message: error.message,
      })
      return null
    }
    throw error
  }
}

// Sync refresh for mutation paths (create/kill/rename) so follow-up reads see
// post-mutation tmux state immediately.
function refreshSessionsSync({ verifyAssociations = false } = {}) {
  const sessions = listWindowsSyncOrNull('sync_refresh')
  if (!sessions) {
    return
  }
  recordSuccessfulRefreshWindowCount(countLocalSessions(sessions))
  const hydrated = hydrateSessionsWithAgentSessions(sessions, {
    verifyAssociations,
    serverPid: sessionManager.lastEnumeratedServerPid,
  })
  registry.replaceSessions(mergeRemoteSessions(hydrated))
}

// Debounced refresh triggered by Enter key in terminal input
let enterRefreshTimer: Timer | null = null
const lastUserMessageTimers = new Map<string, Timer>()

function setForceWorking(sessionId: string) {
  const now = Date.now()
  setForceWorkingUntil(sessionId, now + config.workingGracePeriodMs)
  // Immediately update registry so UI shows "working" right away
  const existing = registry.get(sessionId)
  const activity = Math.max(now, Date.parse(existing?.lastActivity ?? '') || 0)
  registry.updateSession(sessionId, {
    status: 'working',
    lastActivity: new Date(activity).toISOString(),
  })
}

function scheduleEnterRefresh() {
  if (enterRefreshTimer) {
    clearTimeout(enterRefreshTimer)
  }
  enterRefreshTimer = setTimeout(() => {
    enterRefreshTimer = null
    refreshSessions()
  }, config.enterRefreshDelayMs)
}

function scheduleLastUserMessageCapture(sessionId: string) {
  const session = registry.get(sessionId)
  if (!session) return
  const tmuxWindow = session.tmuxWindow

  // Set lock immediately to prevent log poller from overwriting with stale data
  // during the debounce delay (before capture completes)
  lastUserMessageLocks.set(tmuxWindow, Date.now() + LAST_USER_MESSAGE_LOCK_MS)

  const existing = lastUserMessageTimers.get(tmuxWindow)
  if (existing) {
    clearTimeout(existing)
  }
  const timer = setTimeout(() => {
    lastUserMessageTimers.delete(tmuxWindow)
    void captureLastUserMessage(tmuxWindow, session.agentType)
  }, config.enterRefreshDelayMs)
  lastUserMessageTimers.set(tmuxWindow, timer)
}

async function captureLastUserMessage(tmuxWindow: string, agentType?: AgentType) {
  try {
    const captured = await lastUserMessageWorker.getLastUserMessage(tmuxWindow, undefined, agentType)
    const message = captured?.trim() ? stripPastePlaceholders(captured) : ''
    if (!message || message !== captured) {
      // Empty capture, or a paste the TUI collapsed to a "[Pasted text …]"
      // placeholder: the JSONL log has the real prompt, so release the
      // Enter-key lock and let the log poller supply/upgrade the summary
      // instead of blocking it for the full lock window.
      lastUserMessageLocks.delete(tmuxWindow)
    }
    if (!message) return
    const record = db.getSessionByWindow(tmuxWindow)
    if (!record) return
    if (record.lastUserMessage === message) return
    const updated = db.updateSession(record.sessionId, { lastUserMessage: message })
    if (!updated) return
    registry.updateSession(tmuxWindow, { lastUserMessage: message })
    updateActiveAgentSessions()
  } catch (error) {
    lastUserMessageLocks.delete(tmuxWindow)
    logger.warn('last_user_message_capture_error', {
      tmuxWindow,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}


// Startup DB state is captured for the startup_state log; the window listing
// itself runs after the server binds (see below) so the port accepts
// connections immediately.
const startupActiveSessions = db.getActiveSessions()
seedRefreshWindowCountEstimate(startupActiveSessions.length)

setInterval(refreshSessions, config.refreshIntervalMs) // Async periodic refresh

// Event loop lag monitor — detects when spawnSync or other blocking work
// starves the event loop, causing typing lag and slow WebSocket delivery.
// The check timer fires late exactly when a stall ends, so each warn-level
// line records one freeze's duration. Warn at >1s (user-visible stalls);
// debug covers milder jitter when LOG_LEVEL=debug.
const EL_CHECK_MS = 500
const EL_WARN_LAG_MS = 1000

// Stall watchdog — the lag monitor only reports a stall once it ends; this
// worker-side sampler runs `sample <pid>` while the loop is still blocked so
// the report names the synchronous call doing the blocking (spawnSync on a
// wedged tmux server, sync SQLite, …). Its heartbeat rides this tick — beats
// that arrive late are the stall it measures.
const stallWatchdog = new StallWatchdog({
  enabled: config.stallWatchdogEnabled,
  pid: process.pid,
  sampleDir: path.join(config.dataDir, 'stall-samples'),
  thresholdMs: config.stallWatchdogThresholdMs,
  sampleSeconds: 1,
  cooldownMs: 60_000,
  maxSamples: 20,
  checkIntervalMs: 250,
})
stallWatchdog.start()

let elLastTick = performance.now()
setInterval(() => {
  const now = performance.now()
  const lagMs = Math.round(now - elLastTick - EL_CHECK_MS)
  elLastTick = now
  stallWatchdog.beat()
  if (lagMs > 100) {
    const [load1, load5, load15] = os.loadavg()
    const payload = {
      lagMs,
      load1: Math.round(load1 * 100) / 100,
      load5: Math.round(load5 * 100) / 100,
      load15: Math.round(load15 * 100) / 100,
      cpus: os.cpus().length,
    }
    if (lagMs >= EL_WARN_LAG_MS) {
      logger.warn('event_loop_lag', payload)
    } else {
      logger.debug('event_loop_lag', payload)
    }
  }
}, EL_CHECK_MS)


registry.on('session-update', (session) => {
  broadcast({ type: 'session-update', session })
})

registry.on('sessions', (sessions) => {
  broadcast({ type: 'sessions', sessions })
})

registry.on('session-removed', (sessionId) => {
  broadcast({ type: 'session-removed', sessionId })
})

registry.on('agent-sessions', ({ active, hibernating, history }) => {
  broadcast({ type: 'agent-sessions', active, hibernating, history })
})

registry.on('agent-sessions-active', (active) => {
  broadcast({ type: 'agent-sessions-active', active })
})

app.post('/api/client-log', async (c) => {
  try {
    const body = await c.req.json() as { level?: string; event: string; data?: Record<string, unknown> }
    const level = body.level === 'warn' || body.level === 'error' || body.level === 'info' ? body.level : 'debug'
    logger[level]('client_' + body.event, body.data)
  } catch {
    // ignore malformed
  }
  return c.json({ ok: true })
})

app.get('/api/health', (c) => c.json({ ok: true }))
function remoteSessionGrantKey(host: string, identity: string) {
  return 'remote_tmux_grant:' + host + ':' + identity
}

function remoteSessionGrant(host: string | undefined, identity: string | undefined) {
  return host && identity ? db.getAppSetting(remoteSessionGrantKey(host, identity)) || undefined : undefined
}

function allowedWorkspaceHosts(access: BoardAccess | undefined) {
  if (!config.remoteAllowAttach || !access) return []
  return config.remoteHosts.filter(host => access.role === 'admin' || access.hosts.includes(host))
}

const boardProfileId = (access: BoardAccess) => access.role === 'shared' ? access.id : 'admin'

function remoteConversationKey(session: Session) {
  return 'board_remote_conversation:' + JSON.stringify([
    session.host, session.remoteTmuxIdentity, session.tmuxWindow, session.createdAt, session.agentType,
  ])
}

function loadRemoteConversationId(session: Session) {
  return session.agentType ? db.getAppSetting(remoteConversationKey(session)) ?? undefined : undefined
}

function remoteConversationMetadata(session: Session) {
  const agentSessionId = session.codexFooterSessionId ?? loadRemoteConversationId(session) ?? session.agentSessionId
  return { agentSessionId, lastResponseAt: agentSessionId === session.agentSessionId ? session.lastResponseAt : undefined }
}

app.put('/api/workspace/session-conversation', bodyLimit({ maxSize: 2048 }), async (c) => {
  const body = await c.req.json<{ id?: unknown; conversationId?: unknown; createdAt?: unknown; source?: unknown }>().catch(() => null)
  if (typeof body?.id !== 'string' || (body.source !== 'codex-status' && !validPresetConversationId(body.conversationId))) {
    return c.json({ error: 'Enter a valid harness session ID' }, 400)
  }
  const access = boardAccess.identify(c.req.raw)
  if (!access || c.req.header('X-AgentBoard-Profile') !== boardProfileId(access)) {
    return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  }
  const session = registry.get(body.id)
  if (!session?.remote || !session.remoteTmuxIdentity || !session.agentType || !canUseSession(access, session)) {
    return c.json({ error: 'Remote harness session not found' }, 404)
  }
  if (body.createdAt !== session.createdAt) return c.json({ error: 'The terminal changed. Try again.' }, 409)
  const binding = remoteConversationKey(session)
  let updated = session
  let conversationId = body.conversationId
  if (body.source === 'codex-status') {
    const host = session.host
    if (session.agentType !== 'codex' || !host || !allowedWorkspaceHosts(access).includes(host)) {
      return c.json({ error: 'Codex terminal unavailable' }, 409)
    }
    const { tmuxWindow } = session
    const format = TMUX_CLOSE_FORMAT + '\t#{pane_id}\t#{pane_pid}'
    const identify = ['display-message', '-p', '-t', tmuxWindow, format]
    const result = await runRemoteTmux(host, [
      ...identify, ';', 'capture-pane', '-p', '-J', '-t', tmuxWindow, ';', ...identify,
    ])
    const current = registry.get(session.id)
    const currentAccess = boardAccess.identify(c.req.raw)
    if (!currentAccess || boardProfileId(currentAccess) !== boardProfileId(access) ||
        !current || !canUseSession(currentAccess, current)) {
      return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
    }
    const [before, ...output] = result.stdout.trimEnd().split('\n')
    const after = output.pop()
    const fields = before.split('\t')
    const target = parseTmuxCloseTarget(fields.slice(0, 6).join('\t'), tmuxWindow)
    if (result.exitCode !== 0 || remoteConversationKey(current) !== binding ||
        before !== after || target?.sessionIdentity !== session.remoteTmuxIdentity ||
        !/^%\d+$/.test(fields[6] ?? '') || !/^\d+$/.test(fields[7] ?? '')) {
      return c.json({ error: 'Could not read this terminal. Check the connection and try again.' }, 409)
    }
    if (current.agentSessionId !== session.agentSessionId) {
      return c.json({ error: 'The session ID changed. Try again.' }, 409)
    }
    updated = current
    conversationId = codexStatusSessionId(output.join('\n'))
    if (!conversationId) {
      return c.json({ error: 'Run /status in this Codex terminal, keep the result visible, and try again.' }, 422)
    }
  }
  if (!validPresetConversationId(conversationId)) return c.json({ error: 'Enter a valid harness session ID' }, 400)
  db.setAppSetting(binding, conversationId)
  const lastResponseAt = updated.agentSessionId === conversationId ? updated.lastResponseAt : undefined
  const patch = { agentSessionId: conversationId, lastResponseAt }
  registry.updateSession(session.id, patch)
  return c.json(sessionSummary({ ...updated, ...patch }), 200, { 'Cache-Control': 'no-store' })
})

app.get('/api/access', (c) => {
  const access = boardAccess.identify(c.req.raw)
  return c.json({
    role: access?.role,
    profileId: access ? boardProfileId(access) : undefined,
    canManageTokens: boardAccess.enabled && access?.role === 'admin',
  }, 200, { 'Cache-Control': 'no-store' })
})

const organizationPath = '/api/workspace/organization'
const organizationHeaders = { 'Cache-Control': 'no-store' }
interface OpenWorkspace { id: string; name: string; sessionIds: string[] }
const workspaceListKey = (access: BoardAccess) => 'board_open_workspaces:' + boardProfileId(access)
const activeWorkspaceKey = (access: BoardAccess) => 'board_active_workspace:' + boardProfileId(access)
const organizationKey = (access: BoardAccess, workspace = 'default') =>
  'board_organization:' + boardProfileId(access) + (workspace === 'default' ? '' : ':' + workspace)

function openWorkspaces(access: BoardAccess): OpenWorkspace[] {
  return JSON.parse(db.getAppSetting(workspaceListKey(access)) ?? '[]')
}

function workspaceView(access: BoardAccess) {
  const open = openWorkspaces(access)
  const savedId = db.getAppSetting(activeWorkspaceKey(access))
  const active = open.find(workspace => workspace.id === (savedId ?? 'default'))
  const id = active?.id ?? 'default'
  const saved = db.getAppSetting(organizationKey(access, id))
  return {
    organization: saved ? JSON.parse(saved) : { groups: [], sessions: {} },
    workspace: { id, sessionIds: active?.sessionIds ?? null },
    workspaces: [{ id: 'default', name: 'Default' }, ...open.filter(entry => entry.id !== 'default').map(({ id, name }) => ({ id, name }))],
  }
}

app.get(organizationPath, (c) => {
  const access = boardAccess.identify(c.req.raw)
  if (!access) return c.json({ error: 'Authentication required' }, 401, organizationHeaders)
  const expectedProfile = c.req.header('X-AgentBoard-Profile')
  if (expectedProfile && expectedProfile !== boardProfileId(access)) {
    return c.json({ error: 'Active access token changed. Refresh to continue.' }, 409, organizationHeaders)
  }
  const saved = db.getAppSetting(organizationKey(access))
  if (!expectedProfile) return c.json(saved ? JSON.parse(saved) : { groups: [], sessions: {} }, 200, organizationHeaders)
  const { organization, ...workspace } = workspaceView(access)
  return c.json({ ...organization, ...workspace }, 200, organizationHeaders)
})

app.put(organizationPath, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
  const body = await c.req.json().catch(() => null)
  const organization = parseSessionOrganization(body)
  if (!organization) return c.json({ error: 'Invalid session organization' }, 400)
  const access = boardAccess.identify(c.req.raw)
  if (!access) return c.json({ error: 'Authentication required' }, 401, organizationHeaders)
  const expectedProfile = c.req.header('X-AgentBoard-Profile')
  if (expectedProfile && expectedProfile !== boardProfileId(access)) {
    return c.json({ error: 'Active access token changed. Refresh to continue.' }, 409, organizationHeaders)
  }
  const workspaceId = c.req.header('X-AgentBoard-Workspace') ?? 'default'
  const open = openWorkspaces(access)
  const workspace = open.find(entry => entry.id === workspaceId)
  if (workspaceId !== 'default' && !workspace) return c.json({ error: 'Invalid workspace' }, 400)
  if (workspace && body.workspaceSessionIds !== null && body.workspaceSessionIds !== undefined) {
    if (!Array.isArray(body.workspaceSessionIds) || body.workspaceSessionIds.length > 4096 ||
        body.workspaceSessionIds.some((id: unknown) => typeof id !== 'string' || id.length > 512)) {
      return c.json({ error: 'Invalid workspace' }, 400)
    }
    const previous = new Set(workspace.sessionIds)
    workspace.sessionIds = [...new Set<string>(body.workspaceSessionIds)].filter(id => {
      const session = registry.get(id)
      return previous.has(id) || !!session && canUseSession(access, session)
    })
    db.setAppSetting(workspaceListKey(access), JSON.stringify(open))
  }
  db.setAppSetting(organizationKey(access, workspaceId), JSON.stringify(organization))
  return c.json({ ok: true }, 200, organizationHeaders)
})

const presetsPath = '/api/workspace/presets'
const presetRestoreInFlight = new Set<string>()
const presetsKey = (access: BoardAccess) => 'board_presets:' + boardProfileId(access)

function accessForPreset(c: Context) {
  const access = boardAccess.identify(c.req.raw)
  return access && c.req.header('X-AgentBoard-Profile') === boardProfileId(access) ? access : undefined
}

function savedPresets(access: BoardAccess): WorkspacePreset[] {
  const value = db.getAppSetting(presetsKey(access))
  return value ? JSON.parse(value) : []
}

function presetTarget(session: Session) {
  return tmuxSessionName(session.tmuxWindow) ? session.tmuxWindow : config.tmuxSession + ':' + session.tmuxWindow
}

async function inspectPresetTarget(host: string, target: string) {
  const args = ['display-message', '-p', '-t', target, TMUX_CLOSE_FORMAT]
  const result = host
    ? await runRemoteTmux(host, args)
    : await timedSpawnAsync(['tmux', '-u', ...args], { timeout: 5000 })
  if (host && result.exitCode === 255) throw new Error('SSH connection failed')
  return result.exitCode === 0 ? parseTmuxCloseTarget(result.stdout, target) : undefined
}

app.get(presetsPath, (c) => {
  const access = accessForPreset(c)
  if (!access) return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  return c.json(savedPresets(access).map(({ id, name, terminals }) => ({
    id, name, count: terminals.length,
  })), 200, organizationHeaders)
})

async function saveWorkspacePreset(c: Context, id?: string) {
  const access = accessForPreset(c)
  if (!access) return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  const body = await c.req.json<{
    name?: unknown
    organization?: unknown
    terminals?: Array<{ id?: unknown; harness?: unknown; conversationId?: unknown }>
  }>().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const organization = parseSessionOrganization(body?.organization)
  const selections = body?.terminals
  if (!name || name.length > 80 || !organization || !Array.isArray(selections) || selections.length > 128) {
    return c.json({ error: 'Enter a name and select up to 128 sessions' }, 400)
  }
  const candidates: Array<{ session: Session; harness?: AgentType; conversationId?: string }> = []
  const ids = new Set<string>()
  for (const selection of selections) {
    const id = selection?.id
    const harness = selection?.harness
    const conversationId = selection?.conversationId
    if (typeof id !== 'string' || ids.has(id) ||
        (harness !== undefined && (typeof harness !== 'string' || !presetHarnesses.has(harness))) ||
        (conversationId !== undefined && (!harness || !validPresetConversationId(conversationId)))) {
      return c.json({ error: 'Check the harness and session ID for each selected terminal' }, 400)
    }
    const session = registry.get(id)
    if (!session || !canUseSession(access, session)) {
      return c.json({ error: 'A selected session is no longer available. Reopen Save and try again.' }, 409)
    }
    candidates.push({ session, harness: harness as AgentType | undefined, conversationId })
    ids.add(id)
  }
  const terminals = await mapWithConcurrency(candidates, 8, async ({ session, harness, conversationId }): Promise<PresetTerminal> => {
    const host = session.remote ? session.host ?? '' : ''
    const target = presetTarget(session)
    const live = host ? undefined : await inspectPresetTarget('', target).catch(() => undefined)
    return {
      id: session.id,
      label: organization.sessions[session.id]?.title ?? session.name,
      host,
      boardSessionId: !host ? session.boardSessionId : undefined,
      tmuxName: tmuxSessionName(target) ?? config.tmuxSession,
      directory: session.projectPath,
      harness,
      conversationId,
      logPath: harness === session.agentType && conversationId === session.agentSessionId ? session.logFilePath : undefined,
      binding: { id: session.id, target, identity: session.remoteTmuxIdentity ?? live?.sessionIdentity ?? '' },
    }
  })
  const current = accessForPreset(c)
  if (!current || terminals.some(entry => entry.host && !allowedWorkspaceHosts(current).includes(entry.host))) {
    return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  }
  const presets = savedPresets(current)
  const preset = { id: id ?? crypto.randomUUID(), name, organization, terminals }
  if (id) {
    if (presetRestoreInFlight.has(boardProfileId(current))) return c.json({ error: 'A restore is already running' }, 409)
    const index = presets.findIndex(entry => entry.id === id)
    if (index === -1) return c.json({ error: 'Preset not found' }, 404)
    presets[index] = preset
  } else {
    if (presets.length >= 32) return c.json({ error: 'This profile already has 32 presets' }, 422)
    presets.push(preset)
  }
  db.setAppSetting(presetsKey(current), JSON.stringify(presets))
  return c.json({ id: preset.id, name, count: terminals.length }, id ? 200 : 201, organizationHeaders)
}

const presetBodyLimit = bodyLimit({ maxSize: 1024 * 1024 })
app.post(presetsPath, presetBodyLimit, (c) => saveWorkspacePreset(c))
app.put(presetsPath + '/:id', presetBodyLimit, (c) => saveWorkspacePreset(c, c.req.param('id')))

app.delete(presetsPath + '/:id', (c) => {
  const access = accessForPreset(c)
  if (!access) return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  if (presetRestoreInFlight.has(boardProfileId(access))) return c.json({ error: 'A restore is already running' }, 409)
  const presets = savedPresets(access)
  const remaining = presets.filter(entry => entry.id !== c.req.param('id'))
  if (remaining.length === presets.length) return c.json({ error: 'Preset not found' }, 404)
  db.setAppSetting(presetsKey(access), JSON.stringify(remaining))
  return c.json({ ok: true }, 200, organizationHeaders)
})

function presetLaunchCommand(terminal: PresetTerminal) {
  if (!terminal.harness) return workspaceShell
  if (!terminal.conversationId) return
  const template = getResumeCommandTemplate(terminal.harness)
  if (template.includes('{logFilePath}') && (!terminal.logPath || terminal.host)) return
  return template.replaceAll('{sessionId}', shellQuote(terminal.conversationId))
    .replaceAll('{logFilePath}', shellQuote(terminal.logPath ?? ''))
}

async function restorePresetTerminal(
  terminal: PresetTerminal,
  identify: () => BoardAccess | undefined,
  restoredNames: Map<string, string>,
  canUseCachedIdentity: boolean,
): Promise<{ id: string; state: 'attached' | 'started' } | { error: string }> {
  const access = identify()
  const { host, binding, harness, conversationId, directory } = terminal
  if (!access || (host ? !allowedWorkspaceHosts(access).includes(host) : access.role !== 'admin')) {
    return { error: 'This token cannot access the saved host' }
  }
  const cached = host && canUseCachedIdentity && remotePoller.getHostStatus(host).ok ? registry.get(binding.id) : undefined
  if (cached && cached.remote && cached.host === host && cached.tmuxWindow === binding.target &&
      cached.remoteTmuxIdentity && cached.remoteTmuxIdentity === binding.identity && canUseSession(access, cached)) {
    return { id: binding.id, state: 'attached' }
  }
  const live = await inspectPresetTarget(host, binding.target)
  const current = identify()
  const verifiedOwner = !host || current?.role === 'admin' || (
    current?.role === 'shared' && remoteSessionGrant(host, live?.sessionIdentity) === current.id
  )
  if (live && binding.identity === live.sessionIdentity && verifiedOwner && current) {
    restoredNames.set(host + '/' + live.name, live.id)
    return { id: binding.id, state: 'attached' }
  }
  // Local catalog IDs can follow a conversation to a different window.
  if (!host && conversationId && current) {
    const match = registry.getAll().find(session => !session.remote && session.agentSessionId === conversationId &&
      session.agentType === harness)
    if (match) {
      const target = presetTarget(match)
      const verified = await inspectPresetTarget('', target)
      if (verified) {
        terminal.binding = { id: match.id, target, identity: verified.sessionIdentity }
        restoredNames.set('/' + verified.name, verified.id)
        return { id: match.id, state: 'attached' }
      }
    }
  }
  if (!host && terminal.boardSessionId && persistence && current?.role === 'admin' &&
      (!conversationId || persistence.catalog.get(terminal.boardSessionId)?.providerId === conversationId)) {
    const session = stampLocalSession(persistence.resume(terminal.boardSessionId, buildResumeCommand))
    const target = presetTarget(session)
    const verified = await inspectPresetTarget('', target)
    if (!verified) return { error: 'Could not verify the restored tmux window' }
    terminal.binding = { id: session.id, target, identity: verified.sessionIdentity }
    refreshGeneration++
    registry.replaceSessions([session, ...registry.getAll().filter(entry => entry.id !== session.id)])
    refreshSessions()
    return { id: session.id, state: 'started' }
  }
  const activeCommand = presetLaunchCommand(terminal)
  if (!activeCommand) return { error: 'A supported harness and a recoverable session ID are required' }

  const name = terminal.tmuxName
  const existingSessionId = restoredNames.get(host + '/' + name)
  if ((!existingSessionId && name === config.tmuxSession) || name.startsWith(config.tmuxSession + '-ws-')) {
    return { error: 'This managed tmux session needs a live window or recovery from its local catalog' }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) return { error: 'The saved tmux name cannot be recreated' }
  const result = await createWorkspaceTerminal({
    host, name, directory, identify, command: activeCommand, existingSessionId, windowName: terminal.label,
  })
  if (!result.ok) return { error: result.error }
  terminal.binding = { id: result.session.id, target: result.session.tmuxWindow, identity: result.identity }
  restoredNames.set(host + '/' + name, result.identity.split(':', 1)[0])
  return { id: result.session.id, state: 'started' }
}

app.post(presetsPath + '/:id/switch', (c) => {
  const access = accessForPreset(c)
  if (!access) return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  const id = c.req.param('id')
  if (!id || (id !== 'default' && !openWorkspaces(access).some(entry => entry.id === id))) {
    return c.json({ error: 'Workspace not found' }, 404)
  }
  if (presetRestoreInFlight.has(boardProfileId(access))) return c.json({ error: 'A restore is already running' }, 409)
  db.setAppSetting(activeWorkspaceKey(access), id)
  return c.json(workspaceView(access), 200, organizationHeaders)
})

app.post(presetsPath + '/:id/load', (c) => {
  const access = accessForPreset(c)
  if (!access) return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  const id = c.req.param('id')
  const preset = savedPresets(access).find(entry => entry.id === id)
  if (!preset) return c.json({ error: 'Preset not found' }, 404)
  if (presetRestoreInFlight.has(boardProfileId(access))) return c.json({ error: 'A restore is already running' }, 409)

  const open = openWorkspaces(access)
  if (!open.some(entry => entry.id === 'default')) {
    const sessionIds = registry.getAll().filter(session => canUseSession(access, session)).map(session => session.id)
    open.unshift({ id: 'default', name: 'Default', sessionIds })
  }

  const remapped = new Map(preset.terminals.map(terminal => [terminal.id, terminal.binding.id]))
  const organization = remapPresetOrganization(preset.organization, remapped)
  const workspaceIndex = open.findIndex(entry => entry.id === preset.id)
  const workspace = { id: preset.id, name: preset.name, sessionIds: [...new Set(remapped.values())] }
  if (workspaceIndex < 0) open.push(workspace)
  else open[workspaceIndex] = workspace
  db.setAppSetting(workspaceListKey(access), JSON.stringify(open))
  db.setAppSetting(organizationKey(access, preset.id), JSON.stringify(organization))
  db.setAppSetting(activeWorkspaceKey(access), preset.id)
  return c.json(workspaceView(access), 200, organizationHeaders)
})

app.post(presetsPath + '/:id/restore', async (c) => {
  const identify = () => accessForPreset(c)
  const access = identify()
  if (!access) return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
  const id = c.req.param('id')
  const preset = savedPresets(access).find(entry => entry.id === id)
  const workspace = openWorkspaces(access).find(entry => entry.id === id)
  if (!preset || !workspace) return c.json({ error: 'Load the workspace before restoring sessions' }, 404)
  if (workspaceView(access).workspace.id !== preset.id) return c.json({ error: 'Switch to this workspace first' }, 409)
  const profile = boardProfileId(access)
  if (presetRestoreInFlight.has(profile)) return c.json({ error: 'A restore is already running' }, 409)
  presetRestoreInFlight.add(profile)
  try {
    const restoredIds = new Map<string, string>()
    const restoredNames = new Map<string, string>()
    const results: Array<{ label: string; state?: string; error?: string }> = []
    for (const terminal of preset.terminals) {
      const previousId = terminal.binding.id
      // A missing sibling may need to be inserted into this exact tmux session.
      const sharesName = preset.terminals.some(other =>
        other !== terminal && other.host === terminal.host && other.tmuxName === terminal.tmuxName
      )
      const result = await restorePresetTerminal(terminal, identify, restoredNames, !sharesName)
        .catch(() => ({ error: 'The host is unavailable. Try again after it reconnects.' }))
      if ('error' in result) {
        results.push({ label: terminal.label, error: result.error })
      } else {
        if (previousId !== result.id) restoredIds.set(previousId, result.id)
        results.push({ label: terminal.label, state: result.state })
      }
    }
    const current = identify()
    if (!current) return c.json({ error: 'Access changed. Refresh to continue.' }, 403)
    const presets = savedPresets(current).map(entry => entry.id === preset.id ? preset : entry)
    db.setAppSetting(presetsKey(current), JSON.stringify(presets))
    if (restoredIds.size) {
      const persisted = workspaceView(current).organization
      const organization = remapPresetOrganization(persisted, restoredIds)
      const open = openWorkspaces(current)
      const edited = open.find(entry => entry.id === preset.id)
      if (edited) {
        edited.sessionIds = [...new Set(edited.sessionIds.map(sessionId => restoredIds.get(sessionId) ?? sessionId))]
        db.setAppSetting(workspaceListKey(current), JSON.stringify(open))
      }
      db.setAppSetting(organizationKey(current, preset.id), JSON.stringify(organization))
    }
    return c.json({ ...workspaceView(current), results }, 200, organizationHeaders)
  } finally {
    presetRestoreInFlight.delete(profile)
  }
})

app.get('/api/access/grants', (c) => c.json({
  hosts: allowedWorkspaceHosts(administrator),
  grants: boardAccess.grants.list(),
}, 200, { 'Cache-Control': 'no-store' }))

function grantFields(value: unknown) {
  if (!value || typeof value !== 'object' || !('label' in value) || !('hosts' in value) ||
      typeof value.label !== 'string' || !value.label.trim() || value.label.trim().length > 80 ||
      !Array.isArray(value.hosts) || !value.hosts.length) return
  const allowed = new Set(allowedWorkspaceHosts(administrator))
  if (!value.hosts.every(host => typeof host === 'string' && allowed.has(host))) return
  return { label: value.label.trim(), hosts: [...new Set<string>(value.hosts)] }
}

app.post('/api/access/grants', async (c) => {
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
  const fields = grantFields(await c.req.json().catch(() => null))
  if (!fields) return c.json({ error: 'Enter a name and select at least one available server' }, 400)
  const issued = boardAccess.grants.issue(fields.label, fields.hosts)
  terminalRelay?.post({ type: 'access-grants-changed' })
  return c.json(issued, 201, { 'Cache-Control': 'no-store' })
})

function updateLiveGrant(id: string) {
  terminalRelay?.post({ type: 'access-grants-changed', closeId: id })
  for (const ws of sockets) {
    if (!ws.data.relay && ws.data.access.role === 'shared' && ws.data.access.id === id) {
      ws.close(1008, 'Access changed')
    }
  }
}

app.put('/api/access/grants/:id', async (c) => {
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
  const fields = grantFields(await c.req.json().catch(() => null))
  if (!fields) return c.json({ error: 'Enter a name and select at least one available server' }, 400)
  const id = c.req.param('id')
  if (!boardAccess.grants.update(id, fields)) return c.json({ error: 'Active token not found' }, 404)
  updateLiveGrant(id)
  return c.json({ ok: true })
})

app.delete('/api/access/grants/:id', (c) => {
  const id = c.req.param('id')
  if (!boardAccess.grants.update(id, { revokedAt: new Date().toISOString() })) {
    return c.json({ error: 'Active token not found' }, 404)
  }
  updateLiveGrant(id)
  return c.json({ ok: true })
})

app.get('/api/sessions', (c) => {
  const access = boardAccess.identify(c.req.raw)
  return c.json(registry.getAll().filter(session => !!access && canUseSession(access, session)).map(sessionSummary),
    200, { 'Cache-Control': 'no-store' })
})

app.get('/api/workspace', (c) => {
  const access = boardAccess.identify(c.req.raw)
  return c.json({
    canAddRemoteHosts: access?.role === 'admin' && canAddRemoteHosts,
    localAllowed: access?.role === 'admin',
    hosts: allowedWorkspaceHosts(access),
  }, 200, { 'Cache-Control': 'no-store' })
})

app.post('/api/workspace/hosts', async (c) => {
  if (!canAddRemoteHosts) return c.json({ error: 'Adding servers is disabled' }, 403)
  if (!c.req.header('content-type')?.startsWith('application/json')) {
    return c.json({ error: 'JSON required' }, 415)
  }
  const body = await c.req.json<{ host?: unknown }>().catch(() => null)
  const host = typeof body?.host === 'string' ? body.host.trim() : ''
  if (!isValidHostname(host)) return c.json({ error: 'Enter an SSH alias or hostname' }, 400)
  if (host === localHostLabel || host === 'localhost' || host === '127.0.0.1') {
    return c.json({ error: 'Use Local to access the AgentBoard host' }, 400)
  }
  if (config.remoteHosts.includes(host)) return c.json({ host })
  try {
    const check = await runRemoteTmux(host, ['list-sessions', '-F', '#{session_id}'])
    if (check.exitCode !== 0 && !(check.exitCode === 1 && isEmptyRemoteTmux(check.stderr))) {
      const step = check.exitCode === 255 || check.exitCode >= 128 ? 'SSH connection' : 'tmux check'
      const detail = check.stderr.trim().slice(0, 400)
      return c.json({ error: `${step} failed.${detail ? ' ' + detail : ' Check the server and try again.'}` }, 422)
    }
    const imageUpload = config.remoteAllowAttach ? await checkRemoteImageUpload(host) : 'skipped'
    if (!config.remoteHosts.includes(host)) {
      const saved = config.remoteHosts.filter((existing) => !initialRemoteHosts.has(existing))
      db.setAppSetting(BOARD_REMOTE_HOSTS_KEY, JSON.stringify([...saved, host]))
      config.remoteHosts.push(host)
      updateHostStatuses(remotePoller.getHostStatuses())
      remotePoller.hostAdded(host)
    }
    return c.json({ host, imageUpload })
  } catch {
    return c.json({ error: 'Could not add this server' }, 502)
  }
})

app.post('/api/workspace/terminals', async (c) => {
  if (!c.req.header('content-type')?.startsWith('application/json')) {
    return c.json({ error: 'JSON required' }, 415)
  }
  const body = await c.req.json<{ host?: unknown; name?: unknown; directory?: unknown }>().catch(() => null)
  if (!body || typeof body.name !== 'string') return c.json({ error: 'Enter a tmux session name' }, 400)
  const name = body.name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name) ||
      name === config.tmuxSession || name.startsWith(config.tmuxSession + '-ws-')) {
    return c.json({ error: 'Use an unreserved name with letters, numbers, hyphens or underscores' }, 400)
  }
  if (config.discoverPrefixes.length && !config.discoverPrefixes.some((prefix) => name.startsWith(prefix))) {
    return c.json({ error: 'Session name must start with one of: ' + config.discoverPrefixes.join(', ') }, 400)
  }
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const access = boardAccess.identify(c.req.raw)
  if (!access) return c.json({ error: 'Authentication required' }, 401)
  if (access.role === 'shared' && !access.hosts.includes(host)) {
    return c.json({ error: 'This token cannot open that server' }, 403)
  }
  if (host && (!config.remoteAllowAttach || !config.remoteHosts.includes(host))) {
    return c.json({ error: 'This remote host is unavailable for terminal access' }, 403)
  }
  const directory = typeof body.directory === 'string' ? body.directory.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (directory && (!directory.startsWith('/') || /[\x00-\x1f\x7f]/.test(directory))) {
    return c.json({ error: 'Enter an absolute starting directory' }, 400)
  }
  const created = await createWorkspaceTerminal({ host, name, directory, identify: () => boardAccess.identify(c.req.raw) })
  return created.ok ? c.json(sessionSummary(created.session)) : c.json({ error: created.error }, created.status)
})

const workspaceShell = 'exec "${SHELL:-/bin/sh}" -l'

type WorkspaceCreation =
  | { ok: true; session: Session; identity: string }
  | { ok: false; error: string; status: 403 | 422 | 502 }

async function createWorkspaceTerminal({
  host, name, directory, identify, command = workspaceShell, existingSessionId, windowName = 'shell',
}: {
  host: string
  name: string
  directory: string
  identify: () => BoardAccess | undefined
  command?: string
  existingSessionId?: string
  windowName?: string
}): Promise<WorkspaceCreation> {
  try {
    if (directory) {
      const check = host
        ? await runRemoteSsh(host, 'test -d ' + shellQuote(directory))
        : await timedSpawnAsync(['test', '-d', directory], { timeout: 5000 })
      if (check.exitCode !== 0) return { ok: false, error: 'Starting directory does not exist', status: 422 }
    }
    const currentAccess = identify()
    if (!currentAccess || (currentAccess.role === 'shared' && !currentAccess.hosts.includes(host))) {
      return { ok: false, error: 'This token cannot open that server', status: 403 }
    }
    const args = [
      existingSessionId ? 'new-window' : 'new-session', '-d', '-P', '-F',
      buildTmuxFormat(['#{window_index}', '#{window_id}', '#{pane_current_path}', '#{session_id}', '#{pid}', '#{session_created}']),
      ...(existingSessionId ? ['-t', existingSessionId + ':'] : ['-s', name]),
      '-n', escapeTmuxFormatArg(windowName),
      ...(directory ? ['-c', escapeTmuxFormatArg(directory)] : []),
      command,
    ]
    const result = host
      ? await runRemoteTmux(host, args)
      : await timedSpawnAsync(['tmux', '-u', ...args], { timeout: 10_000 })
    if (result.exitCode !== 0) {
      const message = result.stderr.trim().slice(0, 400)
      return { ok: false, error: message || 'Could not create the tmux session', status: 422 }
    }
    const fields = splitTmuxFields(result.stdout.trimEnd(), 6)
    if (!fields?.[1]) return { ok: false, error: 'Could not read the new tmux window', status: 502 }
    const [windowIndex, windowId, cwd, sessionId, serverPid, sessionCreated] = fields
    const identity = remoteTmuxIdentity(sessionId, serverPid, sessionCreated)
    if (!identity) return { ok: false, error: 'Could not identify the new tmux session', status: 502 }
    const boardGrantId = currentAccess.role === 'shared' ? currentAccess.id : undefined
    if (boardGrantId) {
      db.setAppSetting(remoteSessionGrantKey(host, identity), boardGrantId)
    }
    const now = new Date()
    const tmuxWindow = name + ':' + windowId
    const session: Session = {
      id: host ? buildRemoteSessionId(host, name, windowIndex, windowId) : tmuxWindow,
      name,
      tmuxWindow,
      projectPath: cwd || directory,
      source: 'external',
      status: 'unknown',
      remote: Boolean(host),
      host: host || localHostLabel,
      remoteTmuxIdentity: host ? identity : undefined,
      boardGrantId,
      lastActivity: now.toISOString(),
      createdAt: now.toISOString(),
    }
    if (host) protectedRemoteSessionIds.set(session.id, now.getTime())
    refreshGeneration++
    registry.replaceSessions([session, ...registry.getAll().filter((existing) => existing.id !== session.id)])
    refreshSessions()
    const verifiedAccess = identify()
    if (!verifiedAccess || !canUseSession(verifiedAccess, session)) return { ok: false, error: 'Access changed', status: 403 }
    return { ok: true, session, identity }
  } catch {
    return { ok: false, error: 'Unable to create a terminal on this host', status: 502 }
  }
}

function externalTmuxSession(id: string, access: BoardAccess | undefined) {
  const session = registry.get(id)
  if (!access || !session || !canUseSession(access, session) || session.source !== 'external') return
  const name = tmuxSessionName(session.tmuxWindow)
  if (!name || name === config.tmuxSession || name.startsWith(config.tmuxSession + '-ws-')) return
  if (session.remote && (!session.host || !config.remoteAllowAttach || !config.remoteHosts.includes(session.host))) return
  return session
}

function runTmuxCloseCommand(session: Session, args: string[]) {
  return session.remote && session.host
    ? runRemoteTmux(session.host, args)
    : timedSpawnAsync(['tmux', '-u', ...args], { timeout: 10_000 })
}

async function readTmuxCloseTarget(session: Session) {
  const result = await runTmuxCloseCommand(session, ['display-message', '-p', '-t', session.tmuxWindow, TMUX_CLOSE_FORMAT])
  if (result.exitCode === 0) return parseTmuxCloseTarget(result.stdout, session.tmuxWindow)
}

app.get('/api/workspace/session-owner', (c) => {
  const access = boardAccess.identify(c.req.raw)
  if (access?.role !== 'admin') return c.json({ error: 'Administrator access required' }, 403)
  const session = externalTmuxSession(c.req.query('sessionId') ?? '', access)
  const host = session?.host
  if (!session?.remote || !host || !session.remoteTmuxIdentity) return c.json({ error: 'Remote tmux session unavailable' }, 404)
  const grants = boardAccess.grants.list().filter(grant => !grant.revokedAt && grant.hosts.includes(host))
    .map(({ id, label }) => ({ id, label }))
  return c.json({ grantId: session.boardGrantId ?? null, grants }, 200, { 'Cache-Control': 'no-store' })
})

app.put('/api/workspace/session-owner', async (c) => {
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
  const body = await c.req.json<{ sessionId?: unknown; grantId?: unknown }>().catch(() => null)
  if (typeof body?.sessionId !== 'string' || (body.grantId !== null && typeof body.grantId !== 'string')) {
    return c.json({ error: 'Select a remote tmux session and an owner' }, 400)
  }
  const access = boardAccess.identify(c.req.raw)
  if (access?.role !== 'admin') return c.json({ error: 'Administrator access required' }, 403)
  const session = externalTmuxSession(body.sessionId, access)
  if (!session?.remote || !session.host || !session.remoteTmuxIdentity) return c.json({ error: 'Remote tmux session unavailable' }, 404)
  let target: Awaited<ReturnType<typeof readTmuxCloseTarget>>
  try {
    target = await readTmuxCloseTarget(session)
  } catch {
    return c.json({ error: 'Unable to inspect this tmux session' }, 502)
  }
  if (target?.sessionIdentity !== session.remoteTmuxIdentity) return c.json({ error: 'tmux session changed. Refresh and try again.' }, 409)
  const grant = body.grantId === null ? undefined : boardAccess.grants.byId(body.grantId)
  if (body.grantId !== null && (grant?.role !== 'shared' || !grant.hosts.includes(session.host))) {
    return c.json({ error: 'Token does not have access to this server' }, 400)
  }
  const previous = remoteSessionGrant(session.host, target.sessionIdentity)
  const boardGrantId = grant?.role === 'shared' ? grant.id : undefined
  if (previous !== boardGrantId) {
    db.setAppSetting(remoteSessionGrantKey(session.host, target.sessionIdentity), boardGrantId ?? '')
    if (previous) updateLiveGrant(previous)
    refreshGeneration++
    registry.replaceSessions(registry.getAll().map(entry =>
      entry.host === session.host && entry.remoteTmuxIdentity === target.sessionIdentity ? { ...entry, boardGrantId } : entry
    ))
  }
  return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' })
})

function canCloseLiveTmux(access: BoardAccess | undefined, session: Session, identity: string) {
  return access && canUseSession(access, { ...session, boardGrantId: remoteSessionGrant(session.host, identity) })
}

app.get('/api/workspace/tmux-session', async (c) => {
  const session = externalTmuxSession(c.req.query('sessionId') ?? '', boardAccess.identify(c.req.raw))
  if (!session) return c.json({ error: 'tmux session not available to close' }, 404)
  try {
    const target = await readTmuxCloseTarget(session)
    if (!target) return c.json({ error: 'tmux session changed or is unavailable. Refresh and try again.' }, 409)
    if (!canCloseLiveTmux(boardAccess.identify(c.req.raw), session, target.sessionIdentity)) {
      return c.json({ error: 'tmux session not available to close' }, 404)
    }
    return c.json({ identity: target.identity, name: target.name, host: session.host || localHostLabel, windows: target.windows },
      200, { 'Cache-Control': 'no-store' })
  } catch {
    return c.json({ error: 'Unable to inspect this tmux session' }, 502)
  }
})

app.post('/api/workspace/close-tmux', async (c) => {
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
  const body = await c.req.json<{ sessionId?: unknown; identity?: unknown }>().catch(() => null)
  if (typeof body?.sessionId !== 'string' || typeof body.identity !== 'string') {
    return c.json({ error: 'Select a tmux session and confirm its identity' }, 400)
  }
  const session = externalTmuxSession(body.sessionId, boardAccess.identify(c.req.raw))
  if (!session) return c.json({ error: 'tmux session not available to close' }, 404)
  try {
    const target = await readTmuxCloseTarget(session)
    if (!target || target.identity !== body.identity) {
      return c.json({ error: 'tmux session changed. Reopen the confirmation to check the current windows.' }, 409)
    }
    // An administrator can change the token's server scope during the SSH inspection.
    const access = boardAccess.identify(c.req.raw)
    if (!canCloseLiveTmux(access, session, target.sessionIdentity)) {
      return c.json({ error: 'tmux session not available to close' }, 404)
    }
    const result = await runTmuxCloseCommand(session, closeTmuxArgs(target))
    if (result.exitCode !== 0 || result.stdout.trim()) {
      return c.json({ error: 'Could not close this tmux session. Refresh to check its current state.' }, 409)
    }
    const removedIds = new Set(registry.getAll().filter(entry =>
      entry.remote === session.remote && entry.host === session.host &&
      tmuxSessionName(entry.tmuxWindow) === target.name).map(entry => entry.id))
    if (session.remote) {
      for (const id of removedIds) {
        protectedRemoteSessionIds.delete(id)
        remoteSessionNameOverrides.delete(id)
        remoteSessionTombstones.set(id, Date.now())
      }
    }
    refreshGeneration++
    registry.replaceSessions(registry.getAll().filter(entry => !removedIds.has(entry.id)))
    refreshSessions()
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Unable to close this tmux session. Refresh to check its current state.' }, 502)
  }
})

app.get('/api/session-preview/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid session id' }, 400)
  }

  const DEFAULT_LIMIT = 200
  const MAX_LIMIT = 500
  // Treat a missing OR empty `?limit=` as absent — `'' ?? DEFAULT` keeps '', and
  // Number('') is 0, which would otherwise collapse the window to a single line.
  const limitQuery = c.req.query('limit')
  const rawLimit = limitQuery === undefined || limitQuery === ''
    ? DEFAULT_LIMIT
    : Number(limitQuery)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : DEFAULT_LIMIT

  const record = db.getSessionById(sessionId)
  if (!record) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const logPath = record.logFilePath
  if (!logPath) {
    return c.json({ error: 'No log file for session' }, 404)
  }

  try {
    const stats = await fs.stat(logPath)
    if (!stats.isFile()) {
      return c.json({ error: 'Log file not found' }, 404)
    }

    const beforeLineQuery = c.req.query('beforeLine')
    // Missing or empty means "latest window"; a non-numeric value falls back to
    // the same (selectLineWindow treats a non-finite cursor as the end).
    const rawBeforeLine = beforeLineQuery === undefined || beforeLineQuery === ''
      ? Number.POSITIVE_INFINITY
      : Number(beforeLineQuery)
    const beforeByteQuery = c.req.query('beforeByte')
    const rawBeforeByte = beforeByteQuery === undefined || beforeByteQuery === ''
      ? undefined
      : Number(beforeByteQuery)
    const beforeByte = rawBeforeByte !== undefined && Number.isFinite(rawBeforeByte)
      ? Math.max(0, Math.trunc(rawBeforeByte))
      : undefined
    const lineWindow = await readLogLineWindow(
      logPath,
      stats,
      limit,
      rawBeforeLine,
      beforeByte
    )

    return c.json({
      sessionId,
      displayName: record.displayName,
      projectPath: record.projectPath,
      agentType: record.agentType,
      lastActivityAt: record.lastActivityAt,
      ...lineWindow,
    })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return c.json({ error: 'Log file not found' }, 404)
    }
    return c.json({ error: 'Unable to read log file' }, 500)
  }
})

app.route('/api/session-media', createMediaRoutes({
  thumbnail: thumbnailClient,
  getRecord: (id) => db.getSessionById(id),
  page: (record, cursor, query) => metadataClient.page(record, cursor, query),
  watch: (record, cursor, query, signal) => metadataClient.watch(record, cursor, query, signal),
  neighbors: (record, anchor) => metadataClient.neighbors(record, anchor),
  invalidate: (record) => metadataClient.invalidate(record),
}))
app.get('/api/directories', async (c) => {
  const requestedPath = c.req.query('path') ?? '~'
  const query = (c.req.query('query') ?? '').toLowerCase()
  const showHidden = c.req.query('hidden') !== 'false'

  if (requestedPath.length > MAX_FIELD_LENGTH) {
    const payload: DirectoryErrorResponse = {
      error: 'invalid_path',
      message: 'Path too long',
    }
    return c.json(payload, 400)
  }

  const trimmedPath = requestedPath.trim()
  if (!trimmedPath) {
    const payload: DirectoryErrorResponse = {
      error: 'invalid_path',
      message: 'Path is required',
    }
    return c.json(payload, 400)
  }

  const start = Date.now()
  const resolved = resolveProjectPath(trimmedPath)

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(resolved)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path does not exist',
      }
      return c.json(payload, 404)
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Permission denied',
      }
      return c.json(payload, 403)
    }
    const payload: DirectoryErrorResponse = {
      error: 'internal_error',
      message: 'Unable to read directory',
    }
    return c.json(payload, 500)
  }

  if (!stats.isDirectory()) {
    const payload: DirectoryErrorResponse = {
      error: 'not_found',
      message: 'Path is not a directory',
    }
    return c.json(payload, 404)
  }

  let directories: DirectoryListing['directories'] = []
  try {
    const entries = await fs.readdir(resolved, {
      withFileTypes: true,
      encoding: 'utf8',
    })
    directories = entries
      .filter((entry) => entry.isDirectory()
        && (showHidden || !entry.name.startsWith('.'))
        && entry.name.toLowerCase().includes(query))
      .map((entry) => {
        const name = entry.name.toString()
        return {
          name,
          path: path.join(resolved, name),
        }
      })
      .toSorted((a, b) => {
        const aDot = a.name.startsWith('.')
        const bDot = b.name.startsWith('.')
        if (aDot !== bDot) {
          return aDot ? -1 : 1
        }
        const aLower = a.name.toLowerCase()
        const bLower = b.name.toLowerCase()
        if (aLower < bLower) {
          return -1
        }
        if (aLower > bLower) {
          return 1
        }
        return a.name.localeCompare(b.name)
      })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Permission denied',
      }
      return c.json(payload, 403)
    }
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path does not exist',
      }
      return c.json(payload, 404)
    }
    const payload: DirectoryErrorResponse = {
      error: 'internal_error',
      message: 'Unable to list directory',
    }
    return c.json(payload, 500)
  }

  const truncated = directories.length > MAX_DIRECTORY_ENTRIES
  const limitedDirectories = truncated
    ? directories.slice(0, MAX_DIRECTORY_ENTRIES)
    : directories

  const root = path.parse(resolved).root
  const parent = resolved === root ? null : path.dirname(resolved)
  const response: DirectoryListing = {
    path: resolved,
    parent,
    directories: limitedDirectories,
    truncated,
  }

  const durationMs = Date.now() - start
  logger.debug('directories_request', {
    path: resolved,
    count: limitedDirectories.length,
    truncated,
    durationMs,
  })

  return c.json(response)
})

app.get('/api/server-info', async (c) => {
  if (boardAccess.identify(c.req.raw)?.role === 'shared') {
    return c.json({ tailscaleIp: null })
  }
  // For 0.0.0.0, detect Tailscale IP for display (already listening on all interfaces).
  // For localhost, only report if we successfully bound to the Tailscale IP.
  // Wait for the startup lookup first: the client fetches this once per page
  // load, so answering null while it is pending sticks until a reload.
  let tsIp: string | null
  if (config.hostname === '0.0.0.0') {
    tsIp = await getTailscaleIp()
  } else {
    await tailscaleReady
    tsIp = boundTailscaleIp
  }
  return c.json({
    port: config.port,
    tailscaleIp: tsIp,
    protocol: tlsEnabled ? 'https' : 'http',
  })
})

// Tmux mouse mode setting
app.get('/api/settings/tmux-mouse-mode', (c) => {
  const stored = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
  const enabled = stored === null ? true : stored === 'true'
  return c.json({ enabled })
})

app.put('/api/settings/tmux-mouse-mode', async (c) => {
  let body: { enabled?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400)
  }

  const previousStored = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
  const previousEnabled = previousStored === null ? true : previousStored === 'true'

  try {
    sessionManager.setMouseMode(body.enabled)
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      return c.json({ error: 'Timed out applying tmux mouse mode' }, 504)
    }
    logger.warn('tmux_mouse_mode_update_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to apply tmux mouse mode' }, 500)
  }

  try {
    db.setAppSetting(TMUX_MOUSE_MODE_KEY, String(body.enabled))
  } catch (error) {
    logger.warn('tmux_mouse_mode_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    try {
      sessionManager.setMouseMode(previousEnabled)
    } catch (rollbackError) {
      logger.warn('tmux_mouse_mode_rollback_failed', {
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      })
    }
    return c.json({ error: 'Unable to persist tmux mouse mode' }, 500)
  }

  return c.json({ enabled: body.enabled })
})

// Terminal ANSI color setting
app.get('/api/settings/terminal-colors', (c) => {
  return c.json({ enabled: config.terminalColorsEnabled })
})

app.put('/api/settings/terminal-colors', async (c) => {
  let body: { enabled?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400)
  }

  const previousValue = config.terminalColorsEnabled
  try {
    sessionManager.setTerminalColors(body.enabled)
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      return c.json({ error: 'Timed out applying terminal colors' }, 504)
    }
    logger.warn('terminal_colors_update_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to apply terminal colors' }, 500)
  }

  config.terminalColorsEnabled = body.enabled
  try {
    db.setAppSetting(TERMINAL_COLORS_ENABLED_KEY, String(body.enabled))
  } catch (error) {
    config.terminalColorsEnabled = previousValue
    logger.warn('terminal_colors_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    try {
      sessionManager.setTerminalColors(previousValue)
    } catch (rollbackError) {
      logger.warn('terminal_colors_rollback_failed', {
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      })
    }
    return c.json({ error: 'Unable to persist terminal colors' }, 500)
  }

  terminalRelay?.post({ type: 'sessions', sessions: registry.getAll(), terminalColorsEnabled: config.terminalColorsEnabled })
  return c.json({ enabled: body.enabled })
})

app.get('/api/settings/prefer-window-name', (c) => {
  return c.json({ enabled: config.preferWindowName })
})

app.put('/api/settings/prefer-window-name', async (c) => {
  let body: { enabled?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400)
  }

  const previousValue = config.preferWindowName
  config.preferWindowName = body.enabled
  try {
    db.setAppSetting(PREFER_WINDOW_NAME_KEY, String(body.enabled))
  } catch (error) {
    // Same contract as tmux-mouse-mode: never leave the runtime value
    // diverging from what will be restored after a restart.
    config.preferWindowName = previousValue
    logger.warn('prefer_window_name_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to persist prefer window name' }, 500)
  }
  // Connected clients keep their own copy from the open-time server-config
  // message (mobile tab labels read it); rebroadcast so they all converge.
  broadcast({
    type: 'server-config',
    catalogVersion: CATALOG_VERSION,
    remoteAllowControl: config.remoteAllowControl,
    remoteAllowAttach: config.remoteAllowAttach,
    hostLabel: config.hostLabel,
    preferWindowName: config.preferWindowName,
    clientLogLevel: logLevel,
  })
  // Names are recomputed on refresh; schedule one so the sidebar updates
  // promptly instead of waiting for the next poll tick.
  scheduleEnterRefresh()
  return c.json({ enabled: body.enabled })
})

// Synced client settings (theme, presets, session list prefs). Persisted in
// app_settings under the `synced_settings.` prefix and pushed to every client
// via the `synced-settings` WS message, so all attached browsers converge on
// the same values — including the terminal theme that xterm reports back to
// pane programs (OSC 10/11 color queries).
const SYNCED_SETTINGS_PREFIX = 'synced_settings.'

function readSyncedSettings(): SyncedSettings {
  const settings: Record<string, unknown> = {}
  for (const key of SYNCED_SETTINGS_KEYS) {
    let raw: string | null = null
    try {
      raw = db.getAppSetting(SYNCED_SETTINGS_PREFIX + key)
    } catch (error) {
      logger.warn('synced_settings_read_failed', {
        key,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (raw === null) continue
    try {
      const value = JSON.parse(raw) as unknown
      // Skip corrupt/undecodable values rather than pushing them to clients.
      if (isValidSyncedSetting(key, value)) {
        settings[key] = value
      }
    } catch {
      // ignore malformed JSON
    }
  }
  return settings
}

app.get('/api/settings/synced', (c) => {
  return c.json({ settings: readSyncedSettings() })
})

app.put('/api/settings/synced', async (c) => {
  let body: { settings?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.settings !== 'object' || body.settings === null) {
    return c.json({ error: 'settings must be an object' }, 400)
  }

  const entries = Object.entries(body.settings as Record<string, unknown>)
  const invalid = entries.filter(
    ([key, value]) =>
      !isSyncedSettingsKey(key) || !isValidSyncedSetting(key, value)
  )
  if (invalid.length > 0) {
    return c.json(
      { error: `Invalid synced settings: ${invalid.map(([key]) => key).join(', ')}` },
      400
    )
  }

  try {
    for (const [key, value] of entries) {
      db.setAppSetting(SYNCED_SETTINGS_PREFIX + key, JSON.stringify(value))
    }
  } catch (error) {
    logger.warn('synced_settings_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to persist synced settings' }, 500)
  }

  const merged = readSyncedSettings()
  broadcast({ type: 'synced-settings', settings: merged })
  return c.json({ settings: merged })
})

// History sessions max age setting. The inactive route is kept as a
// compatibility alias for older clients.
const getHistoryMaxAgeHours = (c: Context) => {
  return c.json({ hours: runtimeHistoryMaxAgeHours })
}

const putHistoryMaxAgeHours = async (c: Context) => {
  try {
    const body = await c.req.json()
    const hours = Number(body.hours)
    if (!Number.isFinite(hours) || hours < HISTORY_MAX_AGE_MIN_HOURS || hours > HISTORY_MAX_AGE_MAX_HOURS) {
      return c.json({ error: `hours must be a number between ${HISTORY_MAX_AGE_MIN_HOURS} and ${HISTORY_MAX_AGE_MAX_HOURS}` }, 400)
    }
    runtimeHistoryMaxAgeHours = hours
    db.setAppSetting(HISTORY_MAX_AGE_HOURS_KEY, String(hours))
    // Re-broadcast agent sessions with new max age
    updateDormantAgentSessions()
    return c.json({ hours })
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
}

app.get('/api/settings/history-max-age-hours', getHistoryMaxAgeHours)
app.put('/api/settings/history-max-age-hours', putHistoryMaxAgeHours)
app.get('/api/settings/inactive-max-age-hours', getHistoryMaxAgeHours)
app.put('/api/settings/inactive-max-age-hours', putHistoryMaxAgeHours)

// Allowed paste-image types; the extension written to /tmp comes from this map,
// never from client-supplied values. Note Bun's multipart parser derives
// File.type from the part filename's extension, not the declared blob type.
const pasteImageExtensionByMime = new Map([
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])

const macPasteboardSwiftScript = `
import AppKit
import UniformTypeIdentifiers
import Foundation

let maxBytes = Int(ProcessInfo.processInfo.environment["AGENTBOARD_PASTE_IMAGE_MAX_BYTES"] ?? "") ?? 0
let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp", "avif"]

func emit(path: String?, isImage: Bool) {
  let payload: [String: Any?] = ["path": path, "isImage": isImage]
  let data = try! JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 })
  print(String(data: data, encoding: .utf8)!)
}

func writePng(_ data: Data) -> Bool {
  let path = NSTemporaryDirectory() + "agentboard-paste-" + UUID().uuidString + ".png"
  do {
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    emit(path: path, isImage: true)
    return true
  } catch {
    return false
  }
}

let pasteboard = NSPasteboard.general
let items = pasteboard.pasteboardItems ?? []

for item in items {
  if let fileURLString = item.string(forType: .fileURL),
     let url = URL(string: fileURLString),
     url.isFileURL {
    let path = url.path
    let lowerExt = url.pathExtension.lowercased()
    let hasImageType = item.types.contains(.png) || item.types.contains(.tiff)
    emit(path: path, isImage: hasImageType || imageExtensions.contains(lowerExt))
    exit(0)
  }
}

for item in items {
  if let data = item.data(forType: .png), data.count > 0, (maxBytes <= 0 || data.count <= maxBytes), writePng(data) {
    exit(0)
  }
}

// Fallback: any declared image type. Universal Clipboard items from other
// devices may only declare e.g. com.microsoft.bmp (plus is-remote-clipboard)
// and won't transmute to .png on request — decode and re-encode instead.
for item in items {
  for type in item.types {
    guard type != .png,
          let ut = UTType(type.rawValue), ut.conforms(to: .image),
          let data = item.data(forType: type),
          data.count > 0, (maxBytes <= 0 || data.count <= maxBytes),
          let rep = NSBitmapImageRep(data: data),
          let png = rep.representation(using: .png, properties: [:]),
          maxBytes <= 0 || png.count <= maxBytes
    else { continue }
    if writePng(png) { exit(0) }
  }
}

emit(path: nil, isImage: false)
`

const MAC_PASTEBOARD_TIMEOUT_MS = 10000

function isImageFilePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(filePath)
}

app.route('/api/paste-file', createPasteFileRoutes())

// Image upload endpoint for iOS clipboard paste
app.post('/api/paste-image', async (c) => {
  // Early reject before buffering the multipart body. The header is
  // client-controlled, so image.size below remains the authoritative check.
  const contentLength = Number(c.req.header('content-length'))
  if (Number.isFinite(contentLength) && contentLength > config.pasteImageMaxBytes) {
    return c.json({ error: 'Image too large' }, 413)
  }

  const remoteSessionId = c.req.header('X-Agentboard-Session')
  const remoteSession = remoteSessionId ? registry.get(remoteSessionId) : undefined
  const remoteHost = remoteSession?.remote ? remoteSession.host : undefined
  if (remoteSessionId && (!config.remoteAllowAttach || !remoteHost || !config.remoteHosts.includes(remoteHost))) {
    return c.json({ error: 'SSH session is unavailable for image upload' }, 403)
  }

  try {
    const formData = await c.req.formData()
    const image = formData.get('image')
    if (!(image instanceof File)) {
      return c.json({ error: 'No image provided' }, 400)
    }
    if (image.size > config.pasteImageMaxBytes) {
      return c.json({ error: 'Image too large' }, 413)
    }
    const ext = pasteImageExtensionByMime.get(image.type)
    if (!ext) {
      return c.json({ error: 'Unsupported image type' }, 415)
    }

    if (remoteHost) {
      if (image.size === 0) return c.json({ error: 'No image provided' }, 400)
      const command = remoteImageWriteCommand(ext, image.size)
      const result = await runRemoteSsh(remoteHost, command, Buffer.from(await image.arrayBuffer()))
      const path = result.stdout.trim()
      if (result.exitCode !== 0 || !/^\/tmp\/agentboard-image\.[A-Za-z0-9]{8}\/screenshot\.[a-z]+$/.test(path)) {
        return c.json({ error: 'Could not save image on the SSH host' }, 502)
      }
      c.header('Cache-Control', 'no-store')
      return c.json({ path })
    }

    // Generate unique filename in temp directory
    const filename = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const filepath = `/tmp/${filename}`
    await Bun.write(filepath, image)

    return c.json({ path: filepath })
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      500
    )
  }
})

// Get file path from macOS clipboard (for Finder file copies and screenshot apps).
// Browser paste events can hide AppKit pasteboard types such as public.file-url
// and public.png, so this endpoint reads NSPasteboard directly.
app.get('/api/clipboard-file-path', async (c) => {
  if (process.platform !== 'darwin') {
    return c.json({ path: null, isImage: false })
  }
  try {
    // Finder file URLs do not need the Swift interpreter. Resolve them first
    // so cold Swift startup cannot delay ordinary document pastes.
    const fileProc = Bun.spawn(
      ['osascript', '-e', 'POSIX path of (the clipboard as «class furl»)'],
      { stdout: 'pipe', stderr: 'pipe', timeout: MAC_PASTEBOARD_TIMEOUT_MS }
    )
    const fileText = await new Response(fileProc.stdout).text()
    const fileExitCode = await fileProc.exited
    const filePath = fileText.trim()
    if (fileExitCode === 0 && filePath.startsWith('/')) {
      const file = Bun.file(filePath)
      if (await file.exists()) {
        c.header('Cache-Control', 'no-store')
        return c.json({ path: filePath, isImage: isImageFilePath(filePath) })
      }
    }

    const proc = Bun.spawn(
      ['swift', '-e', macPasteboardSwiftScript],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: MAC_PASTEBOARD_TIMEOUT_MS,
        env: {
          ...process.env,
          AGENTBOARD_PASTE_IMAGE_MAX_BYTES: String(config.pasteImageMaxBytes),
        },
      }
    )
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode === 0) {
      const payload = JSON.parse(text) as { path?: unknown; isImage?: unknown }
      const filePath = typeof payload.path === 'string' ? payload.path : null
      // Verify the file actually exists
      if (filePath?.startsWith('/')) {
        const file = Bun.file(filePath)
        if (await file.exists()) {
          c.header('Cache-Control', 'no-store')
          return c.json({ path: filePath, isImage: payload.isImage === true })
        }
      }
    }

    return c.json({ path: null, isImage: false })
  } catch {
    return c.json({ path: null, isImage: false })
  }
})

if (persistenceRuntime) {
  persistenceRuntime.matchingFailure = () => logPoller.matchingError
  const library = registerPersistenceRoutes(app, persistenceRuntime, {
    metadataFor: (record) => metadataClient.scan(record),
    commandFor: buildResumeCommand,
    changed: () => {
      updateDormantAgentSessions()
      refreshSessions()
      broadcast({ type: 'library-changed' })
    },
    activated: (session) => {
      refreshGeneration++
      const others = registry
        .getAll()
        .filter((s) => s.tmuxWindow !== session.tmuxWindow)
      registry.replaceSessions([stampLocalSession(session), ...others])
    },
  })
  persistenceRuntime.start()
  if (persistenceRuntime.health().settings.autoResume) {
    // Reconcile the new tmux lifetime before selecting interrupted sessions.
    try {
      const live = sessionManager.listWindows()
      persistence!.beforeSnapshot(live, sessionManager.lastEnumeratedServerPid)
      persistence!.observe(live)
    } catch (error) {
      logger.warn('auto_resume_reconcile_failed', { error: String(error) })
    }
    const interrupted: SavedSession[] = []
    let cursor: string | undefined
    do {
      const page = persistence!.catalog.history({
        state: 'interrupted',
        limit: 100,
        cursor,
      })
      interrupted.push(...page.sessions)
      cursor = page.nextCursor || undefined
    } while (cursor)
    void (async () => {
      for (const saved of interrupted) {
        try {
          await library.resume(saved.id)
        } catch (error) {
          logger.warn('auto_resume_failed', {
            sessionId: saved.id,
            error: String(error),
          })
        }
      }
    })()
  }
}

const staticDir = process.env.AGENTBOARD_STATIC_DIR || './dist/client'
app.use('/*', serveStatic({ root: staticDir }))

const tlsEnabled = config.tlsCert && config.tlsKey
// Also applies to the loopback dashboard listener behind the relay, which is
// plain HTTP: the relay forwards the browser's https Origin and Host to it.
const requestOriginPolicy = originPolicy(config.allowedOrigins, config.tlsCert, config.tlsKey)
const tlsOptions = tlsEnabled
  ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } }
  : {}

function createSocketData(connectionId: string, remoteAddress: string | null, userAgent: string | null, catalogVersion: number | null, access: BoardAccess): WSData {
  return {
    access,
    catalogVersion, terminal: null, currentSessionId: null, currentTmuxTarget: null,
    connectionId, remoteAddress, userAgent, terminalHost: null, terminalAttachSeq: 0,
    copyModeQuery: new CopyModeQuery(), lastAttachKey: null, lastAttachTs: 0,
    clipboardPollTimer: null, clipboardPollInFlight: false, lastClipboardBufferKey: null,
    clipboardBufferArmedUntil: 0, clipboardArmedAtSec: 0, clipboardWatchGen: 0,
  }
}

function serverFetch(req: Request, server: Server<WSData>) {
  const url = new URL(req.url)
  if (needsOriginCheck(req, url.pathname)) {
    const rejected = crossOriginRejection(req, url.pathname, requestOriginPolicy, logger.warn)
    if (rejected) return rejected
  }
  const access = boardAccess.identify(req)
  const accessResponse = boardAccess.respond(req, url, access)
  if (accessResponse) return accessResponse
  if (!access || (access.role === 'shared' && !sharedHttpAllowed(req.method, url.pathname)) ||
      (url.pathname.startsWith('/api/access/grants') && !boardAccess.enabled)) {
    return Response.json({ error: 'Access denied' }, { status: 403 })
  }
  if (url.pathname === '/ws') {
    const requestIp =
      typeof server.requestIP === 'function' ? server.requestIP(req) : null
    if (
      server.upgrade(req, {
        data: createSocketData(createConnectionId(), requestIp?.address ?? null, req.headers.get('user-agent')?.slice(0, 200) ?? null, catalogVersionFromUrl(url), access),
      })
    ) {
      return
    }
    return new Response('WebSocket upgrade failed', { status: 400 })
  }

  return app.fetch(req)
}

const websocketHandlers = {
  idleTimeout: 40,
  sendPings: true,
  perMessageDeflate: true,
  open(ws: ServerWebSocket<WSData>) {
    if (ws.data.catalogVersion !== CATALOG_VERSION) {
      ws.data.stopUpgradeNotice = startCatalogUpgradeNotice(ws)
      return
    }
    sockets.add(ws)
    send(ws, {
      type: 'server-config',
    catalogVersion: CATALOG_VERSION,
      remoteAllowControl: config.remoteAllowControl,
      remoteAllowAttach: config.remoteAllowAttach,
      hostLabel: config.hostLabel,
      preferWindowName: config.preferWindowName,
      clientLogLevel: logLevel,
    })
    send(ws, { type: 'sessions', sessions: registry.getAll() })
    send(ws, { type: 'host-status', hosts: hostStatuses })
    send(ws, { type: 'synced-settings', settings: readSyncedSettings() })
    const agentSessions = registry.getAgentSessions()
    send(ws, {
      type: 'agent-sessions',
      active: agentSessions.active,
      hibernating: agentSessions.hibernating,
      history: agentSessions.history,
    })
    if (!ws.data.relay) initializePersistentTerminal(ws)
  },
  message(ws: ServerWebSocket<WSData>, message: string | BufferSource) {
    handleMessage(ws, message)
  },
  close(ws: ServerWebSocket<WSData>) {
    ws.data.stopUpgradeNotice?.()
    killRateLimiter.forget(ws.data.connectionId)
    cleanupTerminals(ws)
    sockets.delete(ws)
  },
}

const httpServer = Bun.serve<WSData>({
  port: relayEnabled ? 0 : config.port,
  hostname: relayEnabled ? '127.0.0.1' : config.hostname,
  ...(relayEnabled ? {} : tlsOptions),
  fetch: serverFetch,
  websocket: websocketHandlers,
})

function relayMessage(message: RelayToParent): void {
  if (message.type === 'open') {
    const data = { ...createSocketData(message.id, message.remoteAddress, message.userAgent, message.catalogVersion, message.access), relay: true }
    const peer = {
      data, readyState: 1,
      send: (payload: string) => { terminalRelay?.post({ type: 'send', id: message.id, payload }); return payload.length },
    } as unknown as ServerWebSocket<WSData>
    relayPeers.set(message.id, peer)
    websocketHandlers.open(peer)
  } else if (message.type === 'message') {
    const peer = relayPeers.get(message.id)
    if (peer) handleMessage(peer, message.payload)
  } else if (message.type === 'close') {
    const peer = relayPeers.get(message.id)
    if (peer) websocketHandlers.close(peer)
    relayPeers.delete(message.id)
  } else if (message.type === 'group-created') noteGroupedSessionCreated()
  else if (message.type === 'submit') {
    setForceWorking(message.sessionId)
    scheduleEnterRefresh()
    scheduleLastUserMessageCapture(message.sessionId)
  } else if (message.type === 'lease-created') relayLeaseIds.add(message.id)
  else if (message.type === 'lease-removed') relayLeaseIds.delete(message.id)
  else if (message.type === 'fatal') {
    logger.error('terminal_relay_failed', { error: message.error })
    process.exit(1)
  } else if (message.type === 'bind-error') logger.error('terminal_relay_bind_failed', { hostname: message.hostname, error: message.error })
}

if (relayEnabled) {
  terminalRelay = new TerminalRelayClient({
    port: config.port, hostname: config.hostname, upstreamPort: httpServer.port!,
    tlsCert: config.tlsCert, tlsKey: config.tlsKey, terminalColorsEnabled: config.terminalColorsEnabled,
    allowedOrigins: config.allowedOrigins, accessGrantsFile,
  }, registry.getAll(), relayMessage)
  void terminalRelay.ready.catch(error => { logger.error('terminal_relay_start_failed', { error: String(error) }); process.exit(1) })
}

const protocol = tlsEnabled ? 'https' : 'http'
const displayHost = config.hostname === '0.0.0.0' ? 'localhost' : config.hostname
logger.info('server_started', {
  url: `${protocol}://${displayHost}:${config.port}`,
})

// When bound to localhost, also listen on the Tailscale interface if available.
// This allows remote access over Tailscale without exposing the LAN interface.
// The lookup (`tailscale ip`) runs after the main listener is up and
// server_started is logged, so a slow tailscaled never delays startup; the
// Tailscale listener and its URL log line arrive when it answers. Exported so
// tests can wait for it.
let boundTailscaleIp: string | null = null
export const tailscaleReady = (async () => {
  if (config.hostname !== '127.0.0.1' && config.hostname !== '0.0.0.0') return
  let detectedIp: string | null
  try {
    detectedIp = await getTailscaleIp()
  } catch {
    detectedIp = null
  }
  if (!detectedIp) return
  const tailscaleUrl = `${protocol}://${detectedIp}:${config.port}`
  if (config.hostname === '0.0.0.0') {
    // Already listening on all interfaces: the URL is for display only.
    logger.info('tailscale_detected', { tailscaleUrl })
    return
  }
  // Tailscale Serve may already own the dashboard port. Preview ports are
  // independent and still need the tailnet interface when that bind fails.
  previews.addHost(detectedIp)
  try {
    if (terminalRelay) {
      await terminalRelay.bind(detectedIp)
    } else Bun.serve<WSData>({
      port: config.port,
      hostname: detectedIp,
      ...tlsOptions,
      fetch: serverFetch,
      websocket: websocketHandlers,
    })
    boundTailscaleIp = detectedIp
    logger.info('tailscale_listener_started', { tailscaleUrl })
  } catch (error) {
    logger.warn('tailscale_bind_failed', {
      ip: detectedIp,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})()

// The initial window refresh runs after bind: listing windows issues a
// synchronous capture-pane per window, which would otherwise keep the port
// closed until every capture finished. Verification needs the populated
// registry, so it is chained after the refresh completes. Exported so tests
// can deterministically wait for startup to settle.
const startupLifecycle = createStartupLifecycle({
  config,
  db,
  sessionManager,
  registry,
  sockets,
  liveTerminalIds: () => relayLeaseIds,
  canPruneWsSessions: startupEnsureResult.canPruneWsSessions,
  hasOwnership: window => Boolean(ownershipMatcher?.get(window)),
  hydrateSessionsWithAgentSessions,
  applyForceWorkingOverrides,
  mergeRemoteSessions,
  updateDormantAgentSessions,
})

export const startupReady = (async () => {
  prProvider.start()
  try {
    await refreshSessionsAsync()
  } catch (error) {
    logger.warn('startup_refresh_error', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const startupWindows = registry.getAll().filter((s) => !s.remote)
  logger.info('startup_state', {
    activeSessionCount: startupActiveSessions.length,
    windowCount: startupWindows.length,
    activeWindows: startupActiveSessions.map((s) => ({
      sessionId: s.sessionId.slice(0, 8),
      name: s.displayName,
      window: s.currentWindow,
    })),
    tmuxWindows: startupWindows.map((w) => ({
      tmuxWindow: w.tmuxWindow,
      name: w.name,
    })),
  })
  // Start the poller after the initial refresh rather than at module load —
  // its first snapshot does synchronous sqlite work that otherwise races the
  // worker-spawn burst during boot.
  await ownershipObserver?.observe()
  if (config.logPollIntervalMs > 0) {
    logPoller.start(config.logPollIntervalMs, config.logWatchMode)
  }
  ownershipObserver?.start()
  await startupLifecycle.startupHousekeeping()
  try {
    await startupLifecycle.completeStartupVerification()
  } catch (error) {
    logger.warn('startup_verification_error', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
})()

// Cleanup all terminals on server shutdown
async function cleanupAllTerminals() {
  metadataPublisher.dispose()
  await prProvider.stop()
  await terminalRelay?.shutdown()
  ownershipObserver?.stop()
  persistenceRuntime?.stop()
  const disposePromises: Promise<void>[] = []
  for (const ws of sockets) {
    if (ws.data.terminal) {
      disposePromises.push(ws.data.terminal.dispose())
      ws.data.terminal = null
    }
    ws.data.currentSessionId = null
    ws.data.currentTmuxTarget = null
    ws.data.terminalHost = null
    clearAttachDedup(ws)
  }
  await Promise.allSettled(disposePromises)
  previews.dispose()
  stallWatchdog.dispose()
  throwawayShellReaper.dispose()
  setCodexSubagentIndexListener(null)
  metadataClient.dispose()
  activityClient.dispose()
  thumbnailClient.dispose()
  logPoller.stop()
  persistence?.dispose()
  sessionReader?.dispose()
  remotePoller.stop()
  db.close()
}

// The log file is written synchronously; this drains the pretty-stdout
// transport and is a cheap safety net on any exit path that reaches this
// handler (normal exit, uncaught fatal, and the signal handlers below).
process.on('exit', () => {
  releaseInstanceLock(config.dataDir)
  flushLogger()
})

process.on('SIGINT', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

/** Clear attach dedup state so a new/replacement proxy doesn't inherit stale history. */
function clearAttachDedup(ws: ServerWebSocket<WSData>) {
  ws.data.lastAttachKey = null
  ws.data.lastAttachTs = 0
}

function parseTmuxBufferSummaries(output: string): TmuxBufferSummary[] {
  const summaries: TmuxBufferSummary[] = []
  for (const line of splitTmuxLines(output)) {
    const parts = splitTmuxFields(line, 3)
    if (!parts) continue
    const name = parts[0]?.trim()
    const created = Number.parseInt(parts[1] ?? '', 10)
    const size = Number.parseInt(parts[2] ?? '', 10)
    if (!name || !Number.isFinite(created) || !Number.isFinite(size)) continue
    // Only tmux's automatic buffers (buffer0001, buffer0002, …) carry a
    // monotonic index. Explicitly named buffers (e.g. set-buffer -b snippet5)
    // get -1 so their trailing digits don't masquerade as recency.
    const orderMatch = name.match(/^buffer(\d+)$/)
    const order = orderMatch ? Number.parseInt(orderMatch[1], 10) : -1
    summaries.push({
      name,
      created,
      size,
      order,
      key: `${name}:${created}:${size}`,
    })
  }
  // Newest first. tmux's #{buffer_created} is whole-second resolution, so when
  // two buffers share a second, tiebreak by the monotonic automatic-buffer
  // index (buffer0002 newer than buffer0001) rather than size, which carries
  // no recency information.
  summaries.sort((a, b) => b.created - a.created || b.order - a.order || b.size - a.size)
  return summaries
}

/**
 * Run a read-only tmux command without blocking the event loop. The clipboard
 * watch polls on a 750ms timer, so using the synchronous Bun.spawnSync here
 * would stall terminal streaming for every session on each tick (up to
 * tmuxTimeoutMs if tmux is slow). Bun.spawn keeps it off the JS thread.
 */
async function readTmuxCapture(tmuxArgs: string[]): Promise<string | null> {
  // Belt-and-suspenders timeout: don't rely solely on Bun.spawn's `timeout`
  // option. Guarantee the process is killed (and thus `exited`/stdout resolve)
  // so a hung tmux can never leave clipboardPollInFlight stuck forever.
  let killTimer: ReturnType<typeof setTimeout> | null = null
  let kill: (() => void) | null = null
  try {
    const proc = Bun.spawn(['tmux', ...withTmuxUtf8Flag(tmuxArgs)], {
      stdout: 'pipe',
      // Ignore stderr rather than piping it: we never read it, and an
      // undrained pipe could fill its OS buffer and block the process exit.
      stderr: 'ignore',
      timeout: config.tmuxTimeoutMs,
      killSignal: 'SIGKILL',
      // Without env Bun reuses the process-start environ — the stale $TMUX
      // would send this client to the live server on isolated instances.
      env: sanitizedTmuxEnv(),
    })
    kill = () => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
    }
    killTimer = setTimeout(kill, config.tmuxTimeoutMs + 250)
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (exitCode !== 0) return null
    return stdout
  } catch {
    kill?.()
    return null
  } finally {
    if (killTimer !== null) clearTimeout(killTimer)
  }
}

async function readLatestTmuxBufferSummary(): Promise<TmuxBufferSummary | null> {
  const stdout = await readTmuxCapture([
    'list-buffers',
    '-F',
    buildTmuxFormat(['#{buffer_name}', '#{buffer_created}', '#{buffer_size}']),
  ])
  if (stdout === null) return null
  return parseTmuxBufferSummaries(stdout)[0] ?? null
}

async function readTmuxBufferText(summary: TmuxBufferSummary): Promise<string | null> {
  if (summary.size <= 0 || summary.size > CLIPBOARD_BUFFER_MAX_BYTES) {
    return null
  }
  const text = await readTmuxCapture(['show-buffer', '-b', summary.name])
  if (text === null) return null
  return text.trim() ? text : null
}

function stopClipboardBufferWatch(ws: ServerWebSocket<WSData>) {
  if (ws.data.clipboardPollTimer !== null) {
    clearInterval(ws.data.clipboardPollTimer)
  }
  // Bump the generation so any in-flight baseline read or poll from the watch
  // we're tearing down can't write back into a later watch on this socket.
  ws.data.clipboardWatchGen += 1
  ws.data.clipboardPollTimer = null
  ws.data.clipboardPollInFlight = false
  ws.data.lastClipboardBufferKey = null
  ws.data.clipboardBufferArmedUntil = 0
  ws.data.clipboardArmedAtSec = 0
}

function startClipboardBufferWatch(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  session: Session
) {
  stopClipboardBufferWatch(ws)

  if (session.remote) {
    return
  }

  const gen = ws.data.clipboardWatchGen
  ws.data.clipboardPollTimer = setInterval(() => {
    fireAndForget(pollClipboardBuffer(ws, sessionId, gen), 'pollClipboardBuffer')
  }, CLIPBOARD_BUFFER_POLL_MS)
  // Establish the baseline asynchronously so a pre-existing buffer isn't offered
  // on the first poll. Skip if this watch was already armed (a copy may have
  // landed before the read resolved — don't watermark the user's own buffer;
  // the created-time gate handles a genuinely pre-existing one) or superseded.
  fireAndForget(
    (async () => {
      const initial = await readLatestTmuxBufferSummary()
      if (
        ws.data.clipboardWatchGen === gen &&
        ws.data.lastClipboardBufferKey === null &&
        ws.data.clipboardBufferArmedUntil === 0
      ) {
        ws.data.lastClipboardBufferKey = initial?.key ?? null
      }
    })(),
    'clipboardBaseline'
  )
}

async function pollClipboardBuffer(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  gen: number
) {
  if (ws.data.clipboardWatchGen !== gen) return
  if (ws.data.clipboardPollInFlight) return
  if (!sockets.has(ws)) return
  if (ws.data.currentSessionId !== sessionId) return

  const session = registry.get(sessionId)
  if (!session || session.remote) return

  ws.data.clipboardPollInFlight = true
  try {
    const latest = await readLatestTmuxBufferSummary()
    // The read yields the event loop, so the watch may have been torn down or
    // the socket may have switched sessions while tmux ran. Re-validate before
    // touching state or offering.
    if (ws.data.clipboardWatchGen !== gen) return
    if (!sockets.has(ws) || ws.data.currentSessionId !== sessionId) return
    if (!latest) {
      ws.data.lastClipboardBufferKey = null
      return
    }
    if (latest.key === ws.data.lastClipboardBufferKey) {
      return
    }

    ws.data.lastClipboardBufferKey = latest.key
    if (Date.now() > ws.data.clipboardBufferArmedUntil) {
      logger.debug('clipboard_buffer_watermarked', {
        sessionId,
        bufferName: latest.name,
        bytes: latest.size,
        connectionId: ws.data.connectionId,
      })
      return
    }

    // Only offer buffers created at/after the arming gesture. A pre-existing or
    // unrelated (cross-window) buffer that becomes "latest" while armed has an
    // older creation time and is skipped, so it can't clobber the clipboard.
    if (latest.created < ws.data.clipboardArmedAtSec) {
      logger.debug('clipboard_buffer_precedes_arm', {
        sessionId,
        bufferName: latest.name,
        createdSec: latest.created,
        armedAtSec: ws.data.clipboardArmedAtSec,
        connectionId: ws.data.connectionId,
      })
      return
    }

    const text = await readTmuxBufferText(latest)
    if (!text) {
      logger.debug('clipboard_buffer_skipped', {
        sessionId,
        bufferName: latest.name,
        bytes: latest.size,
        connectionId: ws.data.connectionId,
      })
      return
    }

    // Re-validate again after the second tmux read before delivering, so we
    // never push a session A offer to a socket that has closed or moved to B.
    if (ws.data.clipboardWatchGen !== gen) return
    if (!sockets.has(ws) || ws.data.currentSessionId !== sessionId) return

    logger.debug('clipboard_buffer_offer', {
      sessionId,
      bufferName: latest.name,
      bytes: latest.size,
      connectionId: ws.data.connectionId,
    })
    send(ws, { type: 'clipboard-offer', sessionId, text, source: 'tmux-buffer' })
    ws.data.clipboardBufferArmedUntil = 0
    ws.data.clipboardArmedAtSec = 0
  } finally {
    // Only release the in-flight guard if the watch is still ours. If it was
    // stopped/restarted mid-poll, stopClipboardBufferWatch already reset the
    // guard for the new generation and we must not clear it out from under it.
    if (ws.data.clipboardWatchGen === gen) {
      ws.data.clipboardPollInFlight = false
    }
  }
}

// Arm the clipboard buffer watch on any left-button mouse event (press, drag,
// or release). This covers every selection style that copies to a tmux paste
// buffer — drag-select, double-click (word) and triple-click (line), which
// emit button-0 events with no motion bit. Bare taps also match, but they
// can't clobber the clipboard: the poll additionally requires the buffer to
// have been created at/after the gesture (see clipboardArmedAtSec), so a tap
// that copies nothing simply never produces an offer.
// SGR encoding: low 2 bits = button (0 = left), bits 6-7 (0xC0) = wheel/extended.
function containsClipboardArmingMouseInput(data: string): boolean {
  SGR_MOUSE_INPUT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SGR_MOUSE_INPUT_RE.exec(data)) !== null) {
    const button = Number(match[1])
    if ((button & 3) === 0 && (button & 0xc0) === 0) {
      return true
    }
  }
  return false
}

function cleanupTerminals(ws: ServerWebSocket<WSData>) {
  ws.data.terminalAttachSeq += 1
  stopClipboardBufferWatch(ws)
  if (ws.data.terminal) {
    const terminal = ws.data.terminal
    ws.data.terminal = null
    void terminal.dispose()
  }
  ws.data.currentSessionId = null
  ws.data.currentTmuxTarget = null
  ws.data.terminalHost = null
  clearAttachDedup(ws)
}

function broadcast(message: ServerMessage) {
  if (message.type === 'sessions' || message.type === 'session-update' || message.type === 'session-removed') {
    terminalRelay?.post({ type: 'sessions', sessions: registry.getAll(), terminalColorsEnabled: config.terminalColorsEnabled })
  }
  const payload = JSON.stringify(catalogMessage(message))
  for (const socket of sockets) {
    if (socket.data.access.role === 'admin') {
      socket.send(payload)
    } else {
      send(socket, message.type === 'session-removed' ? { type: 'sessions', sessions: registry.getAll() } : message)
    }
  }
}

function send(ws: ServerWebSocket<WSData>, message: ServerMessage) {
  let access = ws.data.access
  if (access.role === 'shared') {
    const current = boardAccess.grants.byId(access.id)
    if (!current) return
    access = current
  }
  const visible = visibleBoardMessage(access, message, id => registry.get(id))
  if (visible) ws.send(JSON.stringify(catalogMessage(visible)))
}

function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((err) => {
    logger.error('unhandled_async_error', {
      context,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

function handleMessage(
  ws: ServerWebSocket<WSData>,
  rawMessage: string | BufferSource
) {
  const text =
    typeof rawMessage === 'string'
      ? rawMessage
      : new TextDecoder().decode(rawMessage)

  let message: ClientMessage
  try {
    message = JSON.parse(text) as ClientMessage
  } catch {
    send(ws, { type: 'error', message: 'Invalid message payload' })
    return
  }

  if (!message || typeof message.type !== 'string') return
  if (ws.data.catalogVersion !== CATALOG_VERSION && message.type !== 'ping') return
  const original = ws.data.access
  const access = original.role === 'shared' ? boardAccess.grants.byId(original.id) : original
  if (!access || !canSendBoardMessage(access, message, id => registry.get(id))) {
    send(ws, { type: 'error', message: 'This token cannot access that action' })
    return
  }

  switch (message.type) {
    case 'ping':
      send(ws, message.seq != null ? { type: 'pong', seq: message.seq } : { type: 'pong' })
      return
    case 'session-refresh':
      refreshSessions()
      return
    case 'session-create':
      if (message.host) {
        fireAndForget(handleRemoteCreate(message.host, message.projectPath, message.name, message.command, ws), 'handleRemoteCreate')
      } else {
        try {
          const { operationId } = message
          if (
            operationId !== undefined &&
            (typeof operationId !== 'string' ||
              operationId.length === 0 ||
              operationId.length > 128)
          ) {
            throw new Error('Invalid operation ID')
          }
          const created = stampLocalSession(createPersistentWindow(
            message.projectPath,
            message.name,
            message.command,
            { operationId }
          ))
          // Add session to registry immediately so terminal can attach
          refreshGeneration++
          const currentSessions = registry.getAll()
          registry.replaceSessions([
            created,
            ...currentSessions.filter((s) => s.id !== created.id),
          ])
          refreshSessions()
          send(ws, { type: 'session-created', session: created })
        } catch (error) {
          send(ws, {
            type: 'error',
            message:
              error instanceof Error ? error.message : 'Unable to create session',
          })
        }
      }
      return
    case 'session-kill':
      fireAndForget(handleKill(message.sessionId, ws, message.source), 'handleKill')
      return
    case 'session-rename':
      fireAndForget(handleRename(message.sessionId, message.newName, ws), 'handleRename')
      return
	    case 'terminal-attach':
	      ws.data.terminalAttachSeq += 1
	      fireAndForget(attachTerminalPersistent(ws, message, ws.data.terminalAttachSeq), 'attachTerminalPersistent')
	      return
	    case 'terminal-detach':
	      detachTerminalPersistent(ws, message.sessionId)
	      return
    case 'terminal-input':
      handleTerminalInputPersistent(ws, message.sessionId, message.data)
      return
    case 'terminal-paste':
      handleTerminalPastePersistent(ws, message.sessionId, message.data, message.pasteId)
      return
    case 'terminal-resize':
      handleTerminalResizePersistent(
        ws,
        message.sessionId,
        message.cols,
        message.rows
      )
      return
    case 'tmux-cancel-copy-mode':
      // Exit tmux copy-mode when user starts typing after scrolling
      fireAndForget(handleCancelCopyMode(message.sessionId, ws), 'handleCancelCopyMode')
      return
    case 'tmux-check-copy-mode':
      fireAndForget(handleCheckCopyMode(message.sessionId, ws), 'handleCheckCopyMode')
      return
    case 'terminal-snapshot-request':
      fireAndForget(handleSnapshotRequest(message.sessionId, message.requestId, ws), 'handleSnapshotRequest')
      return
    case 'session-wake':
      handleSessionWake(message, ws)
      return
    case 'session-hibernate':
      handleSessionHibernate(message.sessionId, ws)
      return
    case 'session-move-to-history':
      handleMoveToHistory(message.sessionId, ws)
      return
    default:
      send(ws, { type: 'error', message: 'Unknown message type' })
  }
}

function resolveCopyModeTarget(
  sessionId: string,
  ws: ServerWebSocket<WSData>,
  session: Session
): string {
  if (ws.data.currentSessionId === sessionId && ws.data.currentTmuxTarget) {
    return ws.data.currentTmuxTarget
  }
  return session.tmuxWindow
}

async function handleRemoteCreate(
  host: string,
  projectPath: string,
  name: string | undefined,
  command: string | undefined,
  ws: ServerWebSocket<WSData>
) {
  if (!config.remoteAllowControl) {
    send(ws, { type: 'error', message: 'Remote session creation is disabled' })
    return
  }
  if (!isValidHostname(host)) {
    send(ws, { type: 'error', message: 'Invalid hostname' })
    return
  }
  if (!config.remoteHosts.includes(host)) {
    send(ws, { type: 'error', message: 'Host is not in the configured remote hosts list' })
    return
  }
  const trimmedPath = projectPath.trim()
  if (!trimmedPath) {
    send(ws, { type: 'error', message: 'Project path is required' })
    return
  }
  // Path must be absolute and not contain control characters
  if (!trimmedPath.startsWith('/')) {
    send(ws, { type: 'error', message: 'Project path must be an absolute path (starting with /)' })
    return
  }
  if (trimmedPath.includes('\n') || trimmedPath.includes('\r') || trimmedPath.includes('\0')) {
    send(ws, { type: 'error', message: 'Project path contains invalid characters' })
    return
  }

  // Validate name format if provided (same rules as rename)
  const windowName = name?.trim() || generateSessionName()
  if (name?.trim()) {
    const nameError = windowNameError(windowName)
    if (nameError) {
      send(ws, { type: 'error', message: nameError })
      return
    }
  }

  try {
    // Validate path exists on remote host
    const testResult = await runRemoteSsh(host, `test -d ${shellQuote(trimmedPath)}`)
    if (testResult.exitCode !== 0) {
      send(ws, { type: 'error', message: `Directory does not exist on ${host}: ${trimmedPath}` })
      return
    }

    // Check if tmux session already exists on remote
    const tmuxSession = config.tmuxSession
    const hasSessionResult = await runRemoteTmux(host, ['has-session', '-t', tmuxSession])
    const sessionExists = hasSessionResult.exitCode === 0

    const windowCommand = normalizePaneStartCommand(command?.trim() || '') || 'claude'
    // Wrap in interactive login shell so .bashrc PATH is available
    // (non-interactive shells skip .bashrc due to [ -z "$PS1" ] && return guard).
    // Fall back to raw command on systems without bash (e.g. Alpine).
    const bashCheck = await runRemoteSsh(host, 'command -v bash')
    const wrappedCommand = bashCheck.exitCode === 0
      ? `bash -lic ${shellQuote(windowCommand)}`
      : windowCommand
    let createResult: { exitCode: number; stdout: string; stderr: string }

    // Launch with Claude Code fullscreen ("no-flicker") rendering enabled so its
    // mouse features work in the browser terminal. The login shell inherits the env.
    const noFlickerEnv = config.claudeNoFlicker ? ['-e', 'CLAUDE_CODE_NO_FLICKER=1'] : []

    if (sessionExists) {
      // Session exists — add a new window to it
      createResult = await runRemoteTmux(host, [
        'new-window', '-P',
        ...noFlickerEnv,
        '-F', buildTmuxFormat(['#{window_index}', '#{window_id}']),
        '-t', tmuxSession, '-n', escapeTmuxFormatArg(windowName), '-c', trimmedPath, wrappedCommand,
      ])
    } else {
      // Session doesn't exist — create it with the desired window directly
      // (avoids an orphan window 0 from a separate new-session call)
      createResult = await runRemoteTmux(host, [
        'new-session', '-d', '-P',
        ...noFlickerEnv,
        '-F', buildTmuxFormat(['#{window_index}', '#{window_id}']),
        '-s', tmuxSession, '-n', escapeTmuxFormatArg(windowName), '-c', trimmedPath, wrappedCommand,
      ])
    }
    if (createResult.exitCode !== 0) {
      const stderr = createResult.stderr?.trim() ?? 'Unknown error'
      send(ws, { type: 'error', message: `Failed to create remote window: ${stderr}` })
      return
    }

    // Parse window info from -P output (e.g. "3\t@5")
    const printOutput = createResult.stdout?.trim() ?? ''
    const parts = splitTmuxFields(printOutput, 2)
    const now = Date.now()

    if (!parts || !parts[0]) {
      send(ws, { type: 'error', message: 'Failed to verify remote session creation' })
      return
    }

    const windowIndex = parts[0].trim()
    const windowId = (parts[1] ?? '').trim()
    const stableTarget = windowId || windowIndex

    // Verify the window actually persists. When adding a new window to an existing session,
    // `tmux has-session -t <session>` can still succeed even if the new window exited
    // immediately (and was cleaned up by tmux).
    const verifyResult = await runRemoteTmux(host, ['has-session', '-t', `${tmuxSession}:${stableTarget}`])
    if (verifyResult.exitCode !== 0) {
      logger.warn('remote_window_exited_immediately', {
        host,
        tmuxSession,
        windowName,
        windowIndex,
        windowId: windowId || undefined,
        stableTarget,
        command: windowCommand,
        wrappedCommand,
      })
      send(ws, {
        type: 'error',
        message: `Remote window exited immediately on ${host} — command "${windowCommand}" may have failed`,
      })
      return
    }
    const id = buildRemoteSessionId(host, tmuxSession, windowIndex, windowId)
    const createdSession: Session = {
      id,
      name: windowName,
      tmuxWindow: `${tmuxSession}:${stableTarget}`,
      projectPath: trimmedPath,
      status: 'unknown',
      lastActivity: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      source: 'managed',
      host,
      remote: true,
      command: windowCommand,
    }

    protectedRemoteSessionIds.set(createdSession.id, now)

    // Add to registry so it appears immediately
    const currentSessions = registry.getAll()
    registry.replaceSessions([createdSession, ...currentSessions])
    send(ws, { type: 'session-created', session: createdSession })
  } catch (error) {
    send(ws, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unable to create remote session',
    })
  }
}

async function handleCancelCopyMode(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session) return
  if (session.remote && !config.remoteAllowAttach) return

  try {
    // Exit tmux copy-mode quietly.
    const attachedTarget = resolveCopyModeTarget(sessionId, ws, session)
    const target = resolveLocalCopyModeTarget(attachedTarget, ws.data.currentSessionId === sessionId ? ws.data.terminal : null)
    if (session.remote && session.host) {
      await runRemoteTmux(session.host, ['send-keys', '-X', '-t', target, 'cancel'])
    } else {
      timedSpawnSync(['tmux', 'send-keys', '-X', '-t', target, 'cancel'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
      })
    }
  } catch {
    // Ignore errors - copy-mode may not be active
  }
}

async function handleCheckCopyMode(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session) return
  if (session.remote && !config.remoteAllowAttach) return

  const attachSeq = ws.data.terminalAttachSeq
  const attachedTarget = resolveCopyModeTarget(sessionId, ws, session)
  const terminal = ws.data.currentSessionId === sessionId ? ws.data.terminal : null
  const target = resolveLocalCopyModeTarget(attachedTarget, terminal)
  const tty = terminal?.getMode() === 'pty' ? terminal.getClientTty() : null
  const status = await ws.data.copyModeQuery.read(async () => {
    const args = copyModeCommand(target, tty)
    if (session.remote && session.host) {
      const result = await runRemoteTmux(session.host, args)
      return result.stdout ?? ''
    }
    const result = await timedSpawnAsync(['tmux', ...withTmuxUtf8Flag(args)], { timeout: 5000 })
    return result.exitCode === 0 ? result.stdout : ''
  }, () => ws.readyState === 1 && isTerminalAttachCurrent(ws, attachSeq))
  if (status) send(ws, { type: 'tmux-copy-mode-status', sessionId, ...status })
}

async function handleSnapshotRequest(sessionId: string, requestId: number, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  const fail = () => send(ws, { type: 'terminal-snapshot', sessionId, requestId, ok: false })
  if (!session || !Number.isSafeInteger(requestId)) return fail()
  if (session.remote && !config.remoteAllowAttach) return fail()

  const target = resolveCopyModeTarget(sessionId, ws, session)
  const startedAt = performance.now()
  const snapshot = await capturePaneSnapshot(target, async (args) => {
    if (session.remote && session.host) return runRemoteTmux(session.host, args)
    return timedSpawnAsync(['tmux', ...withTmuxUtf8Flag(args)], { timeout: config.tmuxTimeoutMs })
  }).catch(() => null)
  if (ws.readyState !== 1) return
  if (!snapshot) return fail()
  const captureMs = Math.round(performance.now() - startedAt)
  send(ws, { type: 'terminal-snapshot', sessionId, requestId, ok: true, captureMs, ...snapshot })
}

function restoreHibernatingState(previousHibernatingState: Map<string, boolean>) {
  for (const [agentSessionId, isHibernating] of previousHibernatingState) {
    try {
      db.updateSession(agentSessionId, { isHibernating })
    } catch {
      // Best effort rollback; the original failure remains the primary error.
    }
  }
}

const SESSION_KILL_SOURCES: readonly SessionKillSource[] = [
  'keyboard_shortcut',
  'session_list_context_menu',
  'terminal_confirm_modal',
  'unknown',
]

function normalizeSessionKillSource(source: unknown): SessionKillSource {
  if (
    typeof source === 'string' &&
    (SESSION_KILL_SOURCES as readonly string[]).includes(source)
  ) {
    return source as SessionKillSource
  }
  return 'unknown'
}

function getKillAuditFields(
  ws: ServerWebSocket<WSData>,
  requestedSessionId: string,
  killSource: SessionKillSource,
  session?: Session,
) {
  return {
    requestedSessionId,
    killSource,
    connectionId: ws.data.connectionId,
    remoteAddress: ws.data.remoteAddress ?? ws.remoteAddress ?? null,
    userAgent: ws.data.userAgent,
    sessionFound: Boolean(session),
    sessionId: session?.id ?? null,
    tmuxWindow: session?.tmuxWindow ?? null,
    name: session?.name ?? null,
    projectPath: session?.projectPath ?? null,
    agentSessionId: session?.agentSessionId ?? null,
    agentSessionIds: null as string[] | null,
    agentSessionName: session?.agentSessionName ?? null,
    agentType: session?.agentType ?? null,
    sessionSource: session?.source ?? null,
    host: session?.host ?? null,
    remote: session?.remote ?? null,
  }
}

function sendKillFailed(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  message: string,
  auditFields: ReturnType<typeof getKillAuditFields>,
  startedAt: number,
  reason: string,
) {
  logger.warn('session_kill_failed', {
    ...auditFields,
    reason,
    error: message,
    durationMs: Date.now() - startedAt,
  })
  send(ws, { type: 'kill-failed', sessionId, message })
}

async function handleKill(
  sessionId: string,
  ws: ServerWebSocket<WSData>,
  source?: SessionKillSource,
) {
  const startedAt = Date.now()
  const killSource = normalizeSessionKillSource(source)
  const session = registry.get(sessionId)
  let auditFields = getKillAuditFields(ws, sessionId, killSource, session)
  logger.info('session_kill_requested', auditFields)

  if (!killRateLimiter.tryAcquire(ws.data.connectionId)) {
    sendKillFailed(
      ws,
      sessionId,
      'Too many kills in a row — slow down',
      auditFields,
      startedAt,
      'rate_limited',
    )
    return
  }

  if (!session) {
    sendKillFailed(ws, sessionId, 'Session not found', auditFields, startedAt, 'not_found')
    return
  }
  if (session.remote && !config.remoteAllowControl) {
    sendKillFailed(
      ws,
      sessionId,
      'Remote sessions are read-only',
      auditFields,
      startedAt,
      'remote_read_only',
    )
    return
  }
  if (session.remote && config.remoteAllowControl && session.host) {
    if (session.source !== 'managed') {
      sendKillFailed(
        ws,
        sessionId,
        'Cannot kill external remote sessions',
        auditFields,
        startedAt,
        'external_remote_session',
      )
      return
    }
    try {
      const result = await runRemoteTmux(session.host, ['kill-window', '-t', session.tmuxWindow])
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.trim() ?? 'Unknown error'
        sendKillFailed(ws, sessionId, stderr, auditFields, startedAt, 'remote_kill_failed')
        return
      }
      remoteSessionNameOverrides.delete(sessionId)
      remoteSessionTombstones.set(sessionId, Date.now())
      const remaining = registry.getAll().filter((item) => item.id !== sessionId)
      registry.replaceSessions(remaining)
      logger.info('session_kill_completed', {
        ...auditFields,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      sendKillFailed(
        ws,
        sessionId,
        error instanceof Error ? error.message : 'Unable to kill remote session',
        auditFields,
        startedAt,
        'remote_kill_exception',
      )
    }
    return
  }
  if (session.source !== 'managed' && !config.allowKillExternal) {
    sendKillFailed(
      ws,
      sessionId,
      'Cannot kill external sessions',
      auditFields,
      startedAt,
      'external_session',
    )
    return
  }

  const recordByWindow = db.getSessionByWindow(session.tmuxWindow)
  const agentSessionIds = new Set<string>()
  if (session.agentSessionId?.trim()) {
    agentSessionIds.add(session.agentSessionId.trim())
  }
  if (recordByWindow) {
    agentSessionIds.add(recordByWindow.sessionId)
  }
  auditFields = {
    ...auditFields,
    agentSessionIds: Array.from(agentSessionIds),
  }
  const previousHibernatingState = new Map<string, boolean>()

  try {
    for (const agentSessionId of agentSessionIds) {
      const current = db.getSessionById(agentSessionId)
      if (!current) continue
      previousHibernatingState.set(agentSessionId, current.isHibernating)
      const updated = db.updateSession(agentSessionId, { isHibernating: false })
      if (!updated) {
        throw new Error('Failed to clear hibernation marker')
      }
    }
  } catch (error) {
    restoreHibernatingState(previousHibernatingState)
    sendKillFailed(
      ws,
      sessionId,
      error instanceof Error ? error.message : 'Unable to prepare session kill',
      auditFields,
      startedAt,
      'prepare_failed',
    )
    return
  }

  try {
    // Archive the catalog row only when it owns this window in the current
    // tmux server; a stale row with a reused window id is left alone.
    const owner = persistence?.ownerOfWindow(session.tmuxWindow) ?? null
    if (owner) {
      persistence!.stop(owner, 'archived')
    } else {
      sessionManager.killWindow(session.tmuxWindow)
    }
  } catch (error) {
    restoreHibernatingState(previousHibernatingState)
    sendKillFailed(
      ws,
      sessionId,
      error instanceof Error ? error.message : 'Unable to kill session',
      auditFields,
      startedAt,
      'kill_failed',
    )
    return
  }

  // Bump generation so any in-flight refresh discards its stale result
  refreshGeneration++
  const orphaned = new Map<string, AgentSession>()
  for (const agentSessionId of agentSessionIds) {
    try {
      const orphanedSession = db.updateSession(agentSessionId, {
        currentWindow: null,
        isHibernating: false,
      })
      if (orphanedSession) {
        orphaned.set(agentSessionId, toAgentSession(orphanedSession))
      }
    } catch (error) {
      logger.error('session_kill_orphan_update_failed', {
        sessionId: agentSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (orphaned.size > 0) {
    updateDormantAgentSessions()
    for (const orphanedSession of orphaned.values()) {
      broadcast({ type: 'session-orphaned', session: orphanedSession })
    }
  }
  const remaining = registry.getAll().filter((item) => item.id !== sessionId)
  registry.replaceSessions(remaining)
  logger.info('session_kill_completed', {
    ...auditFields,
    durationMs: Date.now() - startedAt,
  })
  // Don't call refreshSessions() here — the registry is already updated
  // synchronously.  An async refresh would race with the tmux process
  // dying and could re-add the killed window to the registry before the
  // process exits, causing stale broadcasts that resurrect the session
  // on the client.  The periodic refresh handles reconciliation.
}

async function handleRename(
  sessionId: string,
  newName: string,
  ws: ServerWebSocket<WSData>
) {
  let session = registry.get(sessionId)
  if (!session) {
    refreshSessionsSync() // Use sync for inline operations needing immediate results
    session = registry.get(sessionId)
    if (!session) {
      const record = db.getSessionById(sessionId)
      if (record && !record.currentWindow) {
        const trimmed = newName.trim()
        const nameError = windowNameError(trimmed)
        if (nameError) {
          send(ws, { type: 'error', message: nameError })
          return
        }
        if (db.displayNameExists(trimmed, sessionId)) {
          send(ws, { type: 'error', message: 'Name already exists' })
          return
        }
        const updated = db.updateSession(sessionId, { displayName: trimmed })
        if (!updated) {
          send(ws, { type: 'error', message: 'Unable to rename session' })
          return
        }
        updateDormantAgentSessions()
        return
      }
      send(ws, { type: 'error', message: 'Session not found' })
      return
    }
  }
  if (session.remote && !config.remoteAllowControl) {
    send(ws, { type: 'error', message: 'Remote sessions are read-only' })
    return
  }
  if (session.remote && config.remoteAllowControl && session.host) {
    if (session.source !== 'managed') {
      send(ws, { type: 'error', message: 'Cannot rename external remote sessions' })
      return
    }
    const trimmed = newName.trim()
    const nameError = windowNameError(trimmed)
    if (nameError) {
      send(ws, { type: 'error', message: nameError })
      return
    }
    try {
      // `--` stops a leading '-' in the name from being parsed as a flag
      const result = await runRemoteTmux(session.host, [
        'rename-window',
        '-t',
        session.tmuxWindow,
        ...(trimmed.startsWith('-') ? ['--'] : []),
        escapeTmuxFormatArg(trimmed),
      ])
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.trim() ?? 'Unknown error'
        send(ws, { type: 'error', message: stderr })
        return
      }
      remoteSessionNameOverrides.set(sessionId, { name: trimmed, setAt: Date.now() })
      const currentSessions = registry.getAll()
      const nextSessions = currentSessions.map((item) =>
        item.id === sessionId ? { ...item, name: trimmed } : item
      )
      registry.replaceSessions(nextSessions)
    } catch (error) {
      send(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to rename remote session',
      })
    }
    return
  }

  try {
    if (persistence) persistence.renameWindow(session.tmuxWindow, newName)
    else sessionManager.renameWindow(session.tmuxWindow, newName)
    refreshSessions()
  } catch (error) {
    send(ws, {
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Unable to rename session',
    })
  }
}

function handleMoveToHistory(
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
  if (!isValidSessionId(sessionId)) {
    send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Invalid session id' })
    return
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Session not found' })
    return
  }
  if (record.currentWindow) {
    send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Session is active' })
    return
  }

  const saved = persistence?.catalog.byProvider(sessionId)
  if (saved) {
    persistence?.catalog.pin(saved.id, false)
    persistence?.catalog.transition(saved.id, 'archived')
  }
  const updated = db.setHibernating(sessionId, false)
  if (!updated) {
    send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Failed to move session to History' })
    return
  }

  send(ws, {
    type: 'session-move-to-history-result',
    sessionId,
    ok: true,
    session: toAgentSession(updated),
  })

  // Update all active sessions that match (in case of edge cases with multiple windows).
  for (const session of registry.getAll()) {
    if (session.agentSessionId === sessionId) {
      registry.updateSession(session.id, { isHibernating: false })
    }
  }

  updateDormantAgentSessions()
}

function handleSessionHibernate(
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
  if (!isValidSessionId(sessionId)) {
    logger.warn('session_hibernate_failed', { sessionId, reason: 'invalid_id' })
    send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Invalid session id' })
    return
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    logger.warn('session_hibernate_failed', { sessionId, reason: 'not_found' })
    send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Session not found' })
    return
  }

  // Idempotent ack: already hibernating. A reconnect-storm replay or a double
  // click shouldn't surface a spurious error to the user.
  if (record.isHibernating && !record.currentWindow) {
    logger.info('session_hibernate_noop', {
      sessionId,
      agentType: record.agentType,
      displayName: record.displayName,
    })
    send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: true,
      session: toAgentSession(record),
    })
    return
  }

  if (!record.currentWindow) {
    logger.warn('session_hibernate_failed', { sessionId, reason: 'not_active' })
    send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Session is not active' })
    return
  }

  const liveSession =
    registry.get(record.currentWindow) ??
    registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)

  if (!liveSession || liveSession.remote || liveSession.source !== 'managed') {
    logger.warn('session_hibernate_failed', {
      sessionId,
      reason: 'not_local_managed',
      agentType: record.agentType,
    })
    send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: false,
      error: 'Only local managed sessions can be hibernated',
    })
    return
  }

  const originalMarker = record.isHibernating
  const originalResumeError = record.lastResumeError
  const liveTmuxWindow = liveSession.tmuxWindow
  const markerPatch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>> = {
    isHibernating: true,
    lastResumeError: null,
  }
  if (!record.projectPath && liveSession.projectPath) {
    markerPatch.projectPath = liveSession.projectPath
  }
  if (liveSession.command && !record.launchCommand) {
    markerPatch.launchCommand = liveSession.command
  }
  const startedAt = Date.now()
  let marked: ReturnType<typeof db.updateSession>
  try {
    marked = db.updateSession(sessionId, markerPatch)
  } catch (error) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_marker_update_failed',
      agentType: record.agentType,
      error: error instanceof Error ? error.message : String(error),
    })
    send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: false,
      error: 'Failed to update session state',
    })
    return
  }
  if (!marked) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_marker_update_failed',
      agentType: record.agentType,
    })
    send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: false,
      error: 'Failed to update session state',
    })
    return
  }

  let catalogOwner: SavedSession | null = null
  try {
    // Only a catalog row that owns this window in the current tmux server is
    // moved to hibernating; a stale row with a reused window id is left alone.
    catalogOwner = persistence?.ownerOfWindow(liveTmuxWindow) ?? null
    if (catalogOwner) {
      persistence!.stop(catalogOwner, 'hibernating')
    } else {
      sessionManager.killWindow(liveTmuxWindow)
    }
  } catch (error) {
    let targetStillExists = true
    try {
      targetStillExists = sessionManager
        .listWindows()
        .some((session) => session.tmuxWindow === liveTmuxWindow)
    } catch (listError) {
      logger.warn('session_hibernate_recheck_failed', {
        sessionId,
        tmuxWindow: liveTmuxWindow,
        killError: error instanceof Error ? error.message : String(error),
        listError: listError instanceof Error ? listError.message : String(listError),
      })
    }

    if (!targetStillExists) {
      // The kill lost a race with the window exiting. Finish the catalog side
      // too, or the next reconcile would mark the row interrupted.
      if (catalogOwner) {
        try {
          persistence!.retire(catalogOwner, 'hibernating')
        } catch (retireError) {
          logger.warn('session_hibernate_catalog_retire_failed', {
            sessionId,
            error: retireError instanceof Error ? retireError.message : String(retireError),
          })
        }
      }
      logger.info('session_hibernate_target_already_gone', {
        sessionId,
        agentType: record.agentType,
        displayName: record.displayName,
        tmuxWindow: liveTmuxWindow,
      })
    } else {
      try {
        db.updateSession(sessionId, {
          isHibernating: originalMarker,
          lastResumeError: originalResumeError,
          launchCommand: record.launchCommand,
        })
      } catch {
        // Best effort rollback; preserve the original kill failure for the user.
      }
      const message = error instanceof Error ? error.message : 'Unable to hibernate session'
      logger.error('session_hibernate_failed', {
        sessionId,
        reason: 'kill_failed',
        error: message,
        agentType: record.agentType,
      })
      send(ws, {
        type: 'session-hibernate-result',
        sessionId,
        ok: false,
        error: message,
      })
      return
    }
  }

  refreshGeneration++
  let updated: ReturnType<typeof db.updateSession>
  try {
    updated = db.updateSession(sessionId, {
      currentWindow: null,
      isHibernating: true,
      lastResumeError: null,
    })
  } catch (error) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_update_failed',
      error: error instanceof Error ? error.message : String(error),
      agentType: record.agentType,
    })
    send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Failed to update session state' })
    return
  }
  if (!updated) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_update_failed',
      agentType: record.agentType,
    })
    send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Failed to update session state' })
    return
  }

  logger.info('session_hibernate_success', {
    sessionId,
    agentType: record.agentType,
    displayName: record.displayName,
    tmuxWindow: liveTmuxWindow,
    durationMs: Date.now() - startedAt,
  })

  send(ws, {
    type: 'session-hibernate-result',
    sessionId,
    ok: true,
    session: toAgentSession(updated),
  })

  const remaining = registry.getAll().filter((session) => session.id !== liveSession.id)
  registry.replaceSessions(remaining)
  updateDormantAgentSessions()
}

/**
 * Build a resume command by injecting stored launch flags into the resume template.
 * e.g. stored "claude --dangerously-skip-permissions" + template "claude --resume {sessionId}"
 *   → "claude --dangerously-skip-permissions --resume <id>"
 * e.g. stored "codex --yolo --search" + template "codex resume {sessionId}"
 *   → "codex --yolo --search resume <id>"
 * e.g. stored "pi --fast" + template "pi --session {logFilePath}"
 *   → "pi --fast --session <log-file-path>"
 */
function getResumeCommandTemplate(agentType: AgentType): string {
  if (agentType === 'claude' || agentType === 'claude-rp') {
    return config.claudeResumeCmd
  }
  if (agentType === 'pi') {
    return config.piResumeCmd
  }
  if (agentType === 'devin') {
    return config.devinResumeCmd
  }
  if (agentType === 'antigravity') return config.antigravityResumeCmd
  if (agentType === 'grok') {
    return config.grokResumeCmd
  }
  if (agentType === 'omp') {
    return config.ompResumeCmd
  }
  return config.codexResumeCmd
}

function renderResumeCommandTemplate(
  resumeTemplate: string,
  record: AgentSessionRecord
): string {
  return resumeTemplate
    .replace(/\{sessionId\}/g, shellQuote(record.sessionId))
    .replace(/\{logFilePath\}/g, shellQuote(record.logFilePath))
}

function buildResumeCommand(
  record: AgentSessionRecord
): string {
  const resumeTemplate = getResumeCommandTemplate(record.agentType)
  const baseResumeCmd = renderResumeCommandTemplate(resumeTemplate, record)

  if (!record.launchCommand) {
    return baseResumeCmd
  }

  // Extract flags from the stored command: strip the executable (first token)
  // and any existing resume subcommand/flag + its session ID argument.
  // Normalize first to handle tmux quoting and bash -lc wrappers.
  const resumableArg = /(?:"[^"]*"|'[^']*'|\S+)/
  let flags = normalizePaneStartCommand(record.launchCommand)
    .replace(/^\S+\s*/, '')             // strip executable
    .replace(new RegExp(`--resume(?:\\s+|=)${resumableArg.source}`, 'g'), '') // strip --resume <id> / --resume=<id> (Claude, omp)
    .replace(new RegExp(`\\bresume\\s+${resumableArg.source}`, 'g'), '') // strip resume <id> (Codex subcommand)
    .replace(new RegExp(`--session(?:\\s+|=)${resumableArg.source}`, 'g'), '') // strip --session <path> / --session=<path> (Pi)

  if (record.agentType === 'pi' || record.agentType === 'omp') {
    flags = flags
      // strip -r <id|path> (omp resume short flag)
      .replace(new RegExp(`(?:^|\\s)-r(?:\\s+|=)${resumableArg.source}`, 'g'), ' ')
      // strip -c / --continue (omp "continue previous session" flags)
      .replace(/(?:^|\s)--continue\b/g, ' ')
      .replace(/(?:^|\s)-c(?=\s|$)/g, ' ')
  }

  if (record.agentType === 'antigravity') {
    flags = flags
      .replace(new RegExp(`(?:^|\\s)--conversation(?:\\s+|=)${resumableArg.source}`, 'g'), ' ')
      .replace(/(?:^|\s)(?:-c|--continue)(?=\s|$)/g, ' ')
  }

  flags = flags.replace(/\s+/g, ' ').trim()

  if (!flags) {
    return baseResumeCmd
  }

  // Inject flags after the executable in the resume command
  const firstSpace = baseResumeCmd.indexOf(' ')
  if (firstSpace === -1) {
    return `${baseResumeCmd} ${flags}`
  }
  const exe = baseResumeCmd.slice(0, firstSpace)
  const rest = baseResumeCmd.slice(firstSpace + 1)
  return `${exe} ${flags} ${rest}`
}

function validateWakeTemplate(record: AgentSessionRecord): WakeError | null {
  const resumeTemplate = getResumeCommandTemplate(record.agentType)
  if (
    resumeTemplate.includes('{sessionId}') ||
    resumeTemplate.includes('{logFilePath}')
  ) {
    return null
  }

  return {
    code: 'WAKE_FAILED',
    message: 'Wake command template missing {sessionId} or {logFilePath} placeholder',
  }
}

function recordWakeFailure(sessionId: string, message: string) {
  try {
    db.updateSession(sessionId, {
      lastResumeError: message,
      wakeStartedAt: null,
    })
    updateDormantAgentSessions()
  } catch (error) {
    logger.error('session_wake_error_persist_failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function hydrateWakeSession(
  session: Session,
  record: AgentSessionRecord
): Session {
  return stampLocalSession({
    ...session,
    agentType: session.agentType ?? record.agentType,
    agentSessionId: record.sessionId,
    agentSessionName: record.displayName,
    logFilePath: record.logFilePath,
    lastUserMessage: record.lastUserMessage ?? session.lastUserMessage,
    lastActivity: record.lastActivityAt,
    createdAt: record.createdAt,
    isHibernating: record.isHibernating,
  })
}

function tryRematchDormantSession(
  record: AgentSessionRecord
): { session: Session; record: AgentSessionRecord } | null {
  refreshSessionsSync()

  const alreadyHydrated = registry.getAll().find(
    (session) =>
      !session.remote &&
      (session.agentSessionId?.trim() === record.sessionId ||
        session.logFilePath === record.logFilePath)
  )
  if (alreadyHydrated) {
    const claimExtra: ClaimCurrentWindowPatch = {
      displayName: alreadyHydrated.name,
      lastResumeError: null,
      wakeStartedAt: null,
    }
    if (alreadyHydrated.command && !record.launchCommand) {
      claimExtra.launchCommand = alreadyHydrated.command
    }
    const updated = db.claimCurrentWindow(
      record.sessionId,
      alreadyHydrated.tmuxWindow,
      claimExtra
    )
    if (!updated) {
      return null
    }
    const hydrated = hydrateWakeSession(alreadyHydrated, updated)
    registry.replaceSessions(
      registry.getAll().map((session) =>
        session.id === hydrated.id ? hydrated : session
      )
    )
    updateDormantAgentSessions()
    return { session: hydrated, record: updated }
  }

  if (!record.logFilePath) {
    return null
  }

  const claimedWindows = new Set(
    db.getActiveSessions()
      .map((session) => session.currentWindow)
      .filter(Boolean) as string[]
  )
  const candidates = registry
    .getAll()
    .filter(
      (session) =>
        !session.remote && !claimedWindows.has(session.tmuxWindow)
    )
  if (candidates.length === 0) {
    return null
  }

  try {
    const result = matchWindowsToLogsByExactRg(
      candidates,
      getLogSearchDirs(),
      DEFAULT_SCROLLBACK_LINES,
      {
        logPaths: [record.logFilePath],
        rgThreads: config.rgThreads,
      }
    )
    const match = result.matches.get(record.logFilePath)
    if (!match) {
      return null
    }
    const claimExtra: ClaimCurrentWindowPatch = {
      displayName: match.name,
      lastResumeError: null,
      wakeStartedAt: null,
    }
    if (match.command && !record.launchCommand) {
      claimExtra.launchCommand = match.command
    }
    const updated = db.claimCurrentWindow(record.sessionId, match.tmuxWindow, claimExtra)
    if (!updated) {
      return null
    }
    const hydrated = hydrateWakeSession(match, updated)
    registry.replaceSessions(
      registry.getAll().map((session) =>
        session.id === hydrated.id ? hydrated : session
      )
    )
    updateDormantAgentSessions()
    logger.info('session_wake_rematch_success', {
      sessionId: record.sessionId,
      window: match.tmuxWindow,
      displayName: match.name,
    })
    return { session: hydrated, record: updated }
  } catch (error) {
    logger.warn('session_wake_rematch_failed', {
      sessionId: record.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Kill a window a wake created but will not keep, retiring its catalog row. */
function killWakeWindow(tmuxWindow: string) {
  if (persistence) persistence.killWindow(tmuxWindow, 'hibernating')
  else sessionManager.killWindow(tmuxWindow)
}

function handleSessionWake(
  message: Extract<ClientMessage, { type: 'session-wake' }>,
  ws: ServerWebSocket<WSData>
) {
  const sessionId = message.sessionId
  if (!isValidSessionId(sessionId)) {
    logger.warn('session_wake_failed', { sessionId, reason: 'invalid_id' })
    const error: WakeError = {
      code: 'NOT_FOUND',
      message: 'Invalid session id',
    }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    logger.warn('session_wake_failed', { sessionId, reason: 'not_found' })
    const error: WakeError = { code: 'NOT_FOUND', message: 'Session not found' }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  if (record.currentWindow) {
    // Idempotent ack when the session is already live AND we can confirm it
    // in the registry — protects against stale messages from a reconnect
    // storm. If the registry doesn't know about it we fall through to the
    // error so the client can refresh rather than silently trusting stale DB.
    const liveSession =
      registry.get(record.currentWindow) ??
      registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)
    if (liveSession) {
      if (record.wakeStartedAt || record.lastResumeError) {
        try {
          db.updateSession(sessionId, {
            wakeStartedAt: null,
            lastResumeError: null,
          })
          updateDormantAgentSessions()
        } catch (error) {
          logger.warn('session_wake_marker_clear_failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      logger.info('session_wake_noop', {
        sessionId,
        agentType: record.agentType,
        displayName: record.displayName,
      })
      send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
      return
    }
    logger.warn('session_wake_failed', { sessionId, reason: 'already_active_stale_registry' })
    const error: WakeError = {
      code: 'ALREADY_ACTIVE',
      message: 'Session is already active',
    }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  if (wakeInFlight.has(sessionId)) {
    logger.info('session_wake_noop', {
      sessionId,
      reason: 'wake_in_flight',
      agentType: record.agentType,
      displayName: record.displayName,
    })
    const error: WakeError = {
      code: 'WAKE_IN_PROGRESS',
      message: 'Wake already in progress for this session',
    }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  wakeInFlight.add(sessionId)
  let createdWindowToCleanup: string | null = null

  try {
    const latest = db.getSessionById(sessionId) ?? record
    if (latest.currentWindow) {
      const liveSession =
        registry.get(latest.currentWindow) ??
        registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)
      if (liveSession) {
        send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
        return
      }
    }

    const rematched = tryRematchDormantSession(latest)
    if (rematched) {
      send(ws, { type: 'session-wake-result', sessionId, ok: true, session: rematched.session })
      broadcast({
        type: 'session-activated',
        session: toAgentSession(rematched.record),
        window: rematched.session.tmuxWindow,
      })
      return
    }

    const templateError = validateWakeTemplate(latest)
    if (templateError) {
      logger.error('session_wake_failed', {
        sessionId,
        reason: 'bad_template',
        agentType: latest.agentType,
      })
      recordWakeFailure(sessionId, templateError.message)
      send(ws, { type: 'session-wake-result', sessionId, ok: false, error: templateError })
      return
    }

    const command = buildResumeCommand(latest)
    const projectPath =
      latest.projectPath ||
      (latest.agentType === 'antigravity' && antigravityProjectPath(sessionId)) ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      '.'
    const wakeStartedAt = new Date().toISOString()
    const marked = db.updateSession(sessionId, {
      wakeStartedAt,
      lastResumeError: null,
    })
    if (!marked) {
      throw new Error('Session not found')
    }

    const startedAt = Date.now()
    // Name is driven by the stored displayName — createWindow will auto-suffix
    // on genuine collisions with other live sessions (excludeSessionId keeps
    // the session's own prior name from matching itself).
    const created = stampLocalSession(createPersistentWindow(
      projectPath,
      latest.displayName,
      command,
      { excludeSessionId: sessionId }
    ))
    createdWindowToCleanup = created.tmuxWindow
    // Atomic claim: only persist the new window if no other writer (LogPoller
    // rematch, concurrent wake) claimed current_window between our initial
    // read and createWindow. If the claim fails, kill the new window so we
    // don't leak a tmux window with a duplicate agent process.
    const updatedRecord = db.claimCurrentWindow(sessionId, created.tmuxWindow, {
      displayName: created.name,
      lastResumeError: null,
      wakeStartedAt: null,
    })
    if (!updatedRecord) {
      const reread = db.getSessionById(sessionId)
      if (reread?.currentWindow === created.tmuxWindow) {
        const resolvedRecord =
          reread.wakeStartedAt || reread.lastResumeError
            ? db.updateSession(sessionId, {
                wakeStartedAt: null,
                lastResumeError: null,
              }) ?? reread
            : reread
        createdWindowToCleanup = null
        refreshGeneration++
        const hydrated = hydrateWakeSession(created, resolvedRecord)
        const currentSessions = registry
          .getAll()
          .filter((session) =>
            session.id !== hydrated.id &&
            session.tmuxWindow !== hydrated.tmuxWindow
          )
        registry.replaceSessions([hydrated, ...currentSessions])
        updateDormantAgentSessions()
        refreshSessions()
        send(ws, { type: 'session-wake-result', sessionId, ok: true, session: hydrated })
        broadcast({
          type: 'session-activated',
          session: toAgentSession(resolvedRecord),
          window: hydrated.tmuxWindow,
        })
        logger.info('session_wake_success', {
          sessionId,
          reason: 'window_claimed_concurrently',
          agentType: latest.agentType,
          displayName: latest.displayName,
          tmuxWindow: created.tmuxWindow,
          durationMs: Date.now() - startedAt,
        })
        return
      }

      const ownerOfCreatedWindow = db.getSessionByWindow(created.tmuxWindow)
      if (ownerOfCreatedWindow && ownerOfCreatedWindow.sessionId !== sessionId) {
        createdWindowToCleanup = null
        try {
          db.updateSession(sessionId, { wakeStartedAt: null })
        } catch (error) {
          logger.warn('session_wake_marker_clear_failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        refreshSessionsSync()
        updateDormantAgentSessions()
        logger.info('session_wake_noop', {
          sessionId,
          reason: 'created_window_claimed_by_other_session',
          claimedBySessionId: ownerOfCreatedWindow.sessionId,
          agentType: latest.agentType,
          displayName: latest.displayName,
          tmuxWindow: created.tmuxWindow,
        })
        const err: WakeError = {
          code: 'WAKE_IN_PROGRESS',
          message: 'Wake window was claimed by another session; retry shortly',
        }
        send(ws, { type: 'session-wake-result', sessionId, ok: false, error: err })
        return
      }

      // Retire the wake's catalog row with its window. A bare kill would leave
      // the row "running" on a dead window, and the next reconcile would then
      // release the conversation claim the rematcher just gave another window.
      try {
        killWakeWindow(created.tmuxWindow)
      } catch {
        // may already be gone
      }
      createdWindowToCleanup = null
      try {
        db.updateSession(sessionId, { wakeStartedAt: null })
      } catch (error) {
        logger.warn('session_wake_marker_clear_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // Sync refresh so the registry reflects the racing claim before we look
      // up the live session — the rematcher updates DB before its own
      // session-activated emission, so without this we may miss it.
      refreshSessionsSync()
      const latestRecord = db.getSessionById(sessionId)
      const liveSession = latestRecord?.currentWindow
        ? registry.get(latestRecord.currentWindow) ??
          registry.getAll().find((s) => s.agentSessionId?.trim() === sessionId)
        : undefined
      logger.info('session_wake_noop', {
        sessionId,
        reason: 'window_claimed_concurrently',
        agentType: latest.agentType,
        displayName: latest.displayName,
      })
      if (liveSession) {
        send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
      } else {
        // Claim was lost but we can't surface the racing session yet — return
        // an error so the client toasts and the user can retry instead of
        // silently doing nothing.
        const err: WakeError = {
          code: 'WAKE_IN_PROGRESS',
          message: 'Wake raced with another claim; retry shortly',
        }
        send(ws, { type: 'session-wake-result', sessionId, ok: false, error: err })
      }
      return
    }
    createdWindowToCleanup = null
    // Add session to registry immediately so terminal can attach
    // (async refresh will update with any additional data later)
    refreshGeneration++
    const currentSessions = registry.getAll()
    const hydrated = hydrateWakeSession(created, updatedRecord)
    registry.replaceSessions([hydrated, ...currentSessions])
    updateDormantAgentSessions()
    refreshSessions()
    send(ws, { type: 'session-wake-result', sessionId, ok: true, session: hydrated })
    broadcast({
      type: 'session-activated',
      session: toAgentSession(updatedRecord),
      window: hydrated.tmuxWindow,
    })
    logger.info('session_wake_success', {
      sessionId,
      agentType: latest.agentType,
      displayName: latest.displayName,
      tmuxWindow: created.tmuxWindow,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    if (createdWindowToCleanup) {
      try {
        killWakeWindow(createdWindowToCleanup)
      } catch (cleanupError) {
        logger.warn('session_wake_cleanup_failed', {
          sessionId,
          tmuxWindow: createdWindowToCleanup,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        })
      }
    }
    const message =
      error instanceof Error ? error.message : 'Unable to wake session'
    // Persist the failure reason so every tab sees an error badge via the
    // normal agent-sessions broadcast, not just the tab that triggered the
    // wake. Hibernating sessions stay in the Hibernating rail.
    recordWakeFailure(sessionId, message)
    logger.error('session_wake_failed', {
      sessionId,
      reason: 'create_window_failed',
      agentType: record.agentType,
      error: message,
    })
    const err: WakeError = { code: 'WAKE_FAILED', message }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error: err })
  } finally {
    wakeInFlight.delete(sessionId)
  }
}

function initializePersistentTerminal(ws: ServerWebSocket<WSData>) {
  if (ws.data.terminal) {
    return
  }

  const terminal = createPersistentTerminal(ws)
  ws.data.terminal = terminal

  void terminal.start().catch((error) => {
    if (ws.data.terminal !== terminal) return
    ws.data.terminal = null
    void terminal.dispose()
    clearAttachDedup(ws)
    handleTerminalError(ws, null, error, 'ERR_TMUX_ATTACH_FAILED')
  })
}

function createPersistentTerminal(ws: ServerWebSocket<WSData>) {
  const sessionName = `${config.tmuxSession}-ws-${ws.data.connectionId}`

  const terminal = createTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: config.tmuxSession,
    monitorTargets: config.terminalMonitorTargets,
    onGroupedSessionCreated: noteGroupedSessionCreated,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) {
        return
      }
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced (e.g. by SSH proxy)
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      ws.data.terminalAttachSeq += 1
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (sockets.has(ws)) {
        sendTerminalError(
          ws,
          sessionId,
          'ERR_TMUX_ATTACH_FAILED',
          'tmux client exited',
          true
        )
      }
    },
  })

  return terminal
}

function isTerminalAttachCurrent(ws: ServerWebSocket<WSData>, attachSeq: number): boolean {
  return ws.data.terminalAttachSeq === attachSeq
}

async function ensurePersistentTerminal(
  ws: ServerWebSocket<WSData>,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (!ws.data.terminal) {
    const created = createPersistentTerminal(ws)
    // If a newer attach/detach arrived while creating the proxy, dispose it.
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      await created.dispose()
      return null
    }
    ws.data.terminal = created
  }

  return startConnectionTerminal(ws, ws.data.terminal, attachSeq)
}

function startConnectionTerminal(
  ws: ServerWebSocket<WSData>, terminal: ITerminalProxy, attachSeq: number
): Promise<ITerminalProxy | null> {
  return startOwnedTerminal(terminal, {
    owns: () => ws.data.terminal === terminal,
    current: () => isTerminalAttachCurrent(ws, attachSeq),
    release: () => {
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
    },
  })
}

async function ensureCorrectProxyType(
  ws: ServerWebSocket<WSData>,
  session: Session,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  const needsSsh = session.remote === true && !!session.host
  const currentHost = ws.data.terminalHost

  // Same type — reuse existing proxy
  if (!needsSsh && !currentHost) {
    return ensurePersistentTerminal(ws, attachSeq)
  }
  if (needsSsh && currentHost === session.host) {
    if (ws.data.terminal) {
      return startConnectionTerminal(ws, ws.data.terminal, attachSeq)
    }
  }

  // Type mismatch — dispose old proxy and create new one
  if (ws.data.terminal) {
    const oldTerminal = ws.data.terminal
    // Clear references BEFORE dispose so the onExit guard sees the proxy was replaced
    // (dispose triggers process exit → onExit callback, which checks ws.data.terminal !== terminal)
    if (isTerminalAttachCurrent(ws, attachSeq) && ws.data.terminal === oldTerminal) {
      ws.data.terminal = null
      ws.data.terminalHost = null
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      clearAttachDedup(ws)
    }
    await oldTerminal.dispose()
  }

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (needsSsh) {
    return createAndStartSshProxy(ws, session.host!, attachSeq)
  } else {
    return ensurePersistentTerminal(ws, attachSeq)
  }
}

async function createAndStartSshProxy(
  ws: ServerWebSocket<WSData>,
  host: string,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  const sshOptions = remoteSshOptions(host)
  const sessionName = sshTerminalSessionName(config.tmuxSession, ws.data.connectionId, attachSeq)

  const terminal = new SshTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: '', // not used for SSH standalone sessions
    host,
    sshOptions,
    commandTimeoutMs: config.remoteTimeoutMs,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) return
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      ws.data.terminalAttachSeq += 1
      logger.warn('ssh_proxy_onExit', {
        sessionName,
        sessionId,
        host,
        connectionId: ws.data.connectionId,
      })
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (sockets.has(ws)) {
        sendTerminalError(ws, sessionId, 'ERR_TMUX_ATTACH_FAILED', 'SSH tmux client exited', true)
      }
    },
  })

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    await terminal.dispose()
    return null
  }

  ws.data.terminal = terminal
  ws.data.terminalHost = host

  return startConnectionTerminal(ws, terminal, attachSeq)
}

async function attachTerminalPersistent(
  ws: ServerWebSocket<WSData>,
  message: Extract<ClientMessage, { type: 'terminal-attach' }>,
  attachSeq: number
) {
  const { sessionId, tmuxTarget, cols, rows } = message

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (!isValidSessionId(sessionId)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid session id', false)
    }
    return
  }

  const session = registry.get(sessionId)
  if (!session) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Session not found', false)
    }
    return
  }
  if (ws.data.access.role === 'shared') {
    const current = boardAccess.grants.byId(ws.data.access.id)
    if (!current || !canUseSession(current, session)) return
    try {
      const live = await readTmuxCloseTarget(session)
      if (!isTerminalAttachCurrent(ws, attachSeq)) return
      if (!live || live.sessionIdentity !== session.remoteTmuxIdentity ||
          !canCloseLiveTmux(boardAccess.grants.byId(ws.data.access.id), session, live.sessionIdentity)) {
        sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Remote tmux session changed; refresh and attach again', false)
        return
      }
    } catch {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Could not verify tmux session', true)
      return
    }
  }
  if (session.remote && !config.remoteAllowAttach) {
    const host = session.host ? ` on ${session.host}` : ''
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', `Remote session${host} is read-only`, false)
    }
    return
  }
  stopClipboardBufferWatch(ws)

  const target = tmuxTarget ?? session.tmuxWindow
  if (!isValidTmuxTarget(target)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid tmux target', false)
    }
    return
  }

  const t0 = performance.now()

  let terminal: ITerminalProxy | null = null
  try {
    terminal = await ensureCorrectProxyType(ws, session, attachSeq)
    if (!terminal) return
  } catch (error) {
    if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ws, sessionId, error, 'ERR_TMUX_ATTACH_FAILED')
    }
    return
  }

  const tProxy = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (typeof cols === 'number' && typeof rows === 'number') {
    terminal.resize(cols, rows)
  }

  const effectiveTarget = terminal.ensureEffectiveTarget(target)

  // Deduplicate rapid re-attaches to the same session+target (e.g. two
  // terminal-attach messages arriving within ~34ms).  Skip the expensive
  // scrollback capture and just acknowledge readiness.
  const attachKey = `${sessionId}:${effectiveTarget}`
  const now = performance.now()

  if (ws.data.lastAttachKey === attachKey &&
      now - ws.data.lastAttachTs < config.attachDedupMs) {
    logger.debug('terminal_attach_dedup', {
      sessionId, target, effectiveTarget, attachSeq,
      elapsedMs: Math.round(now - ws.data.lastAttachTs),
      connectionId: ws.data.connectionId,
    })
    try {
      await terminal.switchTo(target)
      if (!isTerminalAttachCurrent(ws, attachSeq)) {
        return
      }
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = effectiveTarget
      startClipboardBufferWatch(ws, sessionId, session)
      send(ws, { type: 'terminal-ready', sessionId })
    } catch (error) {
      if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
        handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
      }
    }
    return
  }

  // Capture scrollback history BEFORE switching to avoid race with live output
  const history = session.remote && session.host
    ? await captureTmuxHistoryRemote(effectiveTarget, session.host)
    : await captureTmuxHistory(effectiveTarget)

  const tCapture = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  try {
    await terminal.switchTo(target, () => {
      if (!isTerminalAttachCurrent(ws, attachSeq)) return
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = effectiveTarget
      // Send history in chunks sized to fit TCP's initial congestion window
      // (~14.6KB). On high-latency connections (5G/Tailscale), the first chunk
      // arrives before slow start ramps up, letting the client render partial
      // content immediately instead of waiting for the full payload.
      if (history) {
        const HISTORY_CHUNK_SIZE = 12_000
        const tStr = performance.now()
        let totalBytes = 0
        let chunks = 0
        for (let offset = 0; offset < history.length; offset += HISTORY_CHUNK_SIZE) {
          const chunk = history.slice(offset, offset + HISTORY_CHUNK_SIZE)
          const payload = JSON.stringify({ type: 'terminal-output', sessionId, data: chunk })
          if (ws.data.access.role === 'shared') {
            const live = registry.get(sessionId)
            if (!live || live.remoteTmuxIdentity !== session.remoteTmuxIdentity) return
            send(ws, { type: 'terminal-output', sessionId, data: chunk })
          } else {
            ws.send(payload)
          }
          totalBytes += payload.length
          chunks += 1
        }
        const stringifyMs = Math.round(performance.now() - tStr)
        logger.debug('terminal_history_send', {
          sessionId,
          stringifyMs,
          payloadBytes: totalBytes,
          historyChars: history.length,
          chunks,
          connectionId: ws.data.connectionId,
        })
      }
    })
    // Yield to flush WebSocket buffers immediately after sending history.
    // Without this, Bun buffers the ws.send() data and doesn't flush until
    // the event loop is free — which can be seconds if other sync work follows.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const tSwitch = performance.now()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    ws.data.currentSessionId = sessionId
    ws.data.currentTmuxTarget = effectiveTarget
    // Record dedup key only after successful switch — prevents a second
    // attach from hitting the dedup fast-path while the first is still in flight.
    ws.data.lastAttachKey = attachKey
    ws.data.lastAttachTs = performance.now()
    startClipboardBufferWatch(ws, sessionId, session)
    logger.info('terminal_attach_profile', {
      sessionId,
      target,
      effectiveTarget,
      remote: !!session.remote,
      proxyMs: Math.round(tProxy - t0),
      captureMs: Math.round(tCapture - tProxy),
      switchMs: Math.round(tSwitch - tCapture),
      totalMs: Math.round(tSwitch - t0),
      historyBytes: history?.length ?? 0,
      connectionId: ws.data.connectionId,
    })
    send(ws, { type: 'terminal-ready', sessionId })
  } catch (error) {
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    logger.warn('terminal_switch_failed', {
      sessionId,
      target,
      effectiveTarget,
      error: error instanceof Error ? error.message : String(error),
      connectionId: ws.data.connectionId,
    })
    if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
    }
  }
}

async function captureTmuxHistory(target: string): Promise<string | null> {
  try {
    // Capture only the visible pane so initial attach paints the current view
    // immediately instead of replaying the entire scrollback buffer. Runs off
    // the event loop; the caller still awaits it before switching, so the
    // history predates any live output of this attach.
    const colorArgs = config.terminalColorsEnabled ? ['-e'] : []
    const result = await timedSpawnAsync(['tmux', ...withTmuxUtf8Flag([
      'capture-pane',
      '-t',
      target,
      '-p',
      '-J',
      ...colorArgs,
    ])], {
      timeout: config.tmuxTimeoutMs,
    })
    if (result.exitCode !== 0) {
      return null
    }
    const output = result.stdout
    // Only return if there's actual content
    if (output.trim().length === 0) {
      return null
    }
    return normalizeCapturedHistory(output)
  } catch {
    return null
  }
}

async function runRemoteTmux(host: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const remoteCmd = `tmux -u ${args.map(a => shellQuote(a)).join(' ')}`
  const opts = remoteSshOptions(host)
  const proc = Bun.spawn(['ssh', ...opts, host, remoteCmd], { stdout: 'pipe', stderr: 'pipe', env: sanitizedTmuxEnv() })

  const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 10_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout!).text(),
      new Response(proc.stderr!).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

function remoteImageWriteCommand(extension: string, size: number, verify = false): string {
  const commands = [
    'umask 077',
    'dir=$(mktemp -d /tmp/agentboard-image.XXXXXXXX) || exit 1',
    // In zsh, assigning to `path` also replaces the command search path.
    `image_path="$dir/screenshot.${extension}"`,
  ]
  if (verify) commands.push(`trap 'rm -f "$image_path"; rmdir "$dir"' EXIT`)
  commands.push(`cat > "$image_path" && [ "$(wc -c < "$image_path")" -eq ${size} ] || exit 1`)
  commands.push(verify ? 'cat "$image_path"' : 'printf "%s\\n" "$image_path"')
  return commands.join('; ')
}

async function checkRemoteImageUpload(host: string): Promise<'passed' | 'failed'> {
  const probe = 'agentboard\0image\n'
  try {
    const data = Buffer.from(probe)
    const result = await runRemoteSsh(host, remoteImageWriteCommand('png', data.length, true), data, 10_000)
    return result.exitCode === 0 && result.stdout === probe ? 'passed' : 'failed'
  } catch {
    return 'failed'
  }
}

async function runRemoteSsh(host: string, remoteCmd: string, stdin?: Buffer, timeoutMs = stdin ? 45_000 : 10_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const opts = remoteSshOptions(host)
  const proc = Bun.spawn(['ssh', ...opts, host, remoteCmd], { stdout: 'pipe', stderr: 'pipe', stdin, env: sanitizedTmuxEnv() })

  const timeout = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout!).text(),
      new Response(proc.stderr!).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

async function captureTmuxHistoryRemote(target: string, host: string): Promise<string | null> {
  try {
    const colorArgs = config.terminalColorsEnabled ? ['-e'] : []
    const result = await runRemoteTmux(host, [
      'capture-pane', '-t', target, '-p', '-J', ...colorArgs,
    ])
    if (result.exitCode !== 0) return null
    const output = result.stdout ?? ''
    if (output.trim().length === 0) return null
    return normalizeCapturedHistory(output)
  } catch {
    return null
  }
}

function detachTerminalPersistent(ws: ServerWebSocket<WSData>, sessionId: string) {
  // Cancel any in-flight attach/switch operations so stale completions don't
  // clobber the newly-selected session.
  ws.data.terminalAttachSeq += 1
  stopClipboardBufferWatch(ws)
  if (ws.data.currentSessionId === sessionId) {
    ws.data.currentSessionId = null
    ws.data.currentTmuxTarget = null
  }
  // Clear dedup so a fast A→B→A switch doesn't skip scrollback for A
  clearAttachDedup(ws)
}

function handleTerminalInputPersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  data: string
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  if (!session?.remote && containsClipboardArmingMouseInput(data)) {
    const now = Date.now()
    ws.data.clipboardBufferArmedUntil = now + CLIPBOARD_BUFFER_ARM_MS
    // No slack: we arm here BEFORE forwarding the input to tmux below, so any
    // buffer this gesture creates is stamped at/after this whole second. A
    // slack would instead let a pre-existing buffer created just before the
    // gesture be mis-offered as the user's copy.
    ws.data.clipboardArmedAtSec = Math.floor(now / 1000)
  }

  ws.data.terminal?.write(data)

  // On Enter key: immediately set "working" status and schedule refresh
  if (data.includes('\r') || data.includes('\n')) {
    if (!session?.remote) {
      setForceWorking(sessionId)
      scheduleEnterRefresh()
      scheduleLastUserMessageCapture(sessionId)
    }
  }
}

function handleTerminalPastePersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  data: string,
  pasteId?: number,
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  // Pasting stages text in the pane's input; it is NOT a submit, so unlike
  // terminal-input we deliberately skip the Enter/"working" status heuristics.
  const terminal = ws.data.terminal
  const attachSequence = ws.data.terminalAttachSeq
  const report = (ok: boolean) => {
    if (typeof pasteId === 'number' && ws.data.terminalAttachSeq === attachSequence) {
      send(ws, { type: 'terminal-paste-result', sessionId, pasteId, ok })
    }
  }
  try {
    void Promise.resolve(terminal?.paste(data))
      .then((result) => report(Boolean(terminal) && result !== false), () => report(false))
  } catch {
    report(false)
  }
}

function handleTerminalResizePersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  cols: number,
  rows: number
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  ws.data.terminal?.resize(cols, rows)
}


function sendTerminalError(
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  code: TerminalErrorCode,
  message: string,
  retryable: boolean
) {
  logger.warn('sending_terminal_error', {
    sessionId,
    code,
    message,
    retryable,
    connectionId: ws.data.connectionId,
  })
  send(ws, {
    type: 'terminal-error',
    sessionId,
    code,
    message,
    retryable,
  })
}

function handleTerminalError(
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  error: unknown,
  fallbackCode: TerminalErrorCode
) {
  if (error instanceof TerminalProxyError) {
    sendTerminalError(ws, sessionId, error.code, error.message, error.retryable)
    return
  }

  const message =
    error instanceof Error ? error.message : 'Terminal operation failed'
  sendTerminalError(ws, sessionId, fallbackCode, message, true)
}
