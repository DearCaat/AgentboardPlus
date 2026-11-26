/// <reference lib="webworker" />
/** Pull-request extraction has its own queue; media reads and discovery run elsewhere. */
import type { AgentSessionRecord } from './db'
import type { SessionPullRequest } from '../shared/types'
import type { MediaSummary } from '../shared/media'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import { pullRequestScanPlan, rescanPullRequests, getCachedPullRequests } from './agentSessions'
import { extractLastResponseTimestamp } from './logMatcher'
import { setCodexSubagentIndex } from './subagentLogs'

export interface SessionMetadata {
  prs: SessionPullRequest[]
  mediaSummary?: MediaSummary
  lastResponseAt?: string
}
export type MetadataRequest =
  | { kind: 'scan'; id: number; record: AgentSessionRecord }
  | { kind: 'index'; links: CodexSubagentLink[] }
  | { kind: 'shutdown' }
export type MetadataResponse = { id: number } & (
  | { metadata: Pick<SessionMetadata, 'prs' | 'lastResponseAt'> }
  | { error: string }
)

const ctx = self as DedicatedWorkerGlobalScope
ctx.onmessage = (event: MessageEvent<MetadataRequest>) => {
  const request = event.data
  if (request.kind === 'shutdown') { ctx.close(); return }
  if (request.kind === 'index') { setCodexSubagentIndex(request.links); return }
  try {
    // DB size can lag the file and does not detect same-size rewrites.
    const record = { ...request.record, lastKnownLogSize: null }
    rescanPullRequests(record, pullRequestScanPlan(record))
    const lastResponseAt = record.logFilePath ? extractLastResponseTimestamp(record.logFilePath, record.agentType) : undefined
    ctx.postMessage({ id: request.id, metadata: { prs: getCachedPullRequests(record), lastResponseAt } } satisfies MetadataResponse)
  } catch (error) {
    ctx.postMessage({ id: request.id, error: String(error) } satisfies MetadataResponse)
  }
}
