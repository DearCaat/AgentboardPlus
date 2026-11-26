import { create } from 'zustand'
import type { Session } from '@shared/types'

export const SESSION_GROUP_COLORS = [
  { id: 'blue', label: 'Blue', value: '#3b82f6' },
  { id: 'cyan', label: 'Cyan', value: '#06b6d4' },
  { id: 'green', label: 'Green', value: '#22c55e' },
  { id: 'yellow', label: 'Yellow', value: '#eab308' },
  { id: 'orange', label: 'Orange', value: '#f97316' },
  { id: 'red', label: 'Red', value: '#ef4444' },
  { id: 'pink', label: 'Pink', value: '#ec4899' },
  { id: 'purple', label: 'Purple', value: '#a855f7' },
  { id: 'gray', label: 'Gray', value: '#9ca3af' },
] as const

export type SessionGroupColor = (typeof SESSION_GROUP_COLORS)[number]['id']

export interface SessionGroup {
  id: string
  name: string
  color: SessionGroupColor
  collapsed?: boolean
  sessionOrder?: string[]
}

export interface SessionOrganizationEntry {
  title?: string
  groupId?: string
}

export interface SessionOrganization {
  groups: SessionGroup[]
  sessions: Record<string, SessionOrganizationEntry>
}

export interface WorkspaceView {
  organization: unknown
  workspace: { id: string; sessionIds: string[] | null }
  workspaces: Array<{ id: string; name: string }>
}

interface SessionOrganizationState {
  workspace: WorkspaceView['workspace']
  workspaces: WorkspaceView['workspaces']
  applyWorkspace: (view: WorkspaceView) => void
  switchWorkspace: (id: string) => Promise<void>
  addWorkspaceSession: (id: string) => void
  setWorkspaceOrder: (ids: string[]) => void
  profileId: string | null
  ready: boolean
  available: boolean
  error: string | null
  organization: SessionOrganization
  load: (profileId: string | null) => Promise<void>
  finishSaving: () => Promise<void>
  createGroup: () => string | null
  renameGroup: (groupId: string, name: string) => void
  setGroupColor: (groupId: string, color: SessionGroupColor) => void
  setGroupCollapsed: (groupId: string, collapsed: boolean) => void
  deleteGroup: (groupId: string) => void
  setSessionTitle: (sessionId: string, title: string | null) => void
  moveSession: (sessionId: string, groupId: string | null, sessionOrder?: string[]) => void
  moveGroup: (groupId: string, targetGroupId: string) => void
  setGroupSessionOrder: (groupId: string, sessionOrder: string[]) => void
}

const defaultWorkspace: WorkspaceView['workspace'] = { id: 'default', sessionIds: null }
const defaultWorkspaces = [{ id: 'default', name: 'Default' }]
const emptyOrganization = (): SessionOrganization => ({ groups: [], sessions: {} })
const validColors = new Set<string>(SESSION_GROUP_COLORS.map((color) => color.id))

export function normalizeSessionOrganization(value: unknown): SessionOrganization {
  if (!value || typeof value !== 'object') return emptyOrganization()

  const input = value as { groups?: unknown; sessions?: unknown }
  const groups: SessionGroup[] = []
  const groupIds = new Set<string>()

  if (Array.isArray(input.groups)) {
    for (const entry of input.groups) {
      if (!entry || typeof entry !== 'object') continue
      const candidate = entry as Record<string, unknown>
      if (
        typeof candidate.id !== 'string' ||
        !candidate.id.trim() ||
        groupIds.has(candidate.id) ||
        typeof candidate.name !== 'string' ||
        !validColors.has(String(candidate.color))
      ) {
        continue
      }
      groupIds.add(candidate.id)
      groups.push({
        id: candidate.id,
        name: candidate.name.trim() || 'New group',
        color: candidate.color as SessionGroupColor,
        ...(candidate.collapsed === true ? { collapsed: true } : {}),
        sessionOrder: Array.isArray(candidate.sessionOrder)
          ? [...new Set(candidate.sessionOrder.filter((id): id is string => typeof id === 'string'))]
          : undefined,
      })
    }
  }

  const sessions: Record<string, SessionOrganizationEntry> = {}
  if (input.sessions && typeof input.sessions === 'object' && !Array.isArray(input.sessions)) {
    for (const [sessionId, value] of Object.entries(input.sessions)) {
      if (!sessionId || !value || typeof value !== 'object') continue
      const candidate = value as Record<string, unknown>
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
      const groupId =
        typeof candidate.groupId === 'string' && groupIds.has(candidate.groupId)
          ? candidate.groupId
          : undefined
      if (title || groupId) {
        sessions[sessionId] = {
          ...(title ? { title } : {}),
          ...(groupId ? { groupId } : {}),
        }
      }
    }
  }

  for (const group of groups) {
    if (group.sessionOrder) group.sessionOrder = group.sessionOrder.filter(id => sessions[id]?.groupId === group.id)
  }
  return { groups, sessions }
}

export function getSessionDisplayName(
  session: Pick<Session, 'id' | 'name' | 'agentSessionName'>,
  organizationEntry?: SessionOrganizationEntry
): string {
  return (
    organizationEntry?.title?.trim() ||
    session.agentSessionName?.trim() ||
    session.name?.trim() ||
    session.id
  )
}

function createGroupId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `group-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

let loadGeneration = 0
let saveQueue: Promise<void> = Promise.resolve()

export const useSessionOrganizationStore = create<SessionOrganizationState>((set, get) => {
  const commit = (organization: SessionOrganization) => {
    const { profileId, workspace } = get()
    if (!profileId || !get().available) return
    set({ organization, error: null })
    const payload = JSON.stringify({ ...organization, workspaceSessionIds: workspace.sessionIds })
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        if (get().profileId !== profileId) return
        const response = await fetch('/api/workspace/organization', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-AgentBoard-Profile': profileId,
            'X-AgentBoard-Workspace': workspace.id,
          },
          body: payload,
        })
        if (!response.ok) throw new Error('Could not save session organization')
        if (get().profileId === profileId) set({ error: null })
      })
      .catch((error: unknown) => {
        if (get().profileId === profileId) {
          set({ error: error instanceof Error ? error.message : 'Could not save session organization' })
        }
      })
  }

  return {
    workspace: defaultWorkspace,
    workspaces: defaultWorkspaces,
    applyWorkspace: ({ organization, workspace, workspaces }) => {
      set({ organization: normalizeSessionOrganization(organization), workspace, workspaces, error: null })
    },
    switchWorkspace: async (id) => {
      const { profileId } = get()
      if (!profileId || id === get().workspace.id) return
      await saveQueue
      const response = await fetch('/api/workspace/presets/' + encodeURIComponent(id) + '/switch', {
        method: 'POST', headers: { 'X-AgentBoard-Profile': profileId },
      })
      if (!response.ok) throw new Error('Could not switch workspaces')
      const next: WorkspaceView = await response.json()
      if (get().profileId === profileId) get().applyWorkspace(next)
    },
    setWorkspaceOrder: (ids) => {
      const { workspace, organization } = get()
      if (!workspace.sessionIds) return
      const ordered = new Set(ids)
      const sessionIds = [...ids, ...workspace.sessionIds.filter(id => !ordered.has(id))]
      set({ workspace: { ...workspace, sessionIds } })
      commit(organization)
    },
    addWorkspaceSession: (id) => {
      const { workspace, organization } = get()
      if (!workspace.sessionIds || workspace.sessionIds.includes(id)) return
      set({ workspace: { ...workspace, sessionIds: [...workspace.sessionIds, id] } })
      commit(organization)
    },
    profileId: null,
    ready: false,
    available: false,
    error: null,
    organization: emptyOrganization(),
    load: async (profileId) => {
      const generation = ++loadGeneration
      set({
        profileId,
        ready: !profileId,
        available: false,
        error: null,
        organization: emptyOrganization(),
        workspace: defaultWorkspace,
        workspaces: defaultWorkspaces,
      })
      if (!profileId) return

      try {
        const response = await fetch('/api/workspace/organization', {
          cache: 'no-store',
          headers: { 'X-AgentBoard-Profile': profileId },
        })
        if (!response.ok) throw new Error('Could not load session organization')
        const data = await response.json()
        if (generation !== loadGeneration || get().profileId !== profileId) return
        set({
          organization: normalizeSessionOrganization(data), ready: true, available: true, error: null,
          workspace: data.workspace ?? defaultWorkspace, workspaces: data.workspaces ?? defaultWorkspaces,
        })
      } catch (error) {
        if (generation !== loadGeneration || get().profileId !== profileId) return
        set({
          ready: true,
          available: false,
          error: error instanceof Error ? error.message : 'Could not load session organization',
        })
      }
    },
    finishSaving: () => saveQueue,
    createGroup: () => {
      const state = get()
      if (!state.available) return null
      const id = createGroupId()
      const usedColors = new Set(state.organization.groups.map((group) => group.color))
      const color = SESSION_GROUP_COLORS.find((candidate) => !usedColors.has(candidate.id)) ??
        SESSION_GROUP_COLORS[state.organization.groups.length % SESSION_GROUP_COLORS.length]
      commit({
        ...state.organization,
        groups: [...state.organization.groups, { id, name: 'New group', color: color.id }],
      })
      return id
    },
    renameGroup: (groupId, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const state = get()
      commit({
        ...state.organization,
        groups: state.organization.groups.map((group) =>
          group.id === groupId ? { ...group, name: trimmed } : group
        ),
      })
    },
    setGroupColor: (groupId, color) => {
      const state = get()
      commit({
        ...state.organization,
        groups: state.organization.groups.map((group) =>
          group.id === groupId ? { ...group, color } : group
        ),
      })
    },
    setGroupCollapsed: (groupId, collapsed) => {
      const state = get()
      commit({
        ...state.organization,
        groups: state.organization.groups.map((group) =>
          group.id === groupId ? { ...group, collapsed } : group
        ),
      })
    },
    deleteGroup: (groupId) => {
      const state = get()
      const sessions: SessionOrganization['sessions'] = {}
      for (const [sessionId, entry] of Object.entries(state.organization.sessions)) {
        const next: SessionOrganizationEntry = entry.groupId === groupId
          ? { title: entry.title }
          : entry
        if (next.title || next.groupId) sessions[sessionId] = next
      }
      commit({
        groups: state.organization.groups.filter((group) => group.id !== groupId),
        sessions,
      })
    },
    setSessionTitle: (sessionId, title) => {
      const state = get()
      const previous = state.organization.sessions[sessionId] ?? {}
      const trimmed = title?.trim() ?? ''
      const nextEntry = { ...previous, ...(trimmed ? { title: trimmed } : {}) }
      if (!trimmed) delete nextEntry.title
      const sessions = { ...state.organization.sessions }
      if (nextEntry.title || nextEntry.groupId) sessions[sessionId] = nextEntry
      else delete sessions[sessionId]
      commit({ ...state.organization, sessions })
    },
    moveSession: (sessionId, groupId, sessionOrder) => {
      const state = get()
      const validGroupId = groupId && state.organization.groups.some((group) => group.id === groupId)
        ? groupId
        : undefined
      const previous = state.organization.sessions[sessionId] ?? {}
      const nextEntry = { ...previous, ...(validGroupId ? { groupId: validGroupId } : {}) }
      if (!validGroupId) delete nextEntry.groupId
      const sessions = { ...state.organization.sessions }
      if (nextEntry.title || nextEntry.groupId) sessions[sessionId] = nextEntry
      else delete sessions[sessionId]
      const groups = state.organization.groups.map(group => {
        if (group.id === validGroupId && sessionOrder) return { ...group, sessionOrder }
        if (group.id === previous.groupId && previous.groupId !== validGroupId && group.sessionOrder) {
          return { ...group, sessionOrder: group.sessionOrder.filter(id => id !== sessionId) }
        }
        return group
      })
      commit({ groups, sessions })
    },
    moveGroup: (groupId, targetGroupId) => {
      const { organization } = get()
      const from = organization.groups.findIndex(group => group.id === groupId)
      const to = organization.groups.findIndex(group => group.id === targetGroupId)
      if (from < 0 || to < 0 || from === to) return
      const groups = [...organization.groups]
      const [group] = groups.splice(from, 1)
      groups.splice(to, 0, group)
      commit({ ...organization, groups })
    },
    setGroupSessionOrder: (groupId, sessionOrder) => {
      const { organization } = get()
      commit({
        ...organization,
        groups: organization.groups.map(group =>
          group.id === groupId ? { ...group, sessionOrder } : group
        ),
      })
    },
  }
})
