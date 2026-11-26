import { startOwnedTerminal, sshTerminalSessionName } from '../terminal/startOwnedTerminal'
import type { TerminalSession } from './protocol'
import { parseTmuxCloseTarget, TMUX_CLOSE_FORMAT } from '../tmuxClose'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
/** Terminal operations run in the lease worker, outside dashboard and peers. */
import { config } from '../config'
import { logger } from '../logger'
import { createTerminalProxy, SshTerminalProxy, TerminalProxyError } from '../terminal'
import type { ITerminalProxy, TerminalProxyOptions } from '../terminal'
import type { ClientMessage, TerminalErrorCode } from '../../shared/types'
import { isValidSessionId, isValidTmuxTarget } from '../validators'
import { armRelayClipboard, startRelayClipboard, stopRelayClipboard } from './terminalRuntimeClipboard'
import { cancelTerminalCopyMode, captureTerminalScreen, checkTerminalCopyMode, runTerminalTmux } from './terminalRuntimeCommands'
import { remoteSshOptions } from '../sshOptions'
import { matchesAttach, matchesTerminalIdentity, terminalIdentity, sendTerminal, type TerminalMessage, type TerminalPeer, type TerminalRuntimeOptions, type TerminalIdentity } from './terminalRuntimeTypes'
export { createTerminalPeerData } from './terminalRuntimeTypes'
export type { TerminalPeer, TerminalPeerData, TerminalRuntimeOptions } from './terminalRuntimeTypes'

const COMMANDS = new Set(['terminal-attach', 'terminal-detach', 'terminal-input', 'terminal-paste', 'terminal-resize', 'tmux-cancel-copy-mode', 'tmux-check-copy-mode'])

interface RemoteScreen {
  terminal: HeadlessTerminal
  serializer: SerializeAddon
  acceptsOutput: boolean
}

interface OpenRemoteTerminal {
  identity: TerminalIdentity
  proxy: ITerminalProxy
  screen: RemoteScreen
  started: Promise<void>
}

export class TerminalRuntime {
  private readonly clipboard: NonNullable<TerminalRuntimeOptions['clipboard']>
  private readonly remoteTerminals = new WeakMap<TerminalPeer, Map<string, OpenRemoteTerminal>>()
  private readonly pendingCopyMode = new WeakMap<TerminalPeer, Promise<void>>()

  constructor(private readonly options: TerminalRuntimeOptions) {
    this.clipboard = options.clipboard ?? { start: (peer, session) => startRelayClipboard(peer, session, options.getSession), stop: stopRelayClipboard, arm: armRelayClipboard }
  }

  /** The capability handshake owns transport establishment; PTY starts lazily. */
  open(_peer: TerminalPeer): void {}

  handle(peer: TerminalPeer, message: TerminalMessage): boolean {
    if (!COMMANDS.has(message.type)) return false
    if (message.type === 'terminal-attach') {
      const id = message.attachId
      if (id !== undefined && !(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) return true
      const sequence = ++peer.data.terminalAttachSeq
      peer.data.attachId = id
      peer.data.inputReady = false
      peer.data.currentSessionId = null
      peer.data.currentTmuxTarget = null
      peer.data.attachedIdentity = null
      this.clipboard.stop(peer)
      void this.attach(peer, message, sequence).catch(error => {
        if (this.current(peer, sequence)) this.error(peer, message.sessionId, error, 'ERR_TMUX_ATTACH_FAILED')
      })
      return true
    }
    if (!matchesAttach(peer, message)) return true
    if (message.type === 'terminal-detach') { this.suspend(peer); return true }
    if (!('sessionId' in message) || typeof message.sessionId !== 'string') return true
    const session = this.options.getSession(message.sessionId)
    if (!this.identityCurrent(peer, message.sessionId) || !session) return true
    if (message.type === 'tmux-check-copy-mode') {
      void (this.options.checkCopyMode ?? checkTerminalCopyMode)(peer, session, () => this.identityCurrent(peer, session.id)).catch(() => {})
      return true
    }
    if (!peer.data.inputReady || peer.data.currentSessionId !== message.sessionId) return true
    if (message.type === 'tmux-cancel-copy-mode') {
      const sequence = peer.data.terminalAttachSeq
      const pending = this.pendingCopyMode.get(peer) ?? Promise.resolve()
      this.trackCopyMode(peer, pending.then(async () => {
        if (this.current(peer, sequence) && this.identityCurrent(peer, session.id)) await (this.options.cancelCopyMode ?? cancelTerminalCopyMode)(peer, session)
      }))
    } else if (message.type === 'terminal-input' && typeof message.data === 'string') {
      this.afterCopyMode(peer, message, () => {
        if (!session.remote) this.clipboard.arm(peer, message.data)
        peer.data.terminal?.write(message.data)
        if (!session.remote && /[\r\n]/.test(message.data)) this.options.onSubmit?.(session.id)
      })
    } else if (message.type === 'terminal-paste' && typeof message.data === 'string') {
      // Paste is not a submit. Preserve bracketed-paste semantics in the proxy.
      const sequence = peer.data.terminalAttachSeq
      const { pasteId } = message
      this.afterCopyMode(peer, message, () => {
        const terminal = peer.data.terminal
        const report = (ok: boolean) => {
          if (typeof pasteId === 'number' && this.current(peer, sequence) && this.identityCurrent(peer, session.id)) {
            sendTerminal(peer, { type: 'terminal-paste-result', sessionId: session.id, pasteId, ok })
          }
        }
        try {
          void Promise.resolve(terminal?.paste(message.data))
            .then((result) => report(Boolean(terminal) && result !== false), () => report(false))
        } catch {
          report(false)
        }
      })
    } else if (message.type === 'terminal-resize' && this.dimensions(message.cols, message.rows)) {
      const remote = this.remoteTerminals.get(peer)?.get(session.id)
      if (remote) this.resizeRemote(remote, message)
      else peer.data.terminal?.resize(message.cols, message.rows)
    }
    return true
  }

  /** Invalidate all in-flight work while preserving the observer for reconnect. */
  suspend(peer: TerminalPeer): void {
    peer.data.terminalAttachSeq++
    peer.data.inputReady = false
    peer.data.currentSessionId = null
    peer.data.currentTmuxTarget = null
    peer.data.attachedIdentity = null
    this.clipboard.stop(peer)
    this.pendingCopyMode.delete(peer)
    this.releaseSize(peer, peer.data.terminal)
  }

  private releaseSize(peer: TerminalPeer, terminal: ITerminalProxy | null): void {
    void terminal?.setSizeParticipation?.(false).catch(error => {
      logger.warn('terminal_background_size_failed', { connectionId: peer.data.connectionId, error: String(error) })
    })
  }

  private trackCopyMode(peer: TerminalPeer, operation: Promise<void>): void {
    const pending = operation.catch(() => {})
    this.pendingCopyMode.set(peer, pending)
    void pending.then(() => { if (this.pendingCopyMode.get(peer) === pending) this.pendingCopyMode.delete(peer) })
  }

  private afterCopyMode(peer: TerminalPeer, message: TerminalMessage, action: () => void): void {
    const sequence = peer.data.terminalAttachSeq
    const session = 'sessionId' in message ? this.options.getSession(message.sessionId) : undefined
    const run = () => {
      if (!session) return
      if (!this.identityCurrent(peer, session.id)) return
      if (this.current(peer, sequence) && peer.data.inputReady && matchesAttach(peer, message)) action()
    }
    const pending = this.pendingCopyMode.get(peer)
    if (pending) this.trackCopyMode(peer, pending.then(run))
    else run()
  }

  async dispose(peer: TerminalPeer): Promise<void> {
    this.suspend(peer)
    const terminals = new Set<ITerminalProxy>()
    for (const remote of this.remoteTerminals.get(peer)?.values() ?? []) {
      remote.screen.acceptsOutput = false
      remote.screen.terminal.dispose()
      terminals.add(remote.proxy)
    }
    if (peer.data.terminal) terminals.add(peer.data.terminal)
    this.remoteTerminals.delete(peer)
    peer.data.terminal = null
    peer.data.terminalHost = null
    await Promise.allSettled([...terminals].map(terminal => terminal.dispose()))
  }

  private current(peer: TerminalPeer, sequence: number): boolean {
    return peer.readyState === 1 && peer.data.terminalAttachSeq === sequence
  }

  private identityCurrent(peer: TerminalPeer, sessionId: string): boolean {
    if (!peer.data.attachedIdentity || peer.data.attachedIdentity.sessionId !== sessionId) return false
    const latest = this.options.getSession(sessionId)
    if (matchesTerminalIdentity(peer.data.attachedIdentity, latest) && !(latest?.remote && !config.remoteAllowAttach)) return true
    if (peer.data.attachedIdentity !== null) {
      this.suspend(peer)
      this.invalid(peer, sessionId, 'TerminalSession changed; attach again')
    }
    return false
  }

  private dimensions(cols: unknown, rows: unknown): boolean {
    return typeof cols === 'number' && typeof rows === 'number' && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000
  }

  private makeProxy(peer: TerminalPeer, session: TerminalSession, screen?: RemoteScreen): ITerminalProxy {
    const host = session.remote ? session.host : undefined
    const options: TerminalProxyOptions = {
      connectionId: peer.data.connectionId,
      sessionName: host
        ? sshTerminalSessionName(config.tmuxSession, peer.data.connectionId, peer.data.terminalAttachSeq)
        : `${config.tmuxSession}-ws-${peer.data.connectionId}`,
      baseSession: host ? '' : config.tmuxSession,
      monitorTargets: config.terminalMonitorTargets,
      initialSizeParticipation: false,
      onGroupedSessionCreated: this.options.onGroupedSessionCreated,
      ...(host ? { host, sshOptions: remoteSshOptions(host), commandTimeoutMs: config.remoteTimeoutMs, isolateRemoteWindow: true } : {}),
      onData: data => {
        const publish = () => {
          if (peer.data.terminal !== terminal || !peer.data.currentSessionId) return
          if (!this.identityCurrent(peer, peer.data.currentSessionId)) return
          sendTerminal(peer, { type: 'terminal-output', sessionId: peer.data.currentSessionId, data })
        }
        if (!screen) publish()
        else if (screen.acceptsOutput) screen.terminal.write(data, publish)
      },
      onExit: () => {
        const active = peer.data.terminal === terminal
        const remote = this.remoteTerminals.get(peer)?.get(session.id)
        if (!active && remote?.proxy !== terminal) return
        const sessionId = peer.data.currentSessionId
        if (active) this.suspend(peer)
        this.forgetProxy(peer, terminal, remote?.proxy === terminal ? remote : undefined)
        void terminal.dispose().catch(() => {})
        if (active) this.error(peer, sessionId, new Error(host ? 'SSH tmux client exited' : 'tmux client exited'), 'ERR_TMUX_ATTACH_FAILED')
      },
    }
    const terminal = this.options.createProxy?.(options) ?? (host ? new SshTerminalProxy(options) : createTerminalProxy(options))
    return terminal
  }

  private forgetProxy(peer: TerminalPeer, terminal: ITerminalProxy, remote?: OpenRemoteTerminal): void {
    const cached = this.remoteTerminals.get(peer)
    if (remote && cached?.get(remote.identity.sessionId) === remote) {
      cached.delete(remote.identity.sessionId)
      remote.screen.acceptsOutput = false
      remote.screen.terminal.dispose()
    }
    if (peer.data.terminal === terminal) {
      peer.data.terminal = null
      peer.data.terminalHost = null
    }
  }

  /** Retire channels whose windows have disappeared or changed identity. */
  reconcileSessions(peer: TerminalPeer): void {
    for (const remote of this.remoteTerminals.get(peer)?.values() ?? []) {
      const latest = this.options.getSession(remote.identity.sessionId)
      if (matchesTerminalIdentity(remote.identity, latest)) continue
      if (peer.data.terminal === remote.proxy) {
        this.suspend(peer)
        this.invalid(peer, remote.identity.sessionId, 'TerminalSession changed; attach again')
      }
      this.forgetProxy(peer, remote.proxy, remote)
      void remote.proxy.dispose().catch(() => {})
    }
  }

  private async selectProxy(peer: TerminalPeer, terminal: ITerminalProxy): Promise<void> {
    const previous = peer.data.terminal
    if (!previous || previous === terminal) return
    const previousHost = peer.data.terminalHost
    peer.data.terminal = null
    peer.data.terminalHost = null
    if (previousHost) this.releaseSize(peer, previous)
    else await previous.dispose()
  }

  private async openRemoteTerminal(peer: TerminalPeer, session: TerminalSession, remote: OpenRemoteTerminal): Promise<void> {
    const { proxy, identity } = remote
    const ownsTerminal = () => this.remoteTerminals.get(peer)?.get(session.id) === remote
    if (!ownsTerminal()) return
    if (session.boardGrantId) {
      const live = await runTerminalTmux(['display-message', '-p', '-t', identity.target, TMUX_CLOSE_FORMAT], session.host)
      const current = live.exitCode === 0 && parseTmuxCloseTarget(live.stdout, identity.target)
      if (!current || current.sessionIdentity !== session.remoteTmuxIdentity) {
        throw new TerminalProxyError('ERR_INVALID_WINDOW', 'Remote tmux session changed; refresh and attach again', false)
      }
      if (!ownsTerminal()) return
    }
    await proxy.start()
    if (!ownsTerminal()) return
    const capture = this.options.capture ?? captureTerminalScreen
    const history = await capture(identity.target, session.host)
    if (!ownsTerminal()) return
    if (!matchesTerminalIdentity(identity, this.options.getSession(session.id))) {
      throw new TerminalProxyError('ERR_INVALID_WINDOW', 'TerminalSession changed while attaching', false)
    }
    const switched = await proxy.switchTo(identity.target, () => {
      if (!ownsTerminal()) return
      if (history) remote.screen.terminal.write(history)
      remote.screen.acceptsOutput = true
    })
    if (!switched && ownsTerminal()) {
      throw new TerminalProxyError('ERR_TMUX_SWITCH_FAILED', 'Could not open SSH terminal', true)
    }
  }

  private async attachRemote(
    peer: TerminalPeer,
    session: TerminalSession,
    message: Extract<ClientMessage, { type: 'terminal-attach' }>,
    sequence: number,
    started: number,
  ): Promise<void> {
    let cached = this.remoteTerminals.get(peer)
    if (!cached) {
      cached = new Map()
      this.remoteTerminals.set(peer, cached)
    }
    let remote = cached.get(session.id)
    if (remote && !matchesTerminalIdentity(remote.identity, session)) {
      this.forgetProxy(peer, remote.proxy, remote)
      void remote.proxy.dispose().catch(() => {})
      remote = undefined
    }
    const reused = remote?.screen.acceptsOutput === true && remote.proxy.isReady()
    if (!remote) {
      const terminal = new HeadlessTerminal({ allowProposedApi: true, scrollback: 0, logLevel: 'off' })
      const screen = { terminal, serializer: new SerializeAddon(), acceptsOutput: false }
      terminal.loadAddon(screen.serializer)
      const proxy = this.makeProxy(peer, session, screen)
      const started: Promise<void> = Promise.resolve().then(() => this.openRemoteTerminal(peer, session, opened)).catch(error => {
        this.forgetProxy(peer, proxy, opened)
        void proxy.dispose().catch(() => {})
        throw error
      })
      const opened: OpenRemoteTerminal = { identity: terminalIdentity(session), proxy, screen, started }
      cached.set(session.id, opened)
      if (this.dimensions(message.cols, message.rows)) {
        terminal.resize(message.cols!, message.rows!)
        proxy.resize(message.cols!, message.rows!)
      }
      // A newer switch can supersede this waiter before it starts awaiting.
      void opened.started.catch(() => {})
      remote = opened
    }
    const { proxy, identity, screen } = remote
    await this.selectProxy(peer, proxy)
    if (!this.current(peer, sequence)) return
    peer.data.terminal = proxy
    peer.data.terminalHost = session.host ?? null
    await remote.started
    if (!this.current(peer, sequence) || cached.get(session.id) !== remote) return
    this.resizeRemote(remote, message)
    // Updating the remote client's sizing can redraw the screen, but the
    // current PTY can already accept input and display its latest output.
    void proxy.setSizeParticipation?.(true).catch(error => {
      logger.warn('terminal_foreground_size_failed', { connectionId: peer.data.connectionId, error: String(error) })
    })
    // Queue the snapshot behind already received PTY writes. Subsequent writes
    // publish only after parsing, so they follow the snapshot on the wire.
    screen.terminal.write('', () => {
      if (!this.current(peer, sequence) || cached.get(session.id) !== remote) return
      if (!matchesTerminalIdentity(identity, this.options.getSession(session.id))) {
        this.reconcileSessions(peer)
        return
      }
      this.bind(peer, identity, identity.target, screen.serializer.serialize())
      this.ready(peer, session, started, reused)
    })
  }

  private resizeRemote(remote: OpenRemoteTerminal, { cols, rows }: { cols?: number; rows?: number }): void {
    if (!this.dimensions(cols, rows)) return
    const { terminal } = remote.screen
    if (terminal.cols === cols && terminal.rows === rows) return
    terminal.resize(cols!, rows!)
    remote.proxy.resize(cols!, rows!)
  }

  private async attach(peer: TerminalPeer, message: Extract<ClientMessage, { type: 'terminal-attach' }>, sequence: number): Promise<void> {
    const { sessionId, tmuxTarget, cols, rows } = message
    if (!this.current(peer, sequence)) return
    if (!isValidSessionId(sessionId)) { this.invalid(peer, sessionId, 'Invalid session id'); return }
    const found = this.options.getSession(sessionId)
    if (!found) { this.invalid(peer, sessionId, 'TerminalSession not found'); return }
    // Copy the catalog record before yielding: callers may replace or mutate it.
    const session = { ...found }
    const identity = terminalIdentity(session)
    if (session.remote && !config.remoteAllowAttach) { this.invalid(peer, sessionId, 'Remote session is read-only'); return }
    const target = tmuxTarget ?? session.tmuxWindow
    if (!isValidTmuxTarget(target)) { this.invalid(peer, sessionId, 'Invalid tmux target'); return }
    if (target !== session.tmuxWindow) { this.invalid(peer, sessionId, 'TerminalSession target changed'); return }
    const started = performance.now()
    if (session.remote && session.host) {
      await this.attachRemote(peer, session, message, sequence, started)
      return
    }
    if (peer.data.terminalHost) {
      this.releaseSize(peer, peer.data.terminal)
      peer.data.terminal = null
      peer.data.terminalHost = null
    }
    const local = peer.data.terminal ?? this.makeProxy(peer, session)
    peer.data.terminal = local
    const terminal = await startOwnedTerminal(local, {
      owns: () => peer.data.terminal === local,
      current: () => this.current(peer, sequence),
      release: () => this.forgetProxy(peer, local),
    })
    if (!terminal || !this.current(peer, sequence)) return
    if (this.dimensions(cols, rows)) terminal.resize(cols!, rows!)
    await terminal.setSizeParticipation?.(true)
    if (!this.current(peer, sequence)) return
    const effectiveTarget = terminal.ensureEffectiveTarget(target)
    const capture = this.options.capture ?? captureTerminalScreen
    const history = await capture(effectiveTarget)
    if (!this.current(peer, sequence)) return
    // Every resume and switch verifies physical target identity. A retained
    // proxy can have completed an obsolete switch after its owner disconnected.
    const switched = await terminal.switchTo(target, () => {
      if (!this.current(peer, sequence) || !matchesTerminalIdentity(identity, this.options.getSession(sessionId))) return
      this.bind(peer, identity, effectiveTarget, history)
    })
    if (!this.current(peer, sequence)) return
    if (!switched) {
      this.error(peer, sessionId, new Error('Terminal switch was superseded'), 'ERR_TMUX_SWITCH_FAILED')
      return
    }
    // The catalog could have removed the pane while asynchronous verification
    // ran. Refuse readiness; the next attach must resolve a current session.
    const latest = this.options.getSession(sessionId)
    if (!matchesTerminalIdentity(identity, latest)) {
      this.suspend(peer)
      this.invalid(peer, sessionId, 'TerminalSession changed while attaching')
      return
    }
    this.bind(peer, identity, effectiveTarget, null)
    this.ready(peer, session, started, false)
  }

  private bind(peer: TerminalPeer, identity: TerminalIdentity, target: string, screen: string | null): void {
    peer.data.currentSessionId = identity.sessionId
    peer.data.currentTmuxTarget = target
    peer.data.attachedIdentity = identity
    if (!screen) return
    for (let offset = 0; offset < screen.length; offset += 12_000) {
      sendTerminal(peer, { type: 'terminal-output', sessionId: identity.sessionId, data: screen.slice(offset, offset + 12_000) })
    }
  }

  private ready(peer: TerminalPeer, session: TerminalSession, started: number, reused: boolean): void {
    peer.data.inputReady = true
    this.clipboard.start(peer, session)
    sendTerminal(peer, { type: 'terminal-ready', sessionId: session.id })
    logger.info('terminal_attach_profile', {
      sessionId: session.id, target: session.tmuxWindow, effectiveTarget: peer.data.currentTmuxTarget,
      totalMs: Math.round(performance.now() - started), connectionId: peer.data.connectionId, relay: true, reused,
    })
  }

  private invalid(peer: TerminalPeer, sessionId: string, message: string): void {
    this.error(peer, sessionId, new TerminalProxyError('ERR_INVALID_WINDOW', message, false), 'ERR_INVALID_WINDOW')
  }

  private error(peer: TerminalPeer, sessionId: string | null, error: unknown, fallback: TerminalErrorCode): void {
    peer.data.inputReady = false
    sendTerminal(peer, {
      type: 'terminal-error', sessionId,
      code: error instanceof TerminalProxyError ? error.code : fallback,
      message: error instanceof Error ? error.message : 'Terminal operation failed',
      retryable: error instanceof TerminalProxyError ? error.retryable : true,
    })
  }
}
