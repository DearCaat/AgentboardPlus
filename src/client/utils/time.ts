import { type Locale, translate, useLocale } from '../locale'

export function formatRelativeTime(
  iso: string,
  locale: Locale = useLocale.getState().locale
): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''

  const delta = Date.now() - timestamp
  const minutes = Math.floor(delta / 60000)
  if (delta < -60000) return ''
  if (minutes < 1) return translate(locale, 'now')
  if (minutes < 60) return translate(locale, '{count}m', { count: minutes })

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return translate(locale, '{count}h', { count: hours })

  const days = Math.floor(hours / 24)
  return translate(locale, '{count}d', { count: days })
}

export function formatRelativeAge(
  iso: string,
  locale: Locale = useLocale.getState().locale
): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''

  const delta = Date.now() - timestamp
  const minutes = Math.floor(delta / 60000)
  if (delta < -60000) return ''
  if (minutes < 1) return translate(locale, 'just now')

  const age = formatRelativeTime(iso, locale)
  return translate(locale, '{age} ago', { age })
}
