// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  friendId: 'f-1',
  tab: 'info',
  visibilityStatus: 'loading' as 'loading' | 'ready' | 'error',
  fieldsEnabled: false,
  createdAt: 'not-a-valid-date',
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(`id=${fx.friendId}&tab=${fx.tab}`),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/friends/detail',
}))
vi.mock('@/components/shared/list-navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shared/list-navigation')>()
  return {
    ...actual,
    useListNavigationRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  }
})
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '本店' } }),
}))
vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({
    status: fx.visibilityStatus,
    enabled: (key: string) => (key === 'friend_fields' ? fx.fieldsEnabled : true),
  }),
}))
vi.mock('./use-friend-detail', () => ({
  useFriendDetail: () => ({
    loading: false,
    loadForbidden: false,
    friendMissing: false,
    error: '',
    setError: vi.fn(),
    loadFriend: vi.fn(),
    upcoming: null,
    upcomingStatus: 'ready',
    loadUpcoming: vi.fn(),
    fields: [],
    hiddenPersonalCount: 0,
    values: {},
    setValues: vi.fn(),
    fieldsStatus: 'ready',
    loadFields: vi.fn(),
    fieldFolders: [],
    fieldFoldersStatus: 'ready',
    saving: false,
    saveError: '',
    saveNotice: '',
    warnings: [],
    saveFields: vi.fn(),
    mileage: null,
    mileageInsights: null,
    mileageConnections: [],
    mileageStatus: 'ready',
    loadMileage: vi.fn(),
    richMenu: null,
    richMenuStatus: 'ready',
    loadRichMenu: vi.fn(),
    historyItems: [],
    historyStatus: 'ready',
    historyNextCursor: null,
    historyLoadingMore: false,
    historyMoreError: false,
    loadHistory: vi.fn(),
    submissions: [],
    submissionsStatus: 'idle',
    submissionsTotal: null,
    submissionsNextCursor: null,
    submissionsLoadingMore: false,
    submissionsMoreError: false,
    loadSubmissions: vi.fn(),
    friend: {
      id: fx.friendId,
      lineAccountId: 'acc-1',
      displayName: fx.friendId === 'f-1' ? '友だちA' : '友だちB',
      pictureUrl: null,
      createdAt: fx.createdAt,
      support: null,
      tags: [],
      memo: '',
    },
  }),
}))
vi.mock('./permissions', () => ({
  useFriendDetailPermissions: () => ({
    manage: true,
    editSupport: true,
    saveFields: true,
    viewOnly: false,
  }),
}))
vi.mock('./dialogs', () => ({
  useScenarioPicker: () => ({ openPicker: vi.fn(), dialog: null }),
  useSupportEditor: () => ({ openEditor: vi.fn(), dialog: null }),
}))
vi.mock('@/lib/use-customer-deletion', () => ({
  useCustomerDeletion: () => ({
    target: null,
    busy: false,
    blocked: false,
    error: null,
    open: vi.fn(),
    close: vi.fn(),
    confirm: vi.fn(),
  }),
}))

import FriendDetailV8 from './detail'

describe('FriendDetailV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.friendId = 'f-1'
    fx.tab = 'info'
    fx.visibilityStatus = 'loading'
    fx.fieldsEnabled = false
    fx.createdAt = 'not-a-valid-date'
  })

  afterEach(() => {
    cleanup()
  })

  it('情報欄タブは機能設定の読み込み中・取得失敗時に「機能が無効」と誤表示しない', () => {
    fx.visibilityStatus = 'loading'
    const view = render(<FriendDetailV8 />)
    expect(screen.getByLabelText('機能の設定を確認しています')).toBeTruthy()
    expect(screen.queryByText(/無効/)).toBeNull()

    fx.visibilityStatus = 'error'
    view.rerender(<FriendDetailV8 />)
    expect(screen.getByText('機能の設定を確認できませんでした')).toBeTruthy()
  })

  it('不正な作成日時で「—に友だち追加」にならず、友だち切替で開いた個別操作メニューが閉じる', () => {
    fx.tab = 'timeline'
    fx.fieldsEnabled = true
    fx.visibilityStatus = 'ready'
    const view = render(<FriendDetailV8 />)

    fireEvent.click(screen.getByRole('button', { name: '友だちAの説明' }))
    expect(screen.queryByText(/—に友だち追加/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '個別操作' }))
    expect(screen.getByRole('menu', { name: 'この友だちへの個別操作' })).toBeTruthy()

    fx.friendId = 'f-2'
    view.rerender(<FriendDetailV8 />)
    expect(screen.queryByRole('menu', { name: 'この友だちへの個別操作' })).toBeNull()
  })
})
