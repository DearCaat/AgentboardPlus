import { useState, useRef, useEffect, useCallback, useMemo, forwardRef, type ReactNode } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import {
  DndContext,
  closestCenter,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AgentSession, Session, SessionKillSource } from '@shared/types'
import { freezeListOrderDuringDrag, getSessionOrderKey, getUniqueHosts, getUniqueProjects, sortSessions } from '../utils/sessions'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { copyText } from '../utils/copyText'
import { composeSortableTransform } from '../utils/sortableTransform'
import { useSettingsStore, type SidebarAnchor } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import { useCounterBump } from '../hooks/useCounterBump'
import { useRemoteSessionId } from '../hooks/useRemoteSessionId'
import { useExitCleanup } from '../hooks/useExitCleanup'
import { useScrollToSelection } from '../hooks/useScrollToSelection'
import { useIsMobileLayout } from '../hooks/useMobileLayout'
import { useBottomPinnedScroll } from '../hooks/useBottomPinnedScroll'
import { useMenuViewportFit } from '../hooks/useMenuViewportFit'
import AgentIcon from './AgentIcon'
import SessionActivity from './SessionActivity'
import { ChevronDownIcon, ChevronRightIcon, Copy01Icon, DotsHorizontalIcon, Edit05Icon, File06Icon, HandIcon, Hash01Icon, Moon01Icon, PlusIcon, XCloseIcon } from './icons'
import { ICON_SIZE, MOBILE_ROW_TARGET_CLASS } from './controlStyles'
import {
  getSessionDisplayName,
  SESSION_GROUP_COLORS,
  useSessionOrganizationStore,
} from '../stores/sessionOrganizationStore'
import type { SessionGroup } from '../stores/sessionOrganizationStore'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import ProjectBadge from './ProjectBadge'
import HostBadge from './HostBadge'
import { PrChips } from './PrChips'
import SessionFilterButton from './SessionFilterButton'
import SessionSortButton from './SessionSortButton'
import SessionPreviewModal from './SessionPreviewModal'
import WorkspacePresets from './WorkspacePresets'
import { HibernatingSection, HistorySection } from './DormantSessionSections'
import { translateServerError, useLocale, useTranslation } from '../locale'

const groupDragId = (id: string) => 'group/' + id

const sessionListCollision: CollisionDetection = (args) => {
  const activeGroupId = args.active.data.current?.groupId
  if (activeGroupId) {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(container => container.data.current?.groupId),
    })
  }
  // Pointer hits allow rows to cross sections and land on empty or collapsed groups.
  const hits = pointerWithin(args)
  if (hits.length) return hits
  const activeSection = args.active.data.current?.sortable?.containerId
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(container =>
      !container.data.current?.groupId && container.data.current?.sortable?.containerId === activeSection
    ),
  })
}

interface SessionListProps {
  sessions: Session[]
  hibernatingSessions?: AgentSession[]
  historySessions?: AgentSession[]
  selectedSessionId: string | null
  selectedHibernatingSessionId?: string | null
  loading: boolean
  error: string | null
  onSelect: (sessionId: string) => void
  onSelectHibernating?: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onResume?: (sessionId: string) => void
  onHibernate?: (sessionId: string) => void
  onKill?: (sessionId: string, source?: SessionKillSource) => void
  onDuplicate?: (sessionId: string) => void
  onCloseTmux?: (session: Session) => void
  onMoveToHistory?: (sessionId: string) => void
  onNewSession?: () => void
  /** False while the list is off-screen (closed mobile drawer): defers
   * scroll-to-selection until it becomes visible again. */
  scrollSelectionActive?: boolean
  /** 'bottom' mirrors the column vertically (desktop only): sections and rows
   * render in reverse, the filter bar sticks to the bottom, and the list
   * stays pinned to its bottom edge. Sort order and indices are unchanged. */
  anchor?: SidebarAnchor
  /** Expose the anchor preference in the desktop sort menu only. */
  showAnchorControl?: boolean
  /** Global controls at the right end of the filter bar (desktop only;
   * the mobile drawer has its own header). */
  filterBarControls?: ReactNode
  /** Optional banner (e.g. session recovery) that belongs to the list region.
   * Top: directly under the filter bar, scrolling with the rows. Bottom: a
   * pinned row at the top of the column, since the first row must sit flush
   * on the filter bar. Never above the controls bar under Top. */
  notice?: ReactNode
}

/** Status pill classes for the time/activity badge */
const statusPillClass: Record<Session['status'], string> = {
  working: 'session-working-status',
  waiting: 'text-muted',
  permission: 'bg-approval/10 text-approval',
  unknown: 'text-muted',
}

function useTimestampRefresh() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30000)
    return () => clearInterval(id)
  }, [])
}

export default function SessionList({
  sessions,
  hibernatingSessions = [],
  historySessions = [],
  selectedSessionId,
  selectedHibernatingSessionId = null,
  loading,
  error,
  onSelect,
  onSelectHibernating,
  onRename,
  onResume,
  onHibernate,
  onKill,
  onDuplicate,
  onCloseTmux,
  onMoveToHistory,
  onNewSession,
  scrollSelectionActive = true,
  anchor = 'top',
  showAnchorControl = false,
  filterBarControls,
  notice,
}: SessionListProps) {
  const t = useTranslation()
  const locale = useLocale((s) => s.locale)
  const isBottom = anchor === 'bottom'
  const [openListMenu, setOpenListMenu] = useState<'filter' | 'sort' | null>(null)
  useTimestampRefresh()
  const isSafari = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  }, [])
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitleSessionId, setEditingTitleSessionId] = useState<string | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')
  const showHibernating = useSettingsStore((state) => state.hibernatingSessionsExpanded)
  const [previewSession, setPreviewSession] = useState<AgentSession | null>(null)
  const prefersReducedMotion = useReducedMotion()
  const useSafariLayoutFallback = isSafari && !prefersReducedMotion
  const dormantSessions = useMemo(
    () => [...hibernatingSessions, ...historySessions],
    [hibernatingSessions, historySessions]
  )

  // Animation sequencing constants (in ms)
  const EXIT_DURATION = 200

  // Counter bump animations
  const [activeCounterBump, clearActiveCounterBump] = useCounterBump(
    sessions.length,
    EXIT_DURATION
  )
  const [historyCounterBump, clearHistoryCounterBump] = useCounterBump(historySessions.length, EXIT_DURATION, true)

  // Track newly added sessions for entry animations
  const prevActiveIdsRef = useRef<Set<string>>(new Set(sessions.map((s) => s.id)))
  const prevDormantIdsForActiveRef = useRef<Set<string>>(
    new Set(
      [...hibernatingSessions, ...historySessions].map((session) => session.sessionId)
    )
  )
  const [newlyActiveIds, setNewlyActiveIds] = useState<Set<string>>(new Set())

  // Detect newly active sessions
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    const currentDormantIds = new Set(
      [...hibernatingSessions, ...historySessions].map((session) => session.sessionId)
    )
    const newIds = new Set<string>()
    for (const id of currentIds) {
      if (!prevActiveIdsRef.current.has(id)) {
        newIds.add(id)
      }
    }
    for (const session of sessions) {
      const agentId = session.agentSessionId?.trim()
      if (
        agentId &&
        prevDormantIdsForActiveRef.current.has(agentId) &&
        !currentDormantIds.has(agentId)
      ) {
        newIds.add(session.id)
      }
    }
    prevActiveIdsRef.current = currentIds
    prevDormantIdsForActiveRef.current = currentDormantIds

    if (newIds.size > 0) {
      setNewlyActiveIds(newIds)
    }
  }, [sessions, hibernatingSessions, historySessions])

  // Auto-clear newlyActiveIds after delay (separate effect to avoid timer bugs)
  useEffect(() => {
    if (newlyActiveIds.size === 0) return
    const timer = setTimeout(() => setNewlyActiveIds(new Set()), 500)
    return () => clearTimeout(timer)
  }, [newlyActiveIds])

  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))
  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const setSessionSortMode = useSettingsStore((state) => state.setSessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const manualSessionOrder = useSettingsStore((state) => state.manualSessionOrder)
  const setManualSessionOrder = useSettingsStore((state) => state.setManualSessionOrder)
  const showProjectName = useSettingsStore((state) => state.showProjectName)
  const showLastUserMessage = useSettingsStore(
    (state) => state.showLastUserMessage
  )
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )
  const projectFilters = useSettingsStore((state) => state.projectFilters)
  const setProjectFilters = useSettingsStore((state) => state.setProjectFilters)
  const hostFilters = useSettingsStore((state) => state.hostFilters)
  const setHostFilters = useSettingsStore((state) => state.setHostFilters)

  // Get exiting sessions from store (for kill-failed rollback only)
  const exitingSessions = useSessionStore((state) => state.exitingSessions)
  const clearExitingSession = useSessionStore((state) => state.clearExitingSession)
  const hostStatuses = useSessionStore((state) => state.hostStatuses)
  const remoteAllowControl = useSessionStore((state) => state.remoteAllowControl)
  const organization = useSessionOrganizationStore((state) => state.organization)
  const organizationAvailable = useSessionOrganizationStore((state) => state.available)
  const organizationProfileId = useSessionOrganizationStore((state) => state.profileId)
  const workspaceId = useSessionOrganizationStore(state => state.workspace.id)
  const workspaceOrder = useSessionOrganizationStore(state => state.workspace.id === 'default' ? null : state.workspace.sessionIds)
  const workspaces = useSessionOrganizationStore(state => state.workspaces)
  const switchWorkspace = useSessionOrganizationStore(state => state.switchWorkspace)
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false)
  const organizationError = useSessionOrganizationStore((state) => state.error)
  const createOrganizationGroup = useSessionOrganizationStore((state) => state.createGroup)
  const renameOrganizationGroup = useSessionOrganizationStore((state) => state.renameGroup)
  const setOrganizationGroupColor = useSessionOrganizationStore((state) => state.setGroupColor)
  const setOrganizationGroupCollapsed = useSessionOrganizationStore((state) => state.setGroupCollapsed)
  const deleteOrganizationGroup = useSessionOrganizationStore((state) => state.deleteGroup)
  const setOrganizationSessionTitle = useSessionOrganizationStore((state) => state.setSessionTitle)
  const setGroupSessionOrder = useSessionOrganizationStore((state) => state.setGroupSessionOrder)
  const moveOrganizationGroup = useSessionOrganizationStore((state) => state.moveGroup)
  const moveOrganizationSession = useSessionOrganizationStore((state) => state.moveSession)

  // Clean up exiting session state after animations
  useExitCleanup(sessions, exitingSessions, clearExitingSession, EXIT_DURATION)

  // Drag state: the active/over row ids plus a frozen snapshot of the list
  // order, captured at drag start. Live session updates must not reorder the
  // list under a held pointer (dnd-kit measures droppable rects against the
  // rendered order; mid-drag churn teleports rows and mis-targets drops).
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [dragOrderSnapshot, setDragOrderSnapshot] = useState<string[] | null>(null)
  const lastNonActiveOverIdRef = useRef<string | null>(null)

  // Keep the selected row visible when selection changes (keyboard nav,
  // auto-select after kill, persisted selection on reload). A hibernating
  // selection renders no row while its section is collapsed — skip scrolling.
  // Also skip while a drag is in progress: scrollIntoView would shift every
  // droppable rect mid-gesture.
  const listScrollRef = useRef<HTMLDivElement>(null)
  const listContentRef = useRef<HTMLDivElement>(null)
  // Must run before useScrollToSelection (layout effects run in order).
  const syncBottomPin = useBottomPinnedScroll(listScrollRef, listContentRef, isBottom)
  useScrollToSelection(
    listScrollRef,
    selectedSessionId ?? selectedHibernatingSessionId,
    (id) => id !== selectedHibernatingSessionId || showHibernating,
    scrollSelectionActive && !activeId,
    syncBottomPin
  )


  // Clean up manualSessionOrder when sessions are removed
  useEffect(() => {
    if (workspaceId !== 'default' || manualSessionOrder.length === 0) return
    const currentIds = new Set<string>()
    for (const session of sessions) {
      currentIds.add(getSessionOrderKey(session))
      currentIds.add(session.id)
    }
    for (const session of dormantSessions) {
      currentIds.add(session.sessionId)
    }
    const validOrder = manualSessionOrder.filter((id) => currentIds.has(id))
    if (validOrder.length !== manualSessionOrder.length) {
      setManualSessionOrder(validOrder)
    }
  }, [workspaceId, sessions, dormantSessions, manualSessionOrder, setManualSessionOrder])

  const sortedActive = useMemo(
    () =>
      workspaceOrder ? freezeListOrderDuringDrag(sessions, workspaceOrder) :
      sortSessions(sessions, {
        mode: sessionSortMode,
        direction: sessionSortDirection,
        manualOrder: manualSessionOrder,
      }),
    [sessions, workspaceOrder, sessionSortMode, sessionSortDirection, manualSessionOrder]
  )

  // Don't add exiting sessions back to the list - let AnimatePresence handle
  // the exit animation naturally. This prevents the 250ms delay before animation starts.
  const sortedSessions = sortedActive

  const uniqueProjects = useMemo(
    () => getUniqueProjects(sessions, dormantSessions),
    [sessions, dormantSessions]
  )

  const uniqueHosts = useMemo(() => {
    const sessionHosts = getUniqueHosts(sessions, dormantSessions)
    const statusHosts = hostStatuses.map((status) => status.host)
    const seen = new Set<string>()
    const merged: string[] = []

    for (const host of statusHosts) {
      if (!host || seen.has(host)) continue
      seen.add(host)
      merged.push(host)
    }

    for (const host of sessionHosts) {
      if (!host || seen.has(host)) continue
      seen.add(host)
      merged.push(host)
    }

    return merged
  }, [sessions, dormantSessions, hostStatuses])

  // Auto-show host info when multiple hosts are present
  const showHostInfo = useMemo(() => uniqueHosts.length > 1, [uniqueHosts])

  const hiddenSessions = useSettingsStore((state) => state.hiddenSessions)
  const setSessionHidden = useSettingsStore((state) => state.setSessionHidden)
  const [showHidden, setShowHidden] = useState(false)
  const hiddenCount = sortedSessions.filter((session) => hiddenSessions.includes(session.id)).length

  const filteredSessions = useMemo(() => {
    let next = showHidden ? sortedSessions : sortedSessions.filter((session) => !hiddenSessions.includes(session.id))
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [sortedSessions, projectFilters, hostFilters, hiddenSessions, showHidden])

  const filterKey = useMemo(
    () => {
      const projectKey = projectFilters.length === 0 ? 'all-projects' : projectFilters.join('|')
      const hostKey = hostFilters.length === 0 ? 'all-hosts' : hostFilters.join('|')
      return `${projectKey}::${hostKey}`
    },
    [projectFilters, hostFilters]
  )

  // Track sessions that became visible due to filter changes (for entry animation)
  const prevFilteredIdsRef = useRef<Set<string>>(new Set(filteredSessions.map((s) => s.id)))
  const [newlyFilteredInIds, setNewlyFilteredInIds] = useState<Set<string>>(new Set())

  // Detect sessions that became visible due to filter changes
  useEffect(() => {
    const currentFilteredIds = new Set(filteredSessions.map((s) => s.id))
    const newlyVisible = new Set<string>()

    // Find sessions that are now visible but weren't before
    for (const id of currentFilteredIds) {
      if (!prevFilteredIdsRef.current.has(id)) {
        // Only mark as "newly filtered in" if the session already existed (wasn't truly new)
        // This distinguishes filter changes from actual new sessions
        if (!newlyActiveIds.has(id)) {
          newlyVisible.add(id)
        }
      }
    }

    prevFilteredIdsRef.current = currentFilteredIds

    if (newlyVisible.size > 0) {
      setNewlyFilteredInIds(newlyVisible)
    }
  }, [filteredSessions, newlyActiveIds])

  // Auto-clear newlyFilteredInIds after delay (separate effect to avoid timer bugs)
  useEffect(() => {
    if (newlyFilteredInIds.size === 0) return
    const timer = setTimeout(() => setNewlyFilteredInIds(new Set()), 500)
    return () => clearTimeout(timer)
  }, [newlyFilteredInIds])

  const filteredHibernatingSessions = useMemo(() => {
    let next = hibernatingSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [hibernatingSessions, projectFilters, hostFilters])

  const filteredHistorySessions = useMemo(() => {
    let next = historySessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [historySessions, projectFilters, hostFilters])

  const hiddenPermissionCount = useMemo(() => {
    if (projectFilters.length === 0) return 0
    const filterSet = new Set(projectFilters)
    return sessions.filter(
      (session) =>
        !filterSet.has(session.projectPath) && session.status === 'permission'
    ).length
  }, [sessions, projectFilters])

  useEffect(() => {
    // Skip cleanup when no projects loaded yet (would clear persisted filters on initial load)
    if (projectFilters.length === 0 || uniqueProjects.length === 0) return
    const validProjects = new Set(uniqueProjects)
    const nextFilters = projectFilters.filter((project) => validProjects.has(project))
    if (nextFilters.length !== projectFilters.length) {
      setProjectFilters(nextFilters)
    }
  }, [projectFilters, uniqueProjects, setProjectFilters])

  useEffect(() => {
    if (hostFilters.length === 0 || uniqueHosts.length === 0) return
    const validHosts = new Set(uniqueHosts)
    const nextFilters = hostFilters.filter((host) => validHosts.has(host))
    if (nextFilters.length !== hostFilters.length) {
      setHostFilters(nextFilters)
    }
  }, [hostFilters, uniqueHosts, setHostFilters])

  // Drag-and-drop setup
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement to start drag (prevents accidental drags)
      },
    })
  )

  // On coarse pointers the card body must keep native panning — with the
  // dnd-kit listeners on the whole row, Safari claims the gesture for
  // scrolling and pointercancel kills every touch drag. Rows instead get a
  // dedicated touch-action:none handle that owns the activator listeners.
  const coarsePointer = useIsMobileLayout('(pointer: coarse)')

  const dragGroupId = activeId && organizationAvailable
    ? organization.sessions[activeId]?.groupId
    : undefined
  // Keep the snapshot confined to the section under the pointer.
  const displaySessions = useMemo(
    () => freezeListOrderDuringDrag(filteredSessions, dragGroupId ? null : dragOrderSnapshot),
    [filteredSessions, dragGroupId, dragOrderSnapshot]
  )

  // Stable items array for SortableContext: useSortable treats a new array
  // identity as "items changed" and disables the displacement transition for
  // that render — a fresh array on every dragOver re-render would pin
  // `transition: transform 0s` on rows, undoing the eased glide.
  // Under the bottom anchor rows draw in reverse (index 0 lowest). dnd-kit's
  // vertical strategy needs items in on-screen order, so both the rendered
  // rows and the sortable items use this visual order.
  const visualSessions = useMemo(
    () => (isBottom ? [...displaySessions].reverse() : displaySessions),
    [displaySessions, isBottom]
  )
  const organizationGroups = useMemo(() => organizationAvailable ? organization.groups : [], [organizationAvailable, organization.groups])
  const groupIds = useMemo(
    () => new Set(organizationGroups.map((group) => group.id)),
    [organizationGroups]
  )
  const groupSections = useMemo(() => {
    const orderedGroups = isBottom ? [...organizationGroups].reverse() : organizationGroups
    return orderedGroups.map((group) => {
      const members = filteredSessions.filter(session => organization.sessions[session.id]?.groupId === group.id)
      const order = group.id === dragGroupId ? dragOrderSnapshot ?? group.sessionOrder : group.sessionOrder
      const ordered = freezeListOrderDuringDrag(members, order ?? null)
      const sessions = isBottom ? [...ordered].reverse() : ordered
      return { group, sessions, items: sessions.map(session => session.id) }
    })
  }, [organizationGroups, isBottom, filteredSessions, organization.sessions, dragGroupId, dragOrderSnapshot])
  const hasOrganizationGroups = organizationGroups.length > 0
  const ungroupedSessions = useMemo(
    () => visualSessions.filter((session) => {
      const groupId = organization.sessions[session.id]?.groupId
      return !groupId || !groupIds.has(groupId)
    }),
    [visualSessions, organization.sessions, groupIds]
  )

  const groupItems = useMemo(() => groupSections.map(({ group }) => groupDragId(group.id)), [groupSections])
  const visualItems = useMemo(() => visualSessions.map(session => session.id), [visualSessions])
  const ungroupedItems = useMemo(() => ungroupedSessions.map(session => session.id), [ungroupedSessions])

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (event.active.data?.current?.groupId) return
      const id = event.active.id as string
      const section = groupSections.find(({ sessions }) => sessions.some(session => session.id === id))
      const ordered = section
        ? (isBottom ? [...section.items].reverse() : section.items)
        : filteredSessions.map(session => session.id)
      setActiveId(id)
      setDragOrderSnapshot(ordered)
      lastNonActiveOverIdRef.current = null
    },
    [filteredSessions, groupSections, isBottom]
  )

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const id = (event.over?.id as string | null) ?? null
    setOverId(id)
    // closestCenter reports the dragged row as `over` when the pointer sits
    // over its rect. Remember the last real target row so a drop on that
    // frame still commits to the slot the displaced rows were showing.
    if (id && id !== event.active.id) {
      lastNonActiveOverIdRef.current = id
    }
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      setOverId(null)
      setDragOrderSnapshot(null)

      const overId =
        over && over.id !== active.id
          ? (over.id as string)
          : over?.id === active.id
            ? lastNonActiveOverIdRef.current
            : null
      lastNonActiveOverIdRef.current = null
      if (!overId) {
        return
      }

      const draggedGroupId = active.data?.current?.groupId as string | undefined
      const targetHeader = groupSections.find(({ group }) => groupDragId(group.id) === overId)
      if (draggedGroupId) {
        if (targetHeader) moveOrganizationGroup(draggedGroupId, targetHeader.group.id)
        return
      }

      const sessionId = String(active.id)
      const orderKey = (session: Session) => workspaceOrder ? session.id : getSessionOrderKey(session)
      const saveOrder = (order: string[]) => {
        if (workspaceOrder) {
          useSessionOrganizationStore.getState().setWorkspaceOrder(order)
        } else {
          setSessionSortMode('manual')
          setManualSessionOrder(order)
        }
      }
      const activeGroup = organization.sessions[sessionId]?.groupId
      const targetGroup = targetHeader?.group.id ?? organization.sessions[overId]?.groupId
      if (organizationAvailable && activeGroup !== targetGroup) {
        const memberIds = sortedSessions.filter(session => organization.sessions[session.id]?.groupId === targetGroup)
          .map(session => session.id)
        if (targetGroup) {
          const target = groupSections.find(({ group }) => group.id === targetGroup)
          if (!target) return
          const order = [...new Set([...(target.group.sessionOrder ?? []), ...memberIds])]
          const position = targetHeader ? (isBottom ? 0 : order.length) : order.indexOf(overId)
          if (position < 0) return
          order.splice(position + (isBottom && !targetHeader ? 1 : 0), 0, sessionId)
          moveOrganizationSession(sessionId, targetGroup, order)
        } else {
          const session = sortedSessions.find(entry => entry.id === sessionId)
          const target = sortedSessions.find(entry => entry.id === overId)
          if (!session || !target) return
          const key = orderKey(session)
          const order = sortedSessions.map(orderKey).filter(entry => entry !== key)
          const position = order.indexOf(orderKey(target))
          if (position < 0) return
          order.splice(position + (isBottom ? 1 : 0), 0, key)
          moveOrganizationSession(sessionId, null)
          saveOrder(order)
        }
        return
      }

      const section = groupSections.find(({ group }) => group.id === activeGroup)
      if (section) {
        const visible = section.sessions.map(session => session.id)
        const from = visible.indexOf(String(active.id))
        const to = visible.indexOf(overId)
        if (from < 0 || to < 0 || from === to) return

        const reordered = arrayMove(visible, from, to)
        if (isBottom) reordered.reverse()
        const visibleSet = new Set(reordered)
        const fullOrder = new Set([
          ...(section.group.sessionOrder ?? []),
          ...sortedSessions.filter(session => organization.sessions[session.id]?.groupId === activeGroup)
            .map(session => session.id),
        ])
        // Keep filtered-out and temporarily unavailable sessions in their slots.
        let next = 0
        setGroupSessionOrder(section.group.id, [...fullOrder].map(id => visibleSet.has(id) ? reordered[next++] : id))
        return
      }

      // Indices come from the frozen order — the order the user actually saw
      // and aimed at — not the live order, which may have churned mid-drag.
      // They are looked up by id in the logical (unreversed) order: moving
      // `active` to `over`'s slot there is the same move as in the reversed
      // on-screen order, so the bottom anchor needs no translation.
      const visibleSessions = hasOrganizationGroups
        ? (isBottom ? [...ungroupedSessions].reverse() : ungroupedSessions)
        : displaySessions
      const oldIndex = visibleSessions.findIndex((s) => s.id === active.id)
      const newIndex = visibleSessions.findIndex((s) => s.id === overId)
      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      const reorderedVisible = visibleSessions.map(orderKey)
      const [removed] = reorderedVisible.splice(oldIndex, 1)
      reorderedVisible.splice(newIndex, 0, removed)

      const fullOrder = sortedSessions.map(orderKey)
      const visibleSet = new Set(reorderedVisible)
      let visibleIndex = 0
      const newOrder = fullOrder.map((id) => {
        if (!visibleSet.has(id)) return id
        const nextId = reorderedVisible[visibleIndex]
        visibleIndex += 1
        return nextId
      })

      saveOrder(newOrder)
    },
    [
      displaySessions,
      sortedSessions,
      organization.sessions,
      organizationAvailable,
      groupSections,
      hasOrganizationGroups,
      ungroupedSessions,
      isBottom,
      setGroupSessionOrder,
      moveOrganizationGroup,
      moveOrganizationSession,
      workspaceOrder,
      setSessionSortMode,
      setManualSessionOrder,
    ]
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    setDragOrderSnapshot(null)
    lastNonActiveOverIdRef.current = null
  }, [])

  useEffect(() => {
    if (!activeId && !overId) return
    const currentIds = new Set(filteredSessions.map((s) => s.id))
    if (activeId && !currentIds.has(activeId)) {
      setActiveId(null)
      setDragOrderSnapshot(null)
    }
    if (overId && !currentIds.has(overId)) {
      setOverId(null)
    }
  }, [filteredSessions, activeId, overId])

  const handleRename = (sessionId: string, newName: string) => {
    onRename(sessionId, newName)
    setEditingSessionId(null)
    setEditingTitleSessionId(null)
  }

  const handleCreateGroup = () => {
    const id = createOrganizationGroup()
    if (!id) return
    setEditingGroupId(id)
    setEditingGroupName(t('New group'))
  }

  const handleStartGroupRename = (group: SessionGroup) => {
    setEditingGroupId(group.id)
    setEditingGroupName(group.name)
  }

  const handleSubmitGroupRename = (groupId: string) => {
    renameOrganizationGroup(groupId, editingGroupName)
    setEditingGroupId(null)
  }

  const renderSessionRows = (
    rowSessions: Session[],
    items: string[],
    groupColor?: SessionGroup['color']
  ) => (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      <AnimatePresence initial={false} mode="sync">
        {rowSessions.map((session) => {
          const isTrulyNew = newlyActiveIds.has(session.id)
          const isFilteredIn = newlyFilteredInIds.has(session.id)
          const isRemote = session.remote === true
          const isManaged = session.source === 'managed'
          const canControl = !isRemote || (remoteAllowControl && isManaged)
          const canHibernate = Boolean(
            onHibernate &&
            !isRemote &&
            isManaged &&
            session.agentSessionId?.trim()
          )
          const activeIndex = activeId
            ? rowSessions.findIndex((item) => item.id === activeId)
            : -1
          const effectiveOverId =
            overId && overId !== activeId
              ? overId
              : overId === activeId
                ? lastNonActiveOverIdRef.current
                : null
          const isOver = activeId !== null && effectiveOverId === session.id
          const showDropIndicator = isOver
            ? activeIndex < 0 || activeIndex > rowSessions.findIndex((item) => item.id === session.id)
              ? 'above'
              : 'below'
            : null
          const isNew = (isTrulyNew || isFilteredIn) && !activeId
          const entry = organization.sessions[session.id]
          return (
            <SortableSessionItem
              key={session.id}
              session={session}
              displayName={getSessionDisplayName(session, entry)}
              titleOverride={entry?.title}
              groupColor={groupColor}
              groups={organizationGroups}
              assignedGroupId={entry?.groupId}
              isNew={isNew}
              exitDuration={EXIT_DURATION}
              prefersReducedMotion={prefersReducedMotion}
              useSafariLayoutFallback={useSafariLayoutFallback}
              isSelected={session.id === selectedSessionId}
              isEditing={session.id === editingSessionId}
              isEditingTitle={session.id === editingTitleSessionId}
              {...displayPrefs}
              showHostInfo={showHostInfo}
              dropIndicator={showDropIndicator}
              dragViaHandle={coarsePointer}
              onSelect={() => onSelect(session.id)}
              onStartEdit={canControl ? () => {
                setEditingTitleSessionId(null)
                setEditingSessionId(session.id)
              } : undefined}
              onStartEditTitle={organizationAvailable ? () => {
                setEditingSessionId(null)
                setEditingTitleSessionId(session.id)
              } : undefined}
              onCancelEdit={() => {
                setEditingSessionId(null)
                setEditingTitleSessionId(null)
              }}
              onRename={(newName) => handleRename(session.id, newName)}
              onSetDisplayName={organizationAvailable
                ? (title) => {
                    setOrganizationSessionTitle(session.id, title)
                    setEditingTitleSessionId(null)
                  }
                : undefined}
              onMoveToGroup={organizationAvailable && organizationGroups.length > 0
                ? (groupId) => moveOrganizationSession(session.id, groupId)
                : undefined}
              onHibernate={
                canHibernate
                  ? () => onHibernate?.(session.agentSessionId!.trim())
                  : undefined
              }
              onKill={
                onKill && canControl
                  ? () => onKill(session.id, 'session_list_context_menu')
                  : undefined
              }
              onDuplicate={onDuplicate && canControl ? () => onDuplicate(session.id) : undefined}
              onCloseTmux={onCloseTmux && session.source === 'external' ? () => onCloseTmux(session) : undefined}
              hiddenFromActive={hiddenSessions.includes(session.id)}
              onToggleHidden={() => setSessionHidden(session.id, !hiddenSessions.includes(session.id))}
            />
          )
        })}
      </AnimatePresence>
    </SortableContext>
  )

  const filterBar = (
    <div
      key="filter-bar"
      className={`session-toolbar sticky z-10 flex h-[40px] items-center gap-2 bg-elevated px-3 ${
        // shrink-0: under bottom the bar is a flex item of the scroll column
        isBottom ? 'bottom-0 shrink-0 border-t border-border' : 'top-0 border-b border-border'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 [@media(pointer:coarse)]:gap-[22px]">
        <SessionFilterButton
          open={openListMenu === 'filter'}
          onOpenChange={(open) => setOpenListMenu(open ? 'filter' : null)}
          projects={uniqueProjects}
          selectedProjects={projectFilters}
          onSelectProjects={setProjectFilters}
          hosts={uniqueHosts}
          selectedHosts={hostFilters}
          onSelectHosts={setHostFilters}
          hostStatuses={hostStatuses}
          showHosts={showHostInfo}
          hasHiddenPermissions={hiddenPermissionCount > 0}
          placement={isBottom ? 'up' : 'down'}
        />
        <SessionSortButton
          showAnchorControl={showAnchorControl}
          open={openListMenu === 'sort'}
          onOpenChange={(open) => setOpenListMenu(open ? 'sort' : null)}
          placement={isBottom ? 'up' : 'down'}
        />
      </div>
      {filterBarControls}
    </div>
  )

  const displayPrefs = { showSessionIdPrefix, showProjectName, showLastUserMessage }

  const activeSection = loading ? (
    <div className="space-y-1 p-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded bg-surface"
        />
      ))}
    </div>
  ) : (
    <>
      <div className="flex items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted">
        {workspaces.length > 1 ? (
          <select aria-label={t('Workspace')} value={workspaceId} disabled={switchingWorkspace}
            className="input min-w-0 max-w-[45%] truncate text-xs normal-case"
            onChange={event => {
              setSwitchingWorkspace(true)
              void switchWorkspace(event.target.value).catch(error =>
                useSessionOrganizationStore.setState({ error: error.message })
              ).finally(() => setSwitchingWorkspace(false))
            }}>
            {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.id === 'default' && workspace.name === 'Default' ? t('Default') : workspace.name}</option>)}
          </select>
        ) : <span>{t('Active')}</span>}
        <div className="flex items-center gap-2">
          {organizationAvailable && (
            <button
              type="button"
              onClick={handleCreateGroup}
              aria-label={t('Create session group')}
              title={t('Create session group')}
              className="flex min-h-[32px] items-center gap-1 rounded px-1.5 text-[11px] normal-case tracking-normal text-secondary hover:bg-hover hover:text-primary max-md:min-h-[36px]"
            >
              <PlusIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Group')}
            </button>
          )}
          {organizationAvailable && organizationProfileId && (
            <button type="button" onClick={() => setPresetsOpen(true)}
              className="min-h-8 rounded px-1.5 text-[11px] normal-case tracking-normal text-secondary hover:bg-hover hover:text-primary">
              {t('Presets')}
            </button>
          )}
          {organizationProfileId && organizationError && (
            <span
              role="status"
              title={translateServerError(locale, organizationError)}
              className="max-w-28 truncate text-[10px] normal-case tracking-normal text-danger"
            >
              {t('Workspace error')}
            </span>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowHidden((visible) => !visible)}
              aria-pressed={showHidden}
              className="rounded px-1.5 py-0.5 text-[11px] normal-case tracking-normal hover:bg-hover"
            >
              {showHidden ? t('Hide hidden') : t('Show hidden ({count})', { count: hiddenCount })}
            </button>
          )}
          {filteredSessions.length === 0 && onNewSession && (
            <button
              type="button"
              onClick={onNewSession}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-accent hover:bg-hover"
              title={t('Start a new session ({shortcut})', { shortcut: `${modDisplay}N` })}
            >
              <PlusIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('New session')}
            </button>
          )}
          <motion.span
            className="w-8 text-right text-xs"
            animate={activeCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
            transition={{ duration: 0.3 }}
            onAnimationComplete={clearActiveCounterBump}
          >
            {filteredSessions.length}
          </motion.span>
        </div>
      </div>
      {(filteredSessions.length > 0 || hasOrganizationGroups) && (
        <DndContext
          sensors={sensors}
          collisionDetection={sessionListCollision}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div key={workspaceId + ":" + filterKey}>
            {hasOrganizationGroups ? (
              <>
                <SortableContext items={groupItems} strategy={verticalListSortingStrategy}>
                  {groupSections.map(({ group, sessions: groupSessions, items }) => (
                    <section key={group.id} data-testid="session-group">
                      <SessionGroupHeader
                        group={group}
                        count={groupSessions.length}
                        anchor={anchor}
                        isEditing={editingGroupId === group.id}
                        editingName={editingGroupName}
                        onEditingNameChange={setEditingGroupName}
                        onSubmitRename={() => handleSubmitGroupRename(group.id)}
                        onCancelRename={() => setEditingGroupId(null)}
                        onStartRename={() => handleStartGroupRename(group)}
                        onToggle={() => setOrganizationGroupCollapsed(group.id, !group.collapsed)}
                        onSetColor={(color) => setOrganizationGroupColor(group.id, color)}
                        onDelete={() => {
                          deleteOrganizationGroup(group.id)
                          if (editingGroupId === group.id) setEditingGroupId(null)
                        }}
                      />
                      {!group.collapsed && renderSessionRows(groupSessions, items, group.color)}
                    </section>
                  ))}
                </SortableContext>
                {ungroupedSessions.length > 0 && (
                  <section data-testid="ungrouped-sessions">
                    <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                      <span>{t('Ungrouped')}</span>
                      <span>{ungroupedSessions.length}</span>
                    </div>
                    {renderSessionRows(ungroupedSessions, ungroupedItems)}
                  </section>
                )}
              </>
            ) : (
              renderSessionRows(visualSessions, visualItems)
            )}
          </div>
        </DndContext>
      )}
    </>
  )

  const hibernatingSection = !loading && (
    <HibernatingSection
      anchor={anchor}
      sessions={filteredHibernatingSessions}
      selectedSessionId={selectedHibernatingSessionId}
      {...displayPrefs}
      onSelect={onSelectHibernating}
      onWake={onResume}
      onRename={handleRename}
      onMoveToHistory={onMoveToHistory}
    />
  )

  const historySection = (
    <HistorySection
      anchor={anchor}
      sessions={filteredHistorySessions}
      counterBump={historyCounterBump}
      onCounterBumpComplete={clearHistoryCounterBump}
      prefersReducedMotion={prefersReducedMotion}
      {...displayPrefs}
      onResume={onResume}
      onPreview={setPreviewSession}
    />
  )

  return (
    <aside className="session-sidebar flex min-h-0 flex-1 flex-col border-r border-border bg-elevated">
      {error && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {translateServerError(locale, error)}
        </div>
      )}

      {isBottom && notice && <div className="shrink-0">{notice}</div>}

      {isBottom ? (
        // Mirrored: rows stack from the bottom edge (mt-auto spacer, not
        // justify-end, which would make overflow unreachable); scroll-pb-[40px]
        // keeps selected rows clear of the sticky bottom filter bar.
        // Native scroll anchoring would preserve a moving row during status
        // sorts, fighting useBottomPinnedScroll and disarming its bottom pin.
        <div
          ref={listScrollRef}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain scroll-pb-[40px] [overflow-anchor:none]"
        >
          <div ref={listContentRef} className="mt-auto shrink-0">
            {historySection}
            {hibernatingSection}
            {activeSection}
          </div>
          {filterBar}
        </div>
      ) : (
        // scroll-pt-[40px] keeps rows scrolled past the sticky h-10 filter bar
        <div
          ref={listScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain scroll-pt-[40px]"
        >
          {filterBar}
          {notice}
          {activeSection}
          {hibernatingSection}
          {historySection}
        </div>
      )}

      {previewSession && (
        <SessionPreviewModal
          session={previewSession}
          onClose={() => setPreviewSession(null)}
          onResume={(sessionId) => {
            setPreviewSession(null)
            onResume?.(sessionId)
          }}
        />
      )}
      {presetsOpen && organizationProfileId && (
        <WorkspacePresets profileId={organizationProfileId} sessions={sortedSessions} onClose={() => setPresetsOpen(false)} />
      )}
    </aside>
  )
}

interface SessionGroupHeaderProps {
  group: SessionGroup
  count: number
  anchor: SidebarAnchor
  isEditing: boolean
  editingName: string
  onEditingNameChange: (name: string) => void
  onSubmitRename: () => void
  onCancelRename: () => void
  onStartRename: () => void
  onToggle: () => void
  onSetColor: (color: SessionGroup['color']) => void
  onDelete: () => void
}

function SessionGroupHeader({
  group,
  count,
  anchor,
  isEditing,
  editingName,
  onEditingNameChange,
  onSubmitRename,
  onCancelRename,
  onStartRename,
  onToggle,
  onSetColor,
  onDelete,
}: SessionGroupHeaderProps) {
  const t = useTranslation()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging, isOver } = useSortable({
    id: groupDragId(group.id),
    data: { groupId: group.id },
  })
  const [menu, setMenu] = useState<{ x: number; y: number; opensAbove: boolean } | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameFinishedRef = useRef(false)
  const cancelRenameRef = useRef(false)
  const closeMenu = useCallback(() => setMenu(null), [])
  const color = SESSION_GROUP_COLORS.find((candidate) => candidate.id === group.color)

  useEffect(() => {
    if (!isEditing || !renameInputRef.current) return
    renameFinishedRef.current = false
    cancelRenameRef.current = false
    renameInputRef.current.focus()
    renameInputRef.current.select()
  }, [isEditing])

  const submitRename = () => {
    if (renameFinishedRef.current || cancelRenameRef.current) return
    renameFinishedRef.current = true
    onSubmitRename()
  }

  const openMenu = () => {
    const bounds = menuButtonRef.current?.getBoundingClientRect()
    if (!bounds) return
    const menuHeight = (SESSION_GROUP_COLORS.length + 3) * 36
    const opensAbove = anchor === 'bottom' || window.innerHeight - bounds.bottom < menuHeight
    setMenu({ x: bounds.left, y: bounds.bottom, opensAbove })
  }

  const menuItems: ContextMenuEntry[] = [
    {
      key: 'rename',
      label: t('Rename group'),
      icon: <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
      onSelect: onStartRename,
    },
    'divider',
    ...SESSION_GROUP_COLORS.map((candidate) => ({
      key: `color-${candidate.id}`,
      label: candidate.id === group.color ? t('{color} (current)', { color: t(candidate.label) }) : t(candidate.label),
      icon: (
        <span
          aria-hidden="true"
          className="h-3 w-3 shrink-0 rounded-full ring-1 ring-border"
          style={{ backgroundColor: candidate.value }}
        />
      ),
      title: t('Set group color to {color}', { color: t(candidate.label).toLowerCase() }),
      onSelect: () => onSetColor(candidate.id),
    })),
    'divider',
    {
      key: 'delete',
      label: t('Delete group'),
      icon: <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />,
      danger: true,
      onSelect: onDelete,
    },
  ]

  return (
    <div
      ref={setNodeRef}
      data-testid="session-group-header"
      className={`flex min-h-10 items-center gap-1.5 border-y px-2 ${isOver && !isDragging ? 'border-accent bg-hover' : 'border-border/60 bg-surface/40'} ${isDragging ? 'opacity-60' : ''}`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('Drag group {name}', { name: group.name })}
        title={t('Drag to reorder group')}
        className="touch-none cursor-grab px-1 text-muted hover:text-primary active:cursor-grabbing"
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-label={group.collapsed ? t('Expand {name}', { name: group.name }) : t('Collapse {name}', { name: group.name })}
        aria-expanded={!group.collapsed}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"
      >
        {group.collapsed
          ? <ChevronRightIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
          : <ChevronDownIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />}
      </button>
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-border"
        style={{ backgroundColor: color?.value }}
      />
      {isEditing ? (
        <input
          ref={renameInputRef}
          type="text"
          value={editingName}
          onChange={(event) => onEditingNameChange(event.target.value)}
          onBlur={() => {
            if (!cancelRenameRef.current) submitRename()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelRenameRef.current = true
              onCancelRename()
            }
          }}
          onClick={(event) => event.stopPropagation()}
          className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-1 text-xs font-medium text-primary outline-none focus:border-accent"
          aria-label={t('Rename group')}
        />
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!group.collapsed}
          className="min-w-0 flex-1 truncate py-1 text-left text-xs font-semibold text-primary"
          title={group.name}
        >
          {group.name}
        </button>
      )}
      <span className="shrink-0 text-[10px] tabular-nums text-muted" aria-label={t('{count} sessions', { count })}>
        {count}
      </span>
      <button
        ref={menuButtonRef}
        type="button"
        onClick={openMenu}
        aria-label={t('Options for {name}', { name: group.name })}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={t('Options for {name}', { name: group.name })}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"
      >
        <DotsHorizontalIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
      </button>
      {menu && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          items={menuItems}
          anchorFromBottom={menu.opensAbove}
          keyboardNavigation
          returnFocusRef={menuButtonRef}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

interface SortableSessionItemProps {
  session: Session
  displayName: string
  titleOverride?: string
  groupColor?: SessionGroup['color']
  groups: SessionGroup[]
  assignedGroupId?: string
  isNew: boolean
  exitDuration: number
  prefersReducedMotion: boolean | null
  useSafariLayoutFallback: boolean
  isSelected: boolean
  isEditing: boolean
  isEditingTitle: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  showHostInfo: boolean
  dropIndicator: 'above' | 'below' | null
  /** Coarse pointers only: drag activates from the card's handle so the row
   * body keeps native panning (dnd-kit listeners move onto the handle). */
  dragViaHandle: boolean
  onSelect: () => void
  onStartEdit?: () => void
  onStartEditTitle?: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onSetDisplayName?: (title: string | null) => void
  onMoveToGroup?: (groupId: string | null) => void
  onHibernate?: () => void
  onKill?: () => void
  onDuplicate?: () => void
  onCloseTmux?: () => void
  hiddenFromActive?: boolean
  onToggleHidden?: () => void
}

const SortableSessionItem = forwardRef<HTMLDivElement, SortableSessionItemProps>(function SortableSessionItem({
  session,
  displayName,
  titleOverride,
  groupColor,
  groups,
  assignedGroupId,
  isNew,
  exitDuration,
  prefersReducedMotion,
  useSafariLayoutFallback,
  isSelected,
  isEditing,
  isEditingTitle,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  showHostInfo,
  dropIndicator,
  dragViaHandle,
  onSelect,
  onStartEdit,
  onStartEditTitle,
  onCancelEdit,
  onRename,
  onSetDisplayName,
  onMoveToGroup,
  onHibernate,
  onKill,
  onDuplicate,
  onCloseTmux,
  hiddenFromActive,
  onToggleHidden,
}, ref) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: session.id,
    animateLayoutChanges: ({ isSorting, wasDragging }) => isSorting || wasDragging,
  })


  // Pin the drag transform to the vertical axis: a horizontally-tracking card
  // extends the scroller's scrollable overflow, which lets wheel flicks and
  // dnd-kit's edge auto-scroll drag the whole list sideways off the panel.
  const dndTransform = CSS.Transform.toString(
    transform ? { ...transform, x: 0 } : transform
  )
  const shouldApplyStyleTransform = Boolean(prefersReducedMotion && dndTransform)
  const style = {
    ...(shouldApplyStyleTransform ? { transform: dndTransform } : {}),
    // dnd-kit's transition only applies while sorting (or during the drop
    // settle) — the dragged node gets undefined so it tracks the pointer 1:1.
    // Without it, displaced siblings teleport instead of easing out of the way.
    ...(transition && !prefersReducedMotion ? { transition } : {}),
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.9 : undefined,
  }

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node)
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [setNodeRef, ref],
  )

  return (
    // Deliberately no framer `layout` prop: animated resorts slide rows through
    // each other, overlapping two sessions' text mid-flight (#159). Rows snap to
    // their new position; drag previews still animate via the dnd-kit transform.
    <motion.div
      ref={setRefs}
      data-session-id={session.id}
      style={{ ...style, overflow: 'hidden' }}
      className="relative"
      transformTemplate={(_, generatedTransform) =>
        composeSortableTransform({
          useSafariLayoutFallback,
          isDragging,
          dndTransform,
          generatedTransform,
        })
      }
      initial={
        prefersReducedMotion || !isNew
          ? false
          : useSafariLayoutFallback
            ? { opacity: 0 }
            : { opacity: 0, scale: 0.97 }
      }
      // height: 'auto' is load-bearing, not cosmetic. A session that re-enters
      // mid exit-collapse (kill rollback, flaky snapshot) cancels the exit; the
      // animate target then decides what happens to the half-collapsed inline
      // height. Without a height target, motion settles it as a fixed px and
      // overflow:hidden clips any later content growth (e.g. a last-user
      // message arriving on the next poll) mid-glyph.
      animate={
        prefersReducedMotion
          ? { opacity: 1 }
          : isNew
            ? useSafariLayoutFallback
              ? { opacity: 1, height: 'auto' }
              : { opacity: 1, scale: [1.02, 0.99, 1], height: 'auto' }
            : { opacity: 1, scale: 1, height: 'auto' }
      }
      exit={prefersReducedMotion
        ? { opacity: 0 }
        : useSafariLayoutFallback
          ? { opacity: 0, height: 0 }
          : { opacity: 0, height: 0, scale: 0.97 }}
      transition={
        prefersReducedMotion
          ? { duration: 0 }
          : useSafariLayoutFallback
            ? {
              opacity: { duration: exitDuration / 1000 },
              height: { duration: exitDuration / 1000, ease: 'easeOut' },
            }
            : {
              opacity: { duration: exitDuration / 1000 },
              scale: { duration: exitDuration / 1000, ease: [0.34, 1.56, 0.64, 1] },
              height: { duration: exitDuration / 1000, ease: 'easeOut' },
            }
      }
      {...attributes}
      {...(dragViaHandle ? {} : listeners)}
    >
      {/* Drop indicator line */}
      {dropIndicator === 'above' && (
        <div className="absolute -top-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
      <SessionRow
        session={session}
        displayName={displayName}
        titleOverride={titleOverride}
        groupColor={groupColor}
        groups={groups}
        assignedGroupId={assignedGroupId}
        isSelected={isSelected}
        isEditing={isEditing}
        isEditingTitle={isEditingTitle}
        showSessionIdPrefix={showSessionIdPrefix}
        showProjectName={showProjectName}
        showLastUserMessage={showLastUserMessage}
        showHostInfo={showHostInfo}
        isDragging={isDragging}
        dragHandleListeners={dragViaHandle ? listeners : undefined}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onStartEditTitle={onStartEditTitle}
        onCancelEdit={onCancelEdit}
        onRename={onRename}
        onSetDisplayName={onSetDisplayName}
        onMoveToGroup={onMoveToGroup}
        onHibernate={onHibernate}
        onKill={onKill}
        onDuplicate={onDuplicate}
        onCloseTmux={onCloseTmux}
        hiddenFromActive={hiddenFromActive}
        onToggleHidden={onToggleHidden}
      />
      {dropIndicator === 'below' && (
        <div className="absolute -bottom-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
    </motion.div>
  )
})

SortableSessionItem.displayName = 'SortableSessionItem'

interface SessionRowProps {
  session: Session
  displayName: string
  titleOverride?: string
  groupColor?: SessionGroup['color']
  groups: SessionGroup[]
  assignedGroupId?: string
  isSelected: boolean
  isEditing: boolean
  isEditingTitle: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  showHostInfo: boolean
  isDragging?: boolean
  /** Present only on coarse pointers: the dnd-kit activator listeners move off
   * the card body onto the drag handle so the row can still pan natively. */
  dragHandleListeners?: NonNullable<ReturnType<typeof useSortable>['listeners']>
  onSelect: () => void
  onStartEdit?: () => void
  onStartEditTitle?: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onSetDisplayName?: (title: string | null) => void
  onMoveToGroup?: (groupId: string | null) => void
  onHibernate?: () => void
  onKill?: () => void
  onDuplicate?: () => void
  onCloseTmux?: () => void
  hiddenFromActive?: boolean
  onToggleHidden?: () => void
}

function SessionRow({
  session,
  displayName,
  titleOverride,
  groupColor,
  groups,
  assignedGroupId,
  isSelected,
  isEditing,
  isEditingTitle,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  showHostInfo,
  isDragging = false,
  dragHandleListeners,
  onSelect,
  onStartEdit,
  onStartEditTitle,
  onCancelEdit,
  onRename,
  onSetDisplayName,
  onMoveToGroup,
  onHibernate,
  onKill,
  onDuplicate,
  onCloseTmux,
  hiddenFromActive,
  onToggleHidden,
}: SessionRowProps) {
  const t = useTranslation()
  const locale = useLocale((s) => s.locale)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))
  const responseAt = session.lastResponseAt
  const responseTime = responseAt ? formatRelativeTime(responseAt, locale) : ''
  const responseLabel = responseAt && responseTime
    ? <span title={t('Last response · {time}', { time: new Date(responseAt).toLocaleString(locale) })}>{responseTime}</span>
    : <span title={session.remote && session.agentType === 'codex' && !session.agentSessionId
      ? t('Run /status in Codex, then right-click and choose Read ID from /status.')
      : t('Last response time unavailable')}>—</span>
  const inputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const sessionName =
    session.agentSessionName?.trim() ||
    session.name?.trim() ||
    session.id
  const editInitialValue = isEditingTitle ? titleOverride ?? displayName : sessionName
  const [editValue, setEditValue] = useState(editInitialValue)
  const editFinishedRef = useRef(false)
  const cancelEditRef = useRef(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const contextMenuPosition = useMenuViewportFit(contextMenuRef, contextMenu)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const hostLabel = session.host?.trim()
  const disconnected = useSessionStore((state) =>
    session.remote === true && state.hostStatuses.some((host) => host.host === session.host && !host.ok)
  )
  const needsInput = !disconnected && session.status === 'permission'
  const agentSessionId = session.agentSessionId?.trim()
  const conversationId = useRemoteSessionId(session)
  const sessionIdPrefix =
    showSessionIdPrefix && agentSessionId
      ? getSessionIdShort(agentSessionId)
      : ''
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const showHostBadge = showHostInfo && Boolean(hostLabel)
  const showMessage = showLastUserMessage && Boolean(session.lastUserMessage)
  const groupColorValue = groupColor
    ? SESSION_GROUP_COLORS.find((color) => color.id === groupColor)?.value
    : undefined
  const moveTargets = groups.filter((group) => group.id !== assignedGroupId)

  // Track previous status for transition animation
  const prevStatusRef = useRef<Session['status']>(session.status)
  const [isPulsingComplete, setIsPulsingComplete] = useState(false)

  useEffect(() => {
    const prevStatus = prevStatusRef.current
    const currentStatus = session.status

    // Detect transition from working → waiting (not permission, which needs immediate attention)
    if (prevStatus === 'working' && currentStatus === 'waiting') {
      setIsPulsingComplete(true)
      // Don't update ref yet - will update when animation ends
    } else {
      prevStatusRef.current = currentStatus
    }
  }, [session.status])

  const handlePulseAnimationEnd = () => {
    setIsPulsingComplete(false)
    prevStatusRef.current = session.status
  }

  useEffect(() => {
    if ((isEditing || isEditingTitle) && inputRef.current) {
      editFinishedRef.current = false
      cancelEditRef.current = false
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing, isEditingTitle])

  useEffect(() => {
    setEditValue(editInitialValue)
  }, [editInitialValue])

  const handleSubmit = () => {
    if (editFinishedRef.current || cancelEditRef.current) return
    editFinishedRef.current = true
    const trimmed = editValue.trim()
    if (isEditingTitle) {
      onSetDisplayName?.(trimmed || null)
    } else if (trimmed && trimmed !== sessionName) {
      onRename(trimmed)
    } else {
      onCancelEdit()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditRef.current = true
      setEditValue(editInitialValue)
      onCancelEdit()
    }
  }

  const touchStartPos = useRef<{ x: number; y: number } | null>(null)

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isDragging) return
    // A touch on the drag handle starts a dnd-kit drag — don't also arm the
    // long-press context menu under the same gesture.
    const touchTarget = e.target as HTMLElement | null
    if (
      typeof touchTarget?.closest === 'function' &&
      touchTarget.closest('[data-testid="drag-handle"]')
    )
      return
    const touch = e.touches[0]
    touchStartPos.current = { x: touch.clientX, y: touch.clientY }
    longPressTimer.current = setTimeout(() => {
      if (touchStartPos.current) {
        setContextMenu(touchStartPos.current)
      }
    }, 500)
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  // Close context menu on click outside or escape
  useEffect(() => {
    if (!contextMenu) return

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div
      className={`session-row group cursor-pointer select-none border-l-2 border-transparent pl-1 pr-3 py-2 ${MOBILE_ROW_TARGET_CLASS} ${isSelected ? 'selected' : ''} ${isDragging ? 'cursor-grabbing shadow-lg ring-1 ring-accent/30 bg-elevated' : 'cursor-grab'}`}
      style={groupColorValue ? { borderLeftColor: groupColorValue } : undefined}
      role="button"
      aria-pressed={isSelected}
      tabIndex={0}
      data-testid="session-card"
      data-session-id={session.id}
      onClick={isDragging ? undefined : onSelect}
      onKeyDown={(e) => {
        // Only the card's own keys select it. Keys aimed at nested controls
        // (PR chips, the "+N" strip and its portaled chips, the rename
        // input) bubble here too; selecting on them would start a terminal
        // attach whose focusAfterAttach then yanks focus out of that control.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <SessionActivity
        session={session}
        statusClassName={disconnected
          ? 'ml-1 shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300'
          : needsInput
          ? `ml-1 flex shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 ${statusPillClass[session.status]} pulse-approval`
          : `ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-right text-xs tabular-nums ${statusPillClass[session.status]}${isPulsingComplete ? ' pulse-complete' : ''}`}
        onAnimationEnd={handlePulseAnimationEnd}
        statusContent={disconnected ? <span title={hostLabel ? t('{host} is unreachable', { host: hostLabel }) : t('Host is unreachable')}>{t('Offline')}</span> : needsInput
          ? <HandIcon width={ICON_SIZE.pill} height={ICON_SIZE.pill} aria-label={t('Needs input')} />
          : responseLabel}
      >
        {(counter, status) => (
          <div className="flex items-start gap-[6px] pl-0.5">
            <div data-testid="session-agent-column" className={`flex w-[28px] shrink-0 flex-col items-center gap-1 pt-[3px] ${session.activity?.total ? 'min-h-[44px]' : ''}`}>
              {dragHandleListeners ? (
                // On coarse pointers the icon doubles as the drag handle.
                // touch-action:none keeps the browser from claiming the pan for
                // scrolling, which would pointercancel the drag at activation;
                // the padding widens the hit target without growing the icon.
                <span
                  {...dragHandleListeners}
                  data-testid="drag-handle"
                  aria-label={t('Drag to reorder')}
                  style={{ touchAction: 'none' }}
                  className="-my-1 -ml-1 flex items-center py-1 pl-1 cursor-grab"
                >
                  <AgentIcon
                    agentType={session.agentType}
                    command={session.command}
                    className="h-3.5 w-3.5 shrink-0 text-muted"
                  />
                </span>
              ) : (
                <AgentIcon
                  agentType={session.agentType}
                  command={session.command}
                  className="h-3.5 w-3.5 shrink-0 text-muted"
                />
              )}
              {counter}
            </div>
            <div className="session-details flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                {isEditing || isEditingTitle ? (
                  <input
                    ref={inputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => {
                      if (!cancelEditRef.current) handleSubmit()
                    }}
                    onKeyDown={handleKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    // Without this, dragging to select text inside the input arms
                    // the row's dnd-kit PointerSensor on the wrapper.
                    onPointerDown={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
                    aria-label={isEditingTitle ? t('Edit display name') : t('Rename session')}
                  />
                ) : (
                  <span className="session-name min-w-0 flex-1 truncate text-primary">
                    {displayName}
                  </span>
                )}
                {sessionIdPrefix && (
                  <span
                    className="shrink-0 text-[11px] font-mono text-muted"
                    title={agentSessionId}
                  >
                    {sessionIdPrefix}
                  </span>
                )}
                {status}
              </div>
              {/* Project metadata and preview occupy their own stable lines. */}
              {(showDirectory || showHostBadge) && (
                <div className="session-metadata">
                  {showHostBadge && <HostBadge name={hostLabel!} />}
                  {showDirectory && (
                    <ProjectBadge name={directoryLeaf!} fullPath={session.projectPath} />
                  )}
                </div>
              )}
              {showMessage && (
                <span className="session-preview">
                  {session.lastUserMessage!.length > 200
                    ? session.lastUserMessage!.slice(0, 200) + '…'
                    : session.lastUserMessage}
                </span>
              )}

              {/* PR context stays below the preview. */}
              {session.prs && session.prs.length > 0 && (
                <PrChips prs={session.prs} className="font-mono" />
              )}
            </div>
          </div>
        )}
      </SessionActivity>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1"
          style={contextMenuPosition ?? undefined}
          role="menu"
        >
          {agentSessionId && (
            <button type="button" role="menuitem" title={agentSessionId}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
              onClick={event => { event.stopPropagation(); copyText(agentSessionId); setContextMenu(null) }}>
              <Copy01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Copy full session ID')}
            </button>
          )}
          {session.remote && session.agentType === 'codex' && (
            <>
              <button type="button" role="menuitem" disabled={conversationId.pending}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
                onClick={event => {
                  event.stopPropagation()
                  void conversationId.save({ source: 'codex-status' })
                }}>
                <Hash01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
                {conversationId.pending ? t('Reading session ID…') : t('Read ID from /status')}
              </button>
              {conversationId.error && (
                <p role="alert" className="max-w-64 px-3 py-2 text-xs text-danger">{translateServerError(locale, conversationId.error)}</p>
              )}
            </>
          )}
          {onStartEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onStartEdit()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
            >
              <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Rename')}
            </button>
          )}
          {onStartEditTitle && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onStartEditTitle()
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
              role="menuitem"
            >
              <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Edit display name')}
            </button>
          )}
          {onMoveToGroup && (assignedGroupId || moveTargets.length > 0) && (
            <>
              <div className="my-1 border-t border-border" />
              {assignedGroupId && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setContextMenu(null)
                    onMoveToGroup(null)
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
                  role="menuitem"
                >
                  {t('Move to Ungrouped')}
                </button>
              )}
              {moveTargets.map((group) => {
                const color = SESSION_GROUP_COLORS.find((candidate) => candidate.id === group.color)
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setContextMenu(null)
                      onMoveToGroup(group.id)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
                    role="menuitem"
                  >
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color?.value }}
                    />
                    {t('Move to')}{' '}{group.name}
                  </button>
                )
              })}
            </>
          )}
          {onToggleHidden && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setContextMenu(null)
                onToggleHidden()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
              role="menuitem"
            >
              {hiddenFromActive ? t('Show in Active') : t('Hide from Active')}
            </button>
          )}
          {onDuplicate && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onDuplicate()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={t('Create a copy in a new tmux window')}
            >
              <Copy01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Duplicate')}
            </button>
          )}
          {onHibernate && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onHibernate()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={t('Close the live window and keep this session ready to wake')}
            >
              <Moon01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Hibernate')}
            </button>
          )}
          {session.logFilePath && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                if (session.logFilePath) {
                  copyText(session.logFilePath)
                }
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.logFilePath}
            >
              <File06Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Copy Log Path')}
            </button>
          )}
          {onCloseTmux && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setContextMenu(null)
                onCloseTmux()
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-hover"
              role="menuitem"
            >
              <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              {t('Close tmux session')}
            </button>
          )}
          {onKill && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setContextMenu(null)
                  onKill()
                }}
                className="w-full px-3 py-2 text-left text-sm text-danger hover:bg-danger/10 flex items-center gap-2"
                role="menuitem"
              >
                <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
                {t('Kill Session')}
                {isSelected && <kbd className="ml-auto pl-3 text-xs font-mono">{modDisplay}X</kbd>}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export { formatRelativeTime }
