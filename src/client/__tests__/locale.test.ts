import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  translate,
  translateActivityLabel,
  translateServerMessage,
  useLocale,
} from '../locale'
import { zhCN } from '../messages.zh-CN'
import { formatRelativeAge, formatRelativeTime } from '../utils/time'
import {
  connectionStatusText,
  getConnectionStatusText,
  getStatusText,
  statusText,
} from '../utils/sessionStatus'
import { SESSION_GROUP_COLORS } from '../stores/sessionOrganizationStore'
import { SETTINGS_ROWS } from '../components/settings/registry'

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      walkTsFiles(full, out)
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      entry.name !== 'messages.zh-CN.ts' &&
      entry.name !== 'locale.ts'
    ) {
      out.push(full)
    }
  }
  return out
}

function unescapeStringLiteral(raw: string): string {
  return raw
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

describe('zh-CN locale coverage', () => {
  afterEach(() => {
    useLocale.setState({ locale: 'en' })
  })

  test('every static t() and translate() key under src/client exists and is non-empty in zhCN', () => {
    const clientDir = path.resolve(import.meta.dir, '..')
    const files = walkTsFiles(clientDir)
    const pattern = /(?<![A-Za-z0-9_])(?:t|translate)\s*\((?:\s*[^,\n]+,\s*)?(['"])((?:\\.|(?!\1).)*?)\1/g

    const missing: Array<{ file: string; key: string }> = []
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      for (const match of content.matchAll(pattern)) {
        const key = unescapeStringLiteral(match[2])
        if (!(key in zhCN) || zhCN[key].trim().length === 0) {
          missing.push({ file: path.relative(clientDir, file), key })
        }
      }
    }

    expect(missing).toEqual([])
  })

  test('dynamic UI tables and settings metadata are translated and no dead truncated keys remain', () => {
    expect('No settings match “' in zhCN).toBe(false)
    expect(zhCN['No settings match “{query}”']).toBeTruthy()

    for (const [key, value] of Object.entries(zhCN)) {
      expect(value.trim().length, `Empty translation for ${key}`).toBeGreaterThan(0)
    }

    for (const color of SESSION_GROUP_COLORS) {
      expect(zhCN[color.label]).toBeTruthy()
    }

    for (const label of Object.values(statusText)) {
      expect(zhCN[label]).toBeTruthy()
    }

    for (const label of Object.values(connectionStatusText)) {
      expect(zhCN[label]).toBeTruthy()
    }

    for (const shortcut of [
      'Session above',
      'Session below',
      'Select session 1–9',
      'New session',
      'Kill selected session',
      'Settings',
    ]) {
      expect(zhCN[shortcut]).toBeTruthy()
    }

    for (const row of SETTINGS_ROWS) {
      expect(zhCN[row.label], `Missing settings label: ${row.label}`).toBeTruthy()
      expect(
        zhCN[row.description],
        `Missing settings description: ${row.description}`
      ).toBeTruthy()
    }
  })

  test('formatRelativeTime and formatRelativeAge localize in en and zh-CN', () => {
    const now = Date.now()
    const nowIso = new Date(now - 10_000).toISOString()
    const fiveMinIso = new Date(now - 5 * 60_000).toISOString()
    const threeHrIso = new Date(now - 3 * 3_600_000).toISOString()
    const twoDayIso = new Date(now - 2 * 86_400_000).toISOString()
    const futureIso = new Date(now + 120_000).toISOString()

    expect(formatRelativeTime(nowIso, 'en')).toBe('now')
    expect(formatRelativeTime(fiveMinIso, 'en')).toBe('5m')
    expect(formatRelativeTime(threeHrIso, 'en')).toBe('3h')
    expect(formatRelativeTime(twoDayIso, 'en')).toBe('2d')
    expect(formatRelativeTime(futureIso, 'en')).toBe('')
    expect(formatRelativeTime('invalid', 'en')).toBe('')

    expect(formatRelativeTime(nowIso, 'zh-CN')).toBe('刚刚')
    expect(formatRelativeTime(fiveMinIso, 'zh-CN')).toBe('5 分钟')
    expect(formatRelativeTime(threeHrIso, 'zh-CN')).toBe('3 小时')
    expect(formatRelativeTime(twoDayIso, 'zh-CN')).toBe('2 天')

    expect(formatRelativeAge(nowIso, 'en')).toBe('just now')
    expect(formatRelativeAge(fiveMinIso, 'en')).toBe('5m ago')
    expect(formatRelativeAge(nowIso, 'zh-CN')).toBe('刚刚')
    expect(formatRelativeAge(fiveMinIso, 'zh-CN')).toBe('5 分钟前')

    useLocale.setState({ locale: 'zh-CN' })
    expect(formatRelativeTime(fiveMinIso)).toBe('5 分钟')
    expect(formatRelativeAge(fiveMinIso)).toBe('5 分钟前')
  })

  test('getStatusText and getConnectionStatusText localize in en and zh-CN', () => {
    const tEn = (msg: string, values?: Record<string, string | number>) =>
      translate('en', msg, values)
    const tZh = (msg: string, values?: Record<string, string | number>) =>
      translate('zh-CN', msg, values)

    expect(getStatusText('working', tEn)).toBe('Working')
    expect(getStatusText('waiting', tEn)).toBe('Waiting')
    expect(getStatusText('permission', tEn)).toBe('Needs input')
    expect(getStatusText('unknown', tEn)).toBe('Unknown')

    expect(getStatusText('working', tZh)).toBe('工作中')
    expect(getStatusText('waiting', tZh)).toBe('等待中')
    expect(getStatusText('permission', tZh)).toBe('等待输入')
    expect(getStatusText('unknown', tZh)).toBe('未知')

    expect(getConnectionStatusText('connected', tEn)).toBe('Connected')
    expect(getConnectionStatusText('connecting', tEn)).toBe('Connecting…')
    expect(getConnectionStatusText('reconnecting', tEn)).toBe('Reconnecting…')
    expect(getConnectionStatusText('disconnected', tEn)).toBe('Disconnected')

    expect(getConnectionStatusText('connected', tZh)).toBe('已连接')
    expect(getConnectionStatusText('connecting', tZh)).toBe('正在连接…')
    expect(getConnectionStatusText('reconnecting', tZh)).toBe('正在重连…')
    expect(getConnectionStatusText('disconnected', tZh)).toBe('已断开')
  })

  test('translateServerMessage and translateActivityLabel handle fixed, parameterized, and unknown messages', () => {
    expect(translateActivityLabel('Model turn active', 'en')).toBe('Model turn active')
    expect(translateActivityLabel('Model turn active', 'zh-CN')).toBe('模型正在生成回复')
    expect(translateActivityLabel('Turn finished', 'zh-CN')).toBe('本轮已完成')
    expect(translateActivityLabel('Activity unknown', 'zh-CN')).toBe('活动状态未知')
    expect(translateActivityLabel('Waiting for input', 'zh-CN')).toBe('等待输入')
    expect(translateActivityLabel('Waiting on tool or agents', 'zh-CN')).toBe('等待工具或子代理')
    expect(translateActivityLabel('No lifecycle signal for 15m', 'zh-CN')).toBe('15 分钟无状态信号')
    expect(translateActivityLabel('Interrupted', 'zh-CN')).toBe('已中断')
    expect(translateActivityLabel('Tool pending: Bash', 'zh-CN')).toBe('等待工具：Bash')
    expect(translateActivityLabel('Tool pending: Read, Edit (+2 more)', 'zh-CN')).toBe(
      '等待工具：Read, Edit（另有 2 项）'
    )
    expect(translateActivityLabel('Tool pending: Read, Edit +2 more', 'zh-CN')).toBe(
      '等待工具：Read, Edit（另有 2 项）'
    )

    expect(translateServerMessage('zh-CN', 'Name cannot exceed 120 characters')).toBe(
      '名称不能超过 120 个字符'
    )
    expect(translateServerMessage('zh-CN', 'conflicts with --full-auto')).toBe(
      '与 --full-auto 冲突'
    )
    expect(translateServerMessage('zh-CN', 'Preset not found')).toBe('未找到预设')
    expect(translateServerMessage('zh-CN', 'Failed to load preview (HTTP 502)')).toBe(
      '加载预览失败（HTTP 502）'
    )
    expect(translateServerMessage('zh-CN', 'SESSION_NOT_FOUND: Session not found')).toBe(
      'SESSION_NOT_FOUND: 未找到会话'
    )

    const rawStderr = 'ssh: connect to host example.internal port 22: Connection refused'
    expect(translateServerMessage('zh-CN', rawStderr)).toBe(rawStderr)
    expect(translateServerMessage('en', 'Preset not found')).toBe('Preset not found')
  })
})
