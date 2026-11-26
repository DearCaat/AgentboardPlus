import { expect, spyOn, test } from 'bun:test'
import { RemoteSessionPoller } from '../../remoteSessions'
import { TMUX_FIELD_SEPARATOR } from '../../tmuxFormat'
import type { HostStatus } from '../../../shared/types'

test('retains sessions across prolonged SSH failures until tmux confirms their removal', async () => {
  const host = 'test-remote-host'
  const sessionId = 'remote:test-remote-host:codex:@1'
  const row = [
    'codex', '0', '@1', 'codex', '/project', '1706745600', '1706745000',
    'codex', '$1', '1954', '1706744900',
  ].join(TMUX_FIELD_SEPARATOR)
  const bannerTimeout = 'Connection timed out during banner exchange'
  let result = { code: 0, stdout: row, stderr: '' }
  let now = Date.now()
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => {
    const command = args.at(-1)
    const response = command?.startsWith('tmux -u list-windows') ? result : { code: 0, stdout: '', stderr: '' }
    return {
      exited: Promise.resolve(response.code),
      stdout: response.stdout,
      stderr: response.stderr,
    }
  }) as unknown as typeof Bun.spawn)

  let onPoll: (statuses: HostStatus[]) => void
  const saved = new Map<string, { sessions: ReturnType<RemoteSessionPoller['getSessions']>; updatedAt: number }>()
  const options: ConstructorParameters<typeof RemoteSessionPoller>[0] = {
    hosts: [host],
    pollIntervalMs: 60_000,
    timeoutMs: 1000,
    staleAfterMs: 36_000,
    tmuxSessionPrefix: 'agentboard',
    discoverPrefixes: [],
    onUpdate: (statuses) => onPoll(statuses),
    loadSnapshot: (key) => saved.get(key),
    saveSnapshot: (key, snapshot) => saved.set(key, snapshot),
  }
  let poller = new RemoteSessionPoller(options)
  function poll(trigger: () => void): Promise<HostStatus> {
    return new Promise((resolve) => {
      onPoll = ([status]) => resolve(status)
      trigger()
    })
  }
  const nextPoll = () => poll(() => poller.hostAdded(host))

  try {
    expect(await poll(() => poller.start())).toMatchObject({ host, ok: true })
    expect(poller.getSessions().map(session => session.id)).toEqual([sessionId])

    result = { code: 255, stdout: '', stderr: bannerTimeout }
    now += 12_000
    expect(await nextPoll()).toMatchObject({ host, ok: false, error: bannerTimeout })
    expect(poller.getSessions().map(session => session.id)).toEqual([sessionId])

    now += 12_000
    await nextPoll()
    expect(poller.getSessions().map(session => session.id)).toEqual([sessionId])

    now += 12_001
    await nextPoll()
    expect(poller.getSessions().map(session => session.id)).toEqual([sessionId])
    expect(saved.get(host)?.sessions.map(session => session.id)).toEqual([sessionId])

    poller.stop()
    poller = new RemoteSessionPoller(options)
    expect(poller.getHostStatus(host)).toMatchObject({ host, ok: false })
    expect(await poll(() => poller.start())).toMatchObject({ host, ok: false })
    expect(poller.getSessions().map(session => session.id)).toEqual([sessionId])

    result = { code: 0, stdout: row, stderr: '' }
    expect(await nextPoll()).toMatchObject({ host, ok: true })
    expect(poller.getSessions().map(session => session.id)).toEqual([sessionId])

    result = { code: 1, stdout: '', stderr: 'no server running on /tmp/tmux/default' }
    expect(await nextPoll()).toMatchObject({ host, ok: true })
    expect(poller.getSessions()).toEqual([])
    expect(new RemoteSessionPoller(options).getSessions()).toEqual([])
  } finally {
    poller.stop()
    spawn.mockRestore()
    clock.mockRestore()
  }
})
