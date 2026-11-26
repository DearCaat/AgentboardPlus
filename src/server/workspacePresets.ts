import type { AgentType } from '../shared/types'
import type { SessionOrganization } from './sessionOrganization'

export const presetHarnesses = new Set<string>(['claude', 'claude-rp', 'codex', 'pi', 'devin', 'grok', 'omp', 'antigravity'])

export function validPresetConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
}

export interface PresetTerminal {
  id: string
  label: string
  host: string
  boardSessionId?: string
  tmuxName: string
  directory: string
  harness?: AgentType
  conversationId?: string
  logPath?: string
  binding: { id: string; identity: string; target: string }
}

export interface WorkspacePreset {
  id: string
  name: string
  organization: SessionOrganization
  terminals: PresetTerminal[]
}

export function remapPresetOrganization(organization: SessionOrganization, restoredIds: Map<string, string>): SessionOrganization {
  const id = (savedId: string) => restoredIds.get(savedId) ?? savedId
  return {
    groups: organization.groups.map(group => ({
      ...group,
      sessionOrder: group.sessionOrder?.map(id),
    })),
    sessions: Object.fromEntries(Object.entries(organization.sessions)
      .map(([savedId, entry]) => [id(savedId), entry])),
  }
}
