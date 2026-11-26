const groupColors = new Set(['blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'gray'])

interface Group {
  id: string
  name: string
  color: string
  collapsed?: boolean
  sessionOrder?: string[]
}

export interface SessionOrganization {
  groups: Group[]
  sessions: Record<string, { title?: string; groupId?: string }>
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function parseSessionOrganization(value: unknown): SessionOrganization | undefined {
  if (!record(value) || !Array.isArray(value.groups) || !record(value.sessions)) return
  if (value.groups.length > 256 || Object.keys(value.sessions).length > 4096) return
  const groups: Group[] = []
  const groupIds = new Set<string>()
  for (const group of value.groups) {
    if (!record(group) || typeof group.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(group.id) ||
        groupIds.has(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 120 ||
        typeof group.color !== 'string' || !groupColors.has(group.color) ||
        (group.collapsed !== undefined && typeof group.collapsed !== 'boolean')) return
    const order = group.sessionOrder
    if (order !== undefined && (!Array.isArray(order) || order.length > 4096 ||
        order.some(id => typeof id !== 'string' || id.length > 512))) return
    groups.push({
      id: group.id, name: group.name.trim(), color: group.color, collapsed: group.collapsed,
      sessionOrder: order === undefined ? undefined : [...new Set<string>(order)],
    })
    groupIds.add(group.id)
  }
  const sessions: SessionOrganization['sessions'] = Object.create(null)
  for (const [id, entry] of Object.entries(value.sessions)) {
    if (!id || id.length > 512 || !record(entry) ||
        (entry.title !== undefined && (typeof entry.title !== 'string' || entry.title.length > 160)) ||
        (entry.groupId !== undefined && (typeof entry.groupId !== 'string' || !groupIds.has(entry.groupId)))) return
    const title = entry.title?.trim()
    if (title || entry.groupId) sessions[id] = { title: title || undefined, groupId: entry.groupId }
  }
  for (const group of groups) {
    if (group.sessionOrder) group.sessionOrder = group.sessionOrder.filter(id => sessions[id]?.groupId === group.id)
  }
  return { groups, sessions }
}
