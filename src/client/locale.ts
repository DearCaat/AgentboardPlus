import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { safeStorage } from './utils/storage'
import { zhCN } from './messages.zh-CN'

export type Locale = 'en' | 'zh-CN'

export const useLocale = create<{ locale: Locale; setLocale: (locale: Locale) => void }>()(
  persist(
    set => ({ locale: 'en', setLocale: locale => set({ locale }) }),
    {
      name: 'agentboard-language',
      storage: createJSONStorage(() => safeStorage),
      merge: (stored, current) => ({
        ...current,
        locale: (stored as { locale?: unknown } | undefined)?.locale === 'zh-CN' ? 'zh-CN' : 'en',
      }),
    },
  ),
)

export function translate(locale: Locale, message: string, values?: Record<string, string | number>): string {
  const text = locale === 'zh-CN' && Object.hasOwn(zhCN, message) ? zhCN[message]! : message
  return values ? text.replace(/\{(\w+)\}/g, (key, name) => Object.hasOwn(values, name) ? String(values[name]) : key) : text
}

const translators = {
  en: translate.bind(null, 'en'),
  'zh-CN': translate.bind(null, 'zh-CN'),
}

export function useTranslation() {
  return useLocale(state => translators[state.locale] ?? translators.en)
}
