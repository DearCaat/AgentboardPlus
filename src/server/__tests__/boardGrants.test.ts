import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardAccessGate } from '../boardAccess'
import { BoardGrants, canSendBoardMessage, canUseSession, sharedHttpAllowed, visibleBoardMessage } from '../boardGrants'

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('server-scoped board access', () => {
  test('stores only a digest, limits issued credentials to their hosts, and persists revocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentboard-grants-'))
    scratch.push(directory)
    const administratorFile = join(directory, 'administrator')
    const grantsFile = join(directory, 'grants.json')
    const administratorToken = randomBytes(32).toString('hex')
    writeFileSync(administratorFile, administratorToken, { mode: 0o600 })
    const gate = createBoardAccessGate(administratorFile, grantsFile)
    const { grant, token } = gate.grants.issue('Shared access', ['one'])
    const request = (value: string) => new Request('https://board.example/api/sessions', {
      headers: { Authorization: 'Bearer ' + value },
    })

    expect(statSync(grantsFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(grantsFile, 'utf8').includes(token)).toBe(false)
    expect(gate.grants.list()).toEqual([grant])
    expect(gate.identify(request(administratorToken))?.role).toBe('admin')

    const access = gate.identify(request(token))
    expect(access?.role).toBe('shared')
    expect(canUseSession(access!, { remote: true, host: 'one', boardGrantId: grant.id })).toBe(true)
    expect(canUseSession(access!, { remote: true, host: 'two', boardGrantId: grant.id })).toBe(false)
    expect(canUseSession(access!, { remote: false, host: 'one' })).toBe(false)

    expect(gate.grants.update(grant.id, { label: 'Shared access', hosts: ['two'] })).toBe(true)
    const newStore = new BoardGrants(grantsFile)
    expect(newStore.byToken(token)).toEqual({ role: 'shared', id: grant.id, hosts: ['two'] })
    expect(gate.grants.update(grant.id, { revokedAt: new Date().toISOString() })).toBe(true)
    newStore.reload()
    expect(newStore.byToken(token)).toBeUndefined()
    expect(gate.identify(request(token))).toBeUndefined()
  })

  test('requires a permitted session for terminal actions and rejects unrelated API routes', () => {
    const access = { role: 'shared' as const, id: 'guest', hosts: ['one'] }
    const allowed = { remote: true, host: 'one', boardGrantId: 'guest' }
    const blocked = { remote: true, host: 'one', boardGrantId: 'other' }
    const unassigned = { remote: true, host: 'one' }
    expect(canUseSession(access, unassigned)).toBe(false)
    expect(canUseSession({ role: 'admin' }, blocked)).toBe(true)
    expect(visibleBoardMessage(access, { type: 'terminal-ready', sessionId: 's' }, () => blocked)).toBeUndefined()
    expect(canSendBoardMessage(access, { type: 'terminal-attach', sessionId: 's' }, () => allowed)).toBe(true)
    expect(canSendBoardMessage(access, { type: 'terminal-attach', sessionId: 's' }, () => blocked)).toBe(false)
    expect(canSendBoardMessage(access, { type: 'session-kill', sessionId: 's' }, () => allowed)).toBe(false)
    expect(sharedHttpAllowed('GET', '/api/access/grants')).toBe(false)
    expect(sharedHttpAllowed('GET', '/api/directories')).toBe(false)
    expect(sharedHttpAllowed('GET', '/api/workspace/session-owner')).toBe(false)
    expect(sharedHttpAllowed('PUT', '/api/workspace/session-owner')).toBe(false)
    expect(sharedHttpAllowed('GET', '/api/workspace/organization')).toBe(true)
    expect(sharedHttpAllowed('PUT', '/api/workspace/organization')).toBe(true)
    expect(sharedHttpAllowed('POST', '/api/workspace/hosts')).toBe(false)
    expect(sharedHttpAllowed('POST', '/api/workspace/terminals')).toBe(true)
    expect(sharedHttpAllowed('GET', '/api/workspace/tmux-session')).toBe(true)
    expect(sharedHttpAllowed('POST', '/api/workspace/close-tmux')).toBe(true)
  })
})
