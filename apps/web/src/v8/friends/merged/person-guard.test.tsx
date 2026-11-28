// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'

const fx = vi.hoisted(() => ({
  phase: 'ready' as 'loading' | 'ready' | 'error' | 'forbidden',
  person: null as Record<string, unknown> | null,
  saving: false,
  unlinking: false,
  profileSaving: false,
  unlinkTarget: null as Record<string, unknown> | null,
  unlinkReason: '',
  reload: vi.fn(),
  openProfileEditor: vi.fn(),
  setEditing: vi.fn(),
  setUnlinkTarget: vi.fn(),
  setUnlinkReason: vi.fn(),
  setSaveError: vi.fn(),
  setDeliveryActive: vi.fn(),
  unlink: vi.fn(),
  save: vi.fn(),
  saveProfile: vi.fn(),
  setProfileDraft: vi.fn(),
  setProfileEditing: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/friends',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/components/merged-person/use-merged-person', () => ({
  useMergedPerson: () => ({
    phase: fx.phase,
    person: fx.person,
    failure: null,
    saving: fx.saving,
    unlinking: fx.unlinking,
    profileSaving: fx.profileSaving,
    editing: false,
    profileEditing: false,
    profileDraft: {},
    unlinkTarget: fx.unlinkTarget,
    unlinkReason: fx.unlinkReason,
    saveError: '',
    reload: fx.reload,
    openProfileEditor: fx.openProfileEditor,
    setEditing: fx.setEditing,
    setUnlinkTarget: fx.setUnlinkTarget,
    setUnlinkReason: fx.setUnlinkReason,
    setSaveError: fx.setSaveError,
    setDeliveryActive: fx.setDeliveryActive,
    unlink: fx.unlink,
    save: fx.save,
    saveProfile: fx.saveProfile,
    setProfileDraft: fx.setProfileDraft,
    setProfileEditing: fx.setProfileEditing,
  }),
}))

import MergedPersonV8 from './person'

function makePerson(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mp-1',
    primaryDisplayName: '佐藤 花子',
    revision: 1,
    linkedFriends: [
      { friendId: 'f1', lineAccountId: 'a1', lineAccountName: '本店', displayName: '花子A', isFollowing: true, linkedAt: '' },
      { friendId: 'f2', lineAccountId: 'a2', lineAccountName: '支店', displayName: '花子B', isFollowing: true, linkedAt: '2026-10-05T00:00:00Z' },
    ],
    deliveryPriorities: [
      { friendId: 'f1', purpose: 'broadcast', priority: 1, isActive: true },
      { friendId: 'f2', purpose: 'broadcast', priority: 2, isActive: false },
    ],
    profileValues: [],
    profileCandidates: [],
    history: [],
    ...overrides,
  }
}

describe('MergedPersonV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.phase = 'ready'
    fx.person = makePerson()
    fx.saving = false
    fx.unlinking = false
    fx.profileSaving = false
    fx.unlinkTarget = null
    fx.unlinkReason = ''
    rememberStaffIdentity({ id: 'owner', role: 'owner' } as StaffMember)
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
  })

  it('必須配列が壊れた統合ユーザー応答は読み込み失敗と再読み込みを出し、操作ボタンを出さない', () => {
    fx.person = makePerson({ linkedFriends: null })
    render(<MergedPersonV8 personId="mp-1" onClose={vi.fn()} />)

    expect(screen.getByText('統合ユーザーの情報を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '使う値を編集する' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(fx.reload).toHaveBeenCalledTimes(1)
  })

  it('空文字や不正な linkedAt が混ざっていても有効な最古日時で表示する', () => {
    render(<MergedPersonV8 personId="mp-1" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '佐藤 花子の説明' }))
    expect(screen.getByText(/10\/05 に結び付けた/)).toBeTruthy()
  })

  it('解除処理中は他の編集・解除ボタンと解除理由の入力欄が無効化される', () => {
    fx.unlinking = true
    fx.unlinkTarget = { friendId: 'f1', lineAccountId: 'a1', lineAccountName: '本店', displayName: '花子A' }
    render(<MergedPersonV8 personId="mp-1" onClose={vi.fn()} />)

    expect((screen.getByRole('button', { name: '使う値を編集する' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '目的ごとの順位を編集 →' }) as HTMLButtonElement).disabled).toBe(true)
    for (const btn of screen.getAllByRole('button', { name: '解除する' })) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
    expect((screen.getByPlaceholderText('確認した根拠を書いてください') as HTMLTextAreaElement).disabled).toBe(true)
  })
})
