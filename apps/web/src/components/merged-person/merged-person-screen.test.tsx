import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * 候補の欄は共通 Select（listbox）。ここで見たいのは描いた後の
 * プロフィール候補の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))
import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MergedPersonDetail } from '@line-crm/shared'
import MergedDeliveryDialog from './merged-delivery-dialog'
import MergedProfileDialog, {
  emptyProfileCandidateDraft,
  selectedProfileCandidateCount,
} from './merged-profile-dialog'
import MergedPersonDetailV8 from './merged-person-detail-v8'
import MergedPersonV8 from '@/v8/friends/merged/person'

const view = vi.hoisted(() => ({ person: null as MergedPersonDetail | null }))
vi.mock('./use-merged-person', () => ({
  useMergedPerson: () => ({
    phase: 'ready', person: { ...view.person, profileCandidates: [], tagCandidates: [] },
    saveError: '', editing: false, profileEditing: false, profileDraft: {}, saving: false, profileSaving: false,
    unlinkTarget: null, unlinkReason: '', unlinking: false,
    setSaveError: vi.fn(), setEditing: vi.fn(), openProfileEditor: vi.fn(), setProfileDraft: vi.fn(),
    setProfileEditing: vi.fn(), save: vi.fn(), saveProfile: vi.fn(), setUnlinkTarget: vi.fn(),
    setUnlinkReason: vi.fn(), unlink: vi.fn(), reload: vi.fn(), setDeliveryActive: vi.fn(),
  }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/friends' }))

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

afterEach(() => vi.unstubAllGlobals())

/**
 * 画面確認（`scripts/visual-qa/fixtures.mjs` の `MERGED_PERSON_DETAIL`）と
 * 同じ形。別の形で書くと、試験は通るのに画面は落ちる。型を通して固定する。
 */
const PERSON: MergedPersonDetail = {
  id: 'merged-person-1', status: 'active', revision: 4, primaryDisplayName: '見本 171',
  linkedFriends: [
    {
      friendId: 'friend-identity-right', displayName: '見本 171',
      lineAccountId: 'visual-qa-account', lineAccountName: '本店', isFollowing: true,
      linkedAt: '2026-08-28T10:00:00.000Z', linkMethod: 'operator_review', confidence: 92,
      candidateId: 'identity-friend-1', candidateVersion: 2,
    },
    {
      friendId: 'friend-identity-left', displayName: '見本 161',
      lineAccountId: 'visual-qa-account-sub', lineAccountName: '支店', isFollowing: true,
      linkedAt: '2026-08-28T10:00:00.000Z', linkMethod: 'migration', confidence: null,
      candidateId: null, candidateVersion: null,
    },
  ],
  profileValues: [
    {
      fieldKey: 'email', fieldLabel: 'メールアドレス', valuePreview: 'ta***@example.com',
      sourceType: 'form', sourceLabel: '来店アンケート', sourceFriendId: 'friend-identity-right',
      verifiedAt: '2026-08-28T09:00:00.000Z', selectedByName: '画面確認',
      selectedAt: '2026-08-28T10:10:00.000Z', updateMode: 'fixed',
    },
    {
      fieldKey: 'phone', fieldLabel: '電話番号', valuePreview: '090-****-0001',
      sourceType: 'friend_field', sourceLabel: '支店の友だち情報',
      sourceFriendId: 'friend-identity-left', verifiedAt: null, selectedByName: '画面確認',
      selectedAt: '2026-08-28T10:12:00.000Z', updateMode: 'auto',
    },
  ],
  deliveryPriorities: [
    {
      purpose: 'broadcast', friendId: 'friend-identity-right',
      lineAccountId: 'visual-qa-account', lineAccountName: '本店', priority: 1,
      isActive: true, reason: '通常の配信は本店から送ります',
    },
    {
      purpose: 'broadcast', friendId: 'friend-identity-left',
      lineAccountId: 'visual-qa-account-sub', lineAccountName: '支店', priority: 2,
      isActive: true, reason: '本店から送れないときの代替です',
    },
  ],
  history: [
    {
      id: 'merged-event-1', eventType: 'link', summary: '本人照合で友だちを結び付けました',
      actorName: '画面確認', occurredAt: '2026-08-28T10:00:00.000Z',
    },
  ],
  createdAt: '2026-08-28T10:00:00.000Z', updatedAt: '2026-08-28T10:12:00.000Z',
  archivedAt: null,
}

function renderPerson(person: MergedPersonDetail, Component: typeof MergedPersonDetailV8): string {
  view.person = person
  return renderToStaticMarkup(<Component personId={person.id} onClose={() => {}} />)
}
describe.each([MergedPersonDetailV8, MergedPersonV8])('現役V8の統合ユーザー詳細 (%#)', (View) => {
const ALL = () => renderPerson(PERSON, View)

describe('統合ユーザー詳細の中身', () => {
  it('操作用のIDを本文へ出さない', () => {
    const html = ALL()
    // friendId は「友だちを開く」の行き先にだけ使う。本文には出さない。
    expect(html).not.toContain('>friend-identity-right<')
    expect(html).not.toContain('>friend-identity-left<')
    expect(html).not.toContain('identity-friend-1')
    expect(html).not.toContain('visual-qa-account')
    expect(html).not.toContain('merged-person-1')
    expect(html).toContain('href="/friends/detail?id=friend-identity-right"')
    expect(html).toContain('href="/friends/detail?id=friend-identity-left"')
  })

  it('メール・電話はマスク済みの値だけを出す', () => {
    const html = ALL()
    expect(html).toContain('ta***@example.com')
    expect(html).toContain('090-****-0001')
    expect(html).not.toContain('tanaka@example.com')
    expect(html).not.toContain('090-0000-0001')
  })

  it('未取得と取得できた値を見分けられる', () => {
    const html = ALL()
    // 本店は 92%、移行で入った支店は記録が無いので「—」。
    expect(html).toContain('92%')
    expect(html).toContain('—')
    expect(html).not.toContain('0%')
  })

  it('採用元と、いつ誰が決めたかを出す', () => {
    const html = ALL()
    expect(html).toContain('回答フォーム')
    expect(html).toContain('来店アンケート')
    expect(html).toContain('この値で固定')
    expect(html).toContain('新しい値で自動更新')
    expect(html).toContain('未確認')
    expect(html).toContain('画面確認')
  })

  it('用途ごとに優先順を並べ、使う・使わないを言う', () => {
    const html = ALL() + renderToStaticMarkup(<MergedDeliveryDialog open priorities={PERSON.deliveryPriorities} revision={PERSON.revision} busy={false} onCancel={() => {}} onSave={() => {}} />)
    expect(html).toContain('一斉配信')
    expect(html).toContain('本店')
    expect(html).toContain('支店')
    expect(html).toContain('使う')
    expect(html).toContain('目的ごとの順位を編集')
  })

  it('読み込んだ版を出す（保存に付けて送るもの）', () => {
    expect(ALL()).toContain('第4版')
  })
})

describe('取得できた0件を「まだありません」と書く', () => {
  it('失敗と同じ文にしない', () => {
    const friends = renderPerson({ ...PERSON, linkedFriends: [] }, View)
    expect(friends).toContain('結び付いている友だちはまだありません。')
    expect(friends).not.toContain('表示できませんでした')

    const values = renderPerson({ ...PERSON, profileValues: [] }, View)
    expect(values).toContain('まだ値はありません。')
    expect(values).toContain('採用した属性：0件')

    const history = renderPerson({ ...PERSON, history: [] }, View)
    expect(history).toContain('まだ履歴はありません。')

    const delivery = renderPerson({ ...PERSON, deliveryPriorities: [] }, View)
    expect(delivery).toContain('優先順はまだ決めていません。')
  })
})

})

describe('配信元を変える窓', () => {
  it('読み込んだ版を見せ、順の入れ替えと使う・使わないを出す', () => {
    const html = renderToStaticMarkup(
      <MergedDeliveryDialog
        open
        priorities={PERSON.deliveryPriorities}
        revision={4}
        busy={false}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    )
    expect(html).toContain('読み込んだのは第4版です')
    expect(html).toContain('上へ')
    expect(html).toContain('下へ')
    expect(html).toContain('使わない')
    expect(html).toMatch(/<button[^>]*>保存する</)
  })

  it('全部を「使わない」にしたら、承知の印がつくまで保存できない', () => {
    const none = PERSON.deliveryPriorities.map((row) => ({ ...row, isActive: false }))
    const html = renderToStaticMarkup(
      <MergedDeliveryDialog
        open
        priorities={none}
        revision={4}
        busy={false}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    )
    expect(html).toContain('この人へはどこからも送れなくなります')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>保存する</)
  })
})

describe('プロフィールの採用値を変える窓', () => {
  const candidates = [{
    fieldKey: 'display_name',
    fieldLabel: 'LINE表示名',
    options: [
      {
        candidateId: `pc_${'a'.repeat(64)}`,
        sourceFriendId: 'friend-identity-left',
        sourceLabel: '支店の友だち情報',
        valuePreview: '見本 161',
        verified: false,
      },
      {
        candidateId: `pc_${'b'.repeat(64)}`,
        sourceFriendId: 'friend-identity-right',
        sourceLabel: '本店の友だち情報',
        valuePreview: '見本 171',
        verified: false,
      },
    ],
  }]

  it('候補を選ぶまで保存できず、画面にはマスク済み値と取得元だけを出す', () => {
    // 共通 Select は Next.js の自動 JSX runtime 前提。SSR 単体試験でも同じ前提を置く。
    vi.stubGlobal('React', React)
    const draft = emptyProfileCandidateDraft(candidates)
    const html = renderToStaticMarkup(
      <MergedProfileDialog
        open
        candidates={candidates}
        draft={draft}
        revision={4}
        busy={false}
        onChange={() => {}}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    )
    expect(html).toContain('統合プロフィールを編集')
    expect(html).toContain('支店の友だち情報：見本 161')
    expect(html).toContain('読み込んだのは第4版です')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>選んだ0項目を保存</)
    expect(html).not.toContain(`pc_${'a'.repeat(64)}`)
    expect(selectedProfileCandidateCount(candidates, draft)).toBe(0)
  })

  it('選んだ候補だけを保存対象にする', () => {
    const draft = {
      ...emptyProfileCandidateDraft(candidates),
      display_name: { optionIndex: '1', updateMode: 'fixed' as const },
    }
    expect(selectedProfileCandidateCount(candidates, draft)).toBe(1)
  })
})

describe('画面のつなぎ', () => {
  const detail = [
    'v8/friends/merged/person.tsx',
    'components/merged-person/use-merged-person.ts',
    'components/merged-person/merged-person-detail-v8.tsx',
  ].map(read).join('\n')
  const row = read('app/users/users-screen.tsx')
  const page = read('app/users/page.tsx')

  it('撮影の押し口と対象面に印を付ける', () => {
    expect(row).toContain('data-qa-open="Hn9eE"')
    expect(detail).toContain('data-design-node="Hn9eE"')
  })

  it('読込・失敗・権限不足は面ごと差し替える', () => {
    for (const kind of ['loading', 'forbidden', 'error']) {
      expect(detail).toContain(`kind="${kind}"`)
    }
  })

  it('保存に読み込んだ版を付ける', () => {
    expect(detail).toContain('expectedRevision: person.revision')
    expect(detail).toContain('api.mergedPeople.updateProfileValues')
    expect(detail).toContain('api.mergedPeople.unlink')
    expect(detail).toContain('元の友だちと過去の履歴は消さず')
  })

  it('同じ画面を二重に作らず、一覧の面を差し替える', () => {
    expect(page).toContain('MergedPersonDetailView')
    expect(page).toContain('openedPersonId')
  })
})
