import type { Session } from '@shared/types'
import { translate, useLocale } from '../locale'
import type { ConnectionStatus } from '../stores/sessionStore'

export const statusText: Record<Session['status'], string> = {
  working: 'Working',
  waiting: 'Waiting',
  permission: 'Needs input',
  unknown: 'Unknown',
}

export const statusClass: Record<Session['status'], string> = {
  working: 'text-working',
  waiting: 'text-waiting',
  permission: 'text-approval',
  unknown: 'text-muted',
}

export type Translator = (
  message: string,
  values?: Record<string, string | number>
) => string

export function getStatusText(status: Session['status'], t?: Translator): string {
  const label = statusText[status] ?? statusText.unknown
  return t ? t(label) : translate(useLocale.getState().locale, label)
}

export const connectionStatusText: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
}

export function getConnectionStatusText(
  status: ConnectionStatus,
  t?: Translator
): string {
  const label = connectionStatusText[status] ?? status
  return t ? t(label) : translate(useLocale.getState().locale, label)
}
