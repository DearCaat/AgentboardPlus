import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from './config'

export function remoteSshOptions(host: string, extra = splitSshOptions(config.remoteSshOpts)): string[] {
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', ...extra]
  const uid = process.getuid?.()
  if (uid === undefined || process.env.AGENTBOARD_REMOTE_SSH_MULTIPLEX === '0') return options

  // OpenSSH appends a suffix when binding the socket. Keep the path short and
  // require a directory that only the server's OS user can access.
  const directory = `/tmp/agentboard-ssh-${uid}`
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) return options
  } catch {
    return options
  }

  // %C covers the effective SSH endpoint and user. Keep aliases (including
  // different ProxyCommands), installations, and explicit options separated.
  const home = homedir()
  const sshConfig = [join(home, '.ssh', 'config'), '/etc/ssh/ssh_config']
  for (let index = 0; index < extra.length; index++) {
    const arg = extra[index]
    if (arg?.startsWith('-F')) {
      const path = arg.slice(2) || extra[++index]
      if (path) sshConfig.push(path)
    }
  }
  const configVersion = sshConfig.map(path => {
    try {
      const info = statSync(path)
      return [path, info.mtimeMs, info.size]
    } catch {
      return [path]
    }
  })
  const namespace = createHash('sha256')
    .update(JSON.stringify([config.dataDir, home, host, process.env.SSH_AUTH_SOCK, extra, configVersion]))
    .digest('hex').slice(0, 16)
  return [
    ...options,
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${directory}/${namespace}-%C`,
    '-o', 'ControlPersist=600',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
  ]
}

/**
 * Splits SSH options string, respecting quoted arguments.
 * Handles both single and double quotes.
 * Example: `-o "ProxyCommand ssh -W %h:%p bastion"` -> ['-o', 'ProxyCommand ssh -W %h:%p bastion']
 */
export function splitSshOptions(value: string): string[] {
  if (!value.trim()) return []
  const result: string[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null
      } else {
        current += char
      }
    } else if (char === '"' || char === "'") {
      inQuote = char
    } else if (/\s/.test(char)) {
      if (current) {
        result.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    result.push(current)
  }

  return result
}
