/**
 * Session list page: ordering, sidebar layout, what each row shows, and the
 * server-wide history window and naming preference.
 */
import { HISTORY_MAX_AGE_MAX_HOURS, HISTORY_MAX_AGE_MIN_HOURS } from '@shared/types'
import {
  useSettingsStore,
  type SessionSortDirection,
  type SessionSortMode,
  type SidebarAnchor,
} from '../../../stores/settingsStore'
import { Switch } from '../../Switch'
import { CommitInput, parseClampedInt } from '../controls/CommitInput'
import { SegmentedControl } from '../controls/SegmentedControl'
import { SWITCH_TOUCH_TARGET } from '../styles'
import type { RowControlProps, SettingsRowDef, SettingsState } from '../types'
import { useServerSetting } from '../useServerSetting'
import { useTranslation } from '../../../locale'

type BooleanKey = 'showMobileSessionPeek' | 'showProjectName' | 'showLastUserMessage' | 'showSessionIdPrefix'
type BooleanSetter = 'setShowMobileSessionPeek' | 'setShowProjectName' | 'setShowLastUserMessage' | 'setShowSessionIdPrefix'

/** A Switch row bound to one boolean settings-store key. */
export function storeSwitch(key: BooleanKey, setter: BooleanSetter) {
  return function StoreSwitch({ ids }: RowControlProps) {
    const checked = useSettingsStore((state) => state[key])
    const set = useSettingsStore((state) => state[setter])
    return (
      <Switch
        className={SWITCH_TOUCH_TARGET}
        id={ids.control}
        checked={checked}
        onCheckedChange={set}
        ariaLabelledBy={ids.label}
        ariaDescribedBy={ids.description}
      />
    )
  }
}

function SortModeControl({ ids }: RowControlProps) {
  const t = useTranslation()
  const value = useSettingsStore((state) => state.sessionSortMode)
  const set = useSettingsStore((state) => state.setSessionSortMode)
  return (
    <SegmentedControl<SessionSortMode>
      options={[
        { value: 'created', label: t('Created') },
        { value: 'status', label: t('Status') },
        { value: 'manual', label: t('Manual') },
      ]}
      value={value}
      onChange={set}
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

function SortModeDescription() {
  const t = useTranslation()
  const mode = useSettingsStore((state) => state.sessionSortMode)
  if (mode === 'status') return <>{t('Permission sessions come first; the rest sort by newest activity.')}</>
  if (mode === 'manual') return <>{t('Drag sessions in the sidebar to reorder them.')}</>
  return <>{t('Sessions stay in the order they were created.')}</>
}

function SortDirectionControl({ ids }: RowControlProps) {
  const t = useTranslation()
  const value = useSettingsStore((state) => state.sessionSortDirection)
  const set = useSettingsStore((state) => state.setSessionSortDirection)
  return (
    <SegmentedControl<SessionSortDirection>
      options={[
        { value: 'desc', label: t('Newest first') },
        { value: 'asc', label: t('Oldest first') },
      ]}
      value={value}
      onChange={set}
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

function SidebarAnchorControl({ ids }: RowControlProps) {
  const t = useTranslation()
  const value = useSettingsStore((state) => state.sidebarAnchor)
  const set = useSettingsStore((state) => state.setSidebarAnchor)
  return (
    <SegmentedControl<SidebarAnchor>
      options={[
        { value: 'top', label: t('Top') },
        { value: 'bottom', label: t('Bottom') },
      ]}
      value={value}
      onChange={set}
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

function SidebarAnchorDescription() {
  const t = useTranslation()
  const anchor = useSettingsStore((state) => state.sidebarAnchor)
  return anchor === 'bottom'
    ? <>{t('The sidebar is mirrored: the first session sits at the bottom, next to the prompt.')}</>
    : <>{t('The first session sits at the top of the sidebar.')}</>
}

function HistoryLookbackControl({ ids }: RowControlProps) {
  const t = useTranslation()
  const { value, loaded, set } = useServerSetting<number>('history-max-age-hours', 'hours', 24)
  return (
    <div className="flex items-start gap-2">
      {/* Disabled only until the value loads: disabling a focused input
          mid-write would drop keyboard focus to <body>. */}
      <CommitInput
        id={ids.control}
        type="text"
        inputMode="numeric"
        value={String(value)}
        disabled={!loaded}
        describedBy={ids.description}
        wrapperClassName="w-20"
        className="text-center tabular-nums"
        onCommit={(draft) => {
          const hours = parseClampedInt(draft, HISTORY_MAX_AGE_MIN_HOURS, HISTORY_MAX_AGE_MAX_HOURS)
          if (hours === null) {
            return `Enter ${HISTORY_MAX_AGE_MIN_HOURS}–${HISTORY_MAX_AGE_MAX_HOURS}`
          }
          if (hours !== value) set(hours)
          return null
        }}
      />
      <span className="flex h-[32px] items-center text-[12px] text-muted max-md:h-[44px]">{t('hours')}</span>
    </div>
  )
}

function PreferWindowNameControl({ ids }: RowControlProps) {
  const { value, loaded, set } = useServerSetting<boolean>('prefer-window-name', 'enabled', false)
  return (
    <Switch
      className={SWITCH_TOUCH_TARGET}
      id={ids.control}
      checked={value}
      onCheckedChange={set}
      disabled={!loaded}
      ariaLabelledBy={ids.label}
      ariaDescribedBy={ids.description}
    />
  )
}

const isCreatedSort = (state: SettingsState) => state.sessionSortMode === 'created'

export const sessionListRows: SettingsRowDef[] = [
  {
    id: 'sort-order',
    page: 'session-list',
    label: 'Sort order',
    description: 'Created keeps creation order, Status re-sorts by status, Manual lets you drag.',
    keywords: ['sort', 'order', 'created', 'status', 'manual', 'drag'],
    layout: 'wide',
    Description: SortModeDescription,
    Control: SortModeControl,
  },
  {
    id: 'sort-direction',
    page: 'session-list',
    label: 'Sort direction',
    description: 'Newest or oldest sessions first.',
    keywords: ['sort', 'newest', 'oldest', 'ascending', 'descending'],
    layout: 'wide',
    visibleWhen: isCreatedSort,
    Control: SortDirectionControl,
  },
  {
    id: 'sidebar-anchor',
    page: 'session-list',
    label: 'Sidebar anchor',
    description: 'Top lists the first session at the top; Bottom mirrors the sidebar.',
    keywords: ['sidebar', 'mirror', 'top', 'bottom'],
    tags: ['desktop'],
    Description: SidebarAnchorDescription,
    Control: SidebarAnchorControl,
  },
  {
    id: 'mobile-session-peek',
    page: 'session-list',
    label: 'Mobile session peek',
    description: 'Show the colored status strip at the left edge of the mobile terminal. Turn off to use the full width.',
    keywords: ['phone', 'sidebar', 'status', 'rail'],
    tags: ['device'],
    Control: storeSwitch('showMobileSessionPeek', 'setShowMobileSessionPeek'),
  },
  {
    id: 'show-project-name',
    page: 'session-list',
    label: 'Project name',
    description: 'Show the project folder name under each session.',
    keywords: ['folder', 'details'],
    Control: storeSwitch('showProjectName', 'setShowProjectName'),
  },
  {
    id: 'show-last-user-message',
    page: 'session-list',
    label: 'Last user message',
    description: 'Show the most recent prompt next to the project name.',
    keywords: ['prompt', 'input', 'details'],
    Control: storeSwitch('showLastUserMessage', 'setShowLastUserMessage'),
  },
  {
    id: 'show-session-id-prefix',
    page: 'session-list',
    label: 'Session ID prefix',
    description: 'Show the first 5 characters of the agent session ID.',
    keywords: ['id', 'uuid', 'details'],
    Control: storeSwitch('showSessionIdPrefix', 'setShowSessionIdPrefix'),
  },
  {
    id: 'history-lookback',
    page: 'session-list',
    label: 'History lookback',
    description: `Show history sessions from the last N hours (${HISTORY_MAX_AGE_MIN_HOURS}–${HISTORY_MAX_AGE_MAX_HOURS}), up to the 100 most recent. Default 24.`,
    keywords: ['history', 'hours', 'age', 'inactive', 'past'],
    Control: HistoryLookbackControl,
  },
  {
    id: 'prefer-window-name',
    page: 'session-list',
    label: 'Prefer window names',
    description: 'Label discovered sessions with their tmux window name instead of the session name.',
    keywords: ['tmux', 'window', 'name', 'title'],
    Control: PreferWindowNameControl,
  },
]
