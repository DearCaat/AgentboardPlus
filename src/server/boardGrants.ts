import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ClientMessage, ServerMessage, Session } from '../shared/types'

export type BoardAccess = { role: 'admin' } | { role: 'shared'; id: string; hosts: string[] }
export const administrator: BoardAccess = { role: 'admin' }

export interface AccessGrant {
  id: string
  label: string
  hosts: string[]
  createdAt: string
  revokedAt?: string
}
type StoredGrant = AccessGrant & { hash: string }

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export class BoardGrants {
  private records: StoredGrant[] = []

  constructor(private readonly file?: string) {
    this.reload()
  }

  reload() {
    if (!this.file) return
    try {
      const decoded: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(decoded) || decoded.some((entry) => !entry || typeof entry.id !== 'string' ||
        typeof entry.label !== 'string' || !Array.isArray(entry.hosts) ||
        entry.hosts.some((host: unknown) => typeof host !== 'string') ||
        typeof entry.createdAt !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash))) {
        throw new Error('Invalid AgentBoard access grant file')
      }
      this.records = decoded
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.records = []
    }
  }

  byId(id: string): BoardAccess | undefined {
    const grant = this.records.find((entry) => entry.id === id && !entry.revokedAt)
    if (grant) return { role: 'shared', id: grant.id, hosts: grant.hosts }
  }

  byToken(token: string): BoardAccess | undefined {
    if (!token.startsWith('ab_') || token.length !== 46) return
    const hash = Buffer.from(hashToken(token), 'hex')
    const grant = this.records.find((entry) => !entry.revokedAt &&
      timingSafeEqual(Buffer.from(entry.hash, 'hex'), hash))
    if (grant) return { role: 'shared', id: grant.id, hosts: grant.hosts }
  }

  list(): AccessGrant[] {
    return this.records.map(({ hash: _hash, ...entry }) => entry)
  }

  issue(label: string, hosts: string[]) {
    const token = 'ab_' + randomBytes(32).toString('base64url')
    const entry = { id: crypto.randomUUID(), label, hosts, createdAt: new Date().toISOString() }
    this.save([...this.records, { ...entry, hash: hashToken(token) }])
    return { grant: entry, token }
  }

  update(id: string, patch: Pick<AccessGrant, 'label' | 'hosts'> | { revokedAt: string }) {
    const grant = this.records.find((entry) => entry.id === id && !entry.revokedAt)
    if (!grant) return false
    this.save(this.records.map((entry) => entry.id === id ? { ...entry, ...patch } : entry))
    return true
  }

  private save(records: StoredGrant[]) {
    if (!this.file) throw new Error('Access grants require an administrator token')
    const temporary = this.file + '.new'
    writeFileSync(temporary, JSON.stringify(records), { mode: 0o600, flag: 'w' })
    renameSync(temporary, this.file)
    this.records = records
  }
}

type SessionHost = Pick<Session, 'host' | 'remote' | 'boardGrantId'>

export function canUseSession(access: BoardAccess, session: SessionHost) {
  return access.role === 'admin' || (session.remote === true && !!session.host && access.hosts.includes(session.host) && session.boardGrantId === access.id)
}

const terminalActions = new Set<ClientMessage['type']>([
  'terminal-attach', 'terminal-detach', 'terminal-input', 'terminal-paste', 'terminal-resize',
  'tmux-cancel-copy-mode', 'tmux-check-copy-mode', 'terminal-snapshot-request',
])

export function canSendBoardMessage(access: BoardAccess, message: ClientMessage, findSession: (id: string) => SessionHost | undefined) {
  if (access.role === 'admin') return true
  if (message.type === 'ping' || message.type === 'terminal-resume' || message.type === 'terminal-ack') return true
  if (!terminalActions.has(message.type) || !('sessionId' in message) || typeof message.sessionId !== 'string') return false
  const session = findSession(message.sessionId)
  return !!session && canUseSession(access, session)
}

export function visibleBoardMessage(access: BoardAccess, message: ServerMessage, findSession: (id: string) => SessionHost | undefined): ServerMessage | undefined {
  if (access.role === 'admin') return message
  switch (message.type) {
    case 'sessions': return { ...message, sessions: message.sessions.filter((entry) => canUseSession(access, entry)) }
    case 'host-status': return { ...message, hosts: message.hosts.filter((entry) => access.hosts.includes(entry.host)) }
    case 'server-config': return { ...message, remoteAllowControl: false, hostLabel: '' }
    case 'session-update':
    case 'session-created': return canUseSession(access, message.session) ? message : undefined
    case 'terminal-output':
    case 'terminal-ready':
    case 'terminal-paste-result':
    case 'terminal-error':
    case 'terminal-snapshot':
    case 'clipboard-offer':
    case 'tmux-copy-mode-status': {
      const session = message.sessionId ? findSession(message.sessionId) : undefined
      return session && canUseSession(access, session) ? message : undefined
    }
    case 'pong':
    case 'error': return message
  }
}

export function sharedHttpAllowed(method: string, path: string) {
  const isPreset = /^\/api\/workspace\/presets\/[0-9a-f-]+$/.test(path)
  if (method === 'PUT') return path === '/api/workspace/organization' || path === '/api/workspace/session-conversation' || isPreset
  if (method === 'DELETE') return isPreset
  if (method === 'POST') return path === '/api/workspace/terminals' || path === '/api/workspace/close-tmux' ||
    path === '/api/workspace/presets' || /^\/api\/workspace\/presets\/(?:[0-9a-f-]+|default)\/(?:load|restore|switch)$/.test(path)
  if (method !== 'GET' && method !== 'HEAD') return false
  return ['/','/index.html','/manifest.webmanifest','/sw.js','/api/health','/api/access',
    '/api/sessions','/api/workspace','/api/workspace/organization','/api/workspace/presets','/api/workspace/tmux-session','/api/server-info','/ws'].includes(path) ||
    /^\/(?:assets|icons)\/[a-zA-Z0-9_.-]+\.(?:js|css|png|svg|ico|woff2)$/.test(path) ||
    /^\/workbox-[a-zA-Z0-9]+\.js$/.test(path)
}
