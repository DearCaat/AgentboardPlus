/** Discovery is partial until the index reports completion; existing rows remain usable. */
import type { MediaDiscovery } from '@shared/media'
import { useTranslation } from '../locale'

export default function MediaDiscoveryStatus({ discovery, kind, hasItems }: {
  discovery: MediaDiscovery; kind: 'media' | 'links' | 'previews'; hasItems: boolean
}) {
  const t = useTranslation()
  if (discovery.status !== 'pending' && discovery.status !== 'indexing') return null
  const percent = discovery.status === 'indexing' && discovery.bytesTotal > 0
    ? ` ${Math.min(99, Math.floor(discovery.bytesRead / discovery.bytesTotal * 100))}%` : ''
  return <p role="status" className="px-3 py-2 text-xs text-secondary">
    {t(hasItems ? 'Finding more {kind}…' : 'Finding {kind}…', { kind: t(kind) })}{percent}{hasItems ? t(' Results are partial.') : ''}
  </p>
}
