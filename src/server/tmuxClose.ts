import { buildTmuxFormat, splitTmuxFields } from './tmuxFormat'

export function remoteTmuxIdentity(id: string, pid: string, created: string) {
  if (/^\$\d+$/.test(id) && /^\d+$/.test(pid) && /^\d+$/.test(created)) return [id, pid, created].join(':')
}

export const TMUX_CLOSE_FORMAT = buildTmuxFormat([
  '#{session_name}', '#{session_id}', '#{window_id}', '#{pid}', '#{session_created}', '#{session_windows}',
])

export function tmuxSessionName(target: string) {
  const separator = target.lastIndexOf(':')
  return separator > 0 ? target.slice(0, separator) : undefined
}

export function parseTmuxCloseTarget(output: string, target: string) {
  const fields = splitTmuxFields(output.trimEnd(), 6)
  if (!fields) return
  const [name, id, window, pid, created, windows] = fields
  const sessionIdentity = remoteTmuxIdentity(id, pid, created)
  if (name !== tmuxSessionName(target) || window !== target.slice(target.lastIndexOf(':') + 1) ||
      !sessionIdentity || !/^[1-9]\d*$/.test(windows)) return
  return { name, id, pid, created, windows: Number(windows), sessionIdentity, identity: sessionIdentity + ':' + windows }
}

export function closeTmuxArgs(target: NonNullable<ReturnType<typeof parseTmuxCloseTarget>>) {
  const guard = '#{&&:#{==:#{pid},' + target.pid + '},#{&&:#{==:#{session_created},' + target.created +
    '},#{==:#{session_windows},' + target.windows + '}}}'
  // Resolve against a session ID and recheck the server and session in the
  // same tmux command queue before executing the destructive command.
  return ['if-shell', '-F', '-t', target.id, guard,
    "kill-session -t '" + target.id + "'", "display-message -p 'stale'"]
}
