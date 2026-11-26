import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { zhCN } from './messages.zh-CN'

export type Locale = 'en' | 'zh-CN'

interface LocaleState {
  locale: Locale
  setLocale: (locale: Locale) => void
}

function applyDocumentLang(locale: Locale) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

export const useLocale = create<LocaleState>()(
  persist(
    (set) => ({
      locale: 'en',
      setLocale: (locale) => {
        applyDocumentLang(locale)
        set({ locale })
      },
    }),
    {
      name: 'agentboard-language',
      version: 1,
      onRehydrateStorage: () => (state) => {
        if (state?.locale) {
          applyDocumentLang(state.locale)
        }
      },
    }
  )
)

export function translate(
  locale: Locale,
  message: string,
  values?: Record<string, string | number>
): string {
  const template = locale === 'zh-CN' ? (zhCN[message] ?? message) : message
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    values[key] !== undefined ? String(values[key]) : `{${key}}`
  )
}

const VERB_ZH: Record<string, string> = {
  rename: '重命名',
  kill: '终止',
  create: '创建',
  resume: '恢复',
  hibernate: '休眠',
}

const SERVER_PATTERNS: Array<[RegExp, (match: RegExpMatchArray, locale: Locale) => string]> = [
  [/^Name cannot exceed (\d+) characters$/, (m) => `名称不能超过 ${m[1]} 个字符`],
  [/^Tool pending:\s*(.+?)\s+\(\+(\d+) more\)$/, (m) => `等待工具：${m[1]}（另有 ${m[2]} 项）`],
  [/^Tool pending:\s*(.+?)\s+\+(\d+) more$/, (m) => `等待工具：${m[1]}（另有 ${m[2]} 项）`],
  [/^Tool pending:\s*(.+)$/, (m) => `等待工具：${m[1]}`],
  [/^No lifecycle signal for (\d+)m$/, (m) => `${m[1]} 分钟无状态信号`],
  [/^Failed to load preview \(HTTP (\d+)\)$/, (m) => `加载预览失败（HTTP ${m[1]}）`],
  [/^Failed to load transcript \(HTTP (\d+)\)$/, (m) => `加载对话记录失败（HTTP ${m[1]}）`],
  [/^A session named "(.+)" already exists$/, (m) => `已存在名为“${m[1]}”的会话`],
  [/^Project path does not exist:\s*(.+)$/, (m) => `项目路径不存在：${m[1]}`],
  [/^Session name must start with one of:\s*(.+)$/, (m) => `会话名称必须以以下前缀之一开头：${m[1]}`],
  [/^conflicts with (.+)$/, (m) => `与 ${m[1]} 冲突`],
  [/^File exceeds the (.+) limit$/, (m) => `文件超过 ${m[1]} 上限`],
  [/^hours must be a number between (\d+) and (\d+)$/, (m) => `小时数必须是 ${m[1]} 到 ${m[2]} 之间的数字`],
  [/^Invalid synced settings:\s*(.+)$/, (m, locale) => `同步设置无效：${translateServerMessage(locale, m[1])}`],
  [/^(.+) contains no image data\. Choose the file to upload it\.$/, (m) => `${m[1]} 不包含图片数据，请通过选择文件上传。`],
  [/^(.+) exceeds the (.+) limit$/, (m) => `${m[1]} 超过 ${m[2]} 上限`],
  [/^Could not upload (.+)\. Check your connection and try again\.$/, (m) => `无法上传 ${m[1]}，请检查网络连接后重试。`],
  [/^Could not upload (.+)\. Try again\.$/, (m) => `无法上传 ${m[1]}，请重试。`],
  [/^Preview server exited \(code (\d+)\)$/, (m) => `预览服务已退出（退出码 ${m[1]}）`],
  [/^Could not start preview:\s*(.+)$/, (m, locale) => `无法启动预览：${translateServerMessage(locale, m[1])}`],
  [/^Host "(.+)" not found$/, (m) => `未找到主机“${m[1]}”`],
  [/^Session not found:\s*(.+)$/, (m) => `未找到会话：${m[1]}`],
  [/^Invalid session ID:\s*(.+)$/, (m) => `无效的会话 ID：${m[1]}`],
  [
    /^Failed to (rename|kill|create|resume|hibernate) session:\s*(.+)$/,
    (m, locale) => `${VERB_ZH[m[1]] ?? m[1]}会话失败：${translateServerMessage(locale, m[2])}`,
  ],
  [/^Server returned (\d+)$/, (m) => `服务器返回错误（HTTP ${m[1]}）`],
  [/^Request failed \((\d+)\)$/, (m) => `请求失败（HTTP ${m[1]}）`],
  [
    /^([A-Z][A-Z0-9_]+):\s+(.+)$/,
    (m, locale) => {
      const translatedBody = translateServerMessage(locale, m[2])
      return translatedBody !== m[2] ? `${m[1]}: ${translatedBody}` : m[0]
    },
  ],
]

export function translateServerMessage(locale: Locale, message: string): string {
  if (!message || locale !== 'zh-CN') return message
  if (zhCN[message] !== undefined) return zhCN[message]
  const trimmed = message.trim()
  if (trimmed !== message && zhCN[trimmed] !== undefined) return zhCN[trimmed]
  for (const [pattern, formatter] of SERVER_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) return formatter(match, locale)
  }
  return message
}

export const translateServerError = translateServerMessage

export function translateActivityLabel(
  label: string,
  locale: Locale = useLocale.getState().locale
): string {
  return translateServerMessage(locale, label)
}

export function useTranslation() {
  const locale = useLocale((s) => s.locale)
  return (message: string, values?: Record<string, string | number>) =>
    translate(locale, message, values)
}

export function useServerTranslation() {
  const locale = useLocale((s) => s.locale)
  return (message: string) => translateServerMessage(locale, message)
}
