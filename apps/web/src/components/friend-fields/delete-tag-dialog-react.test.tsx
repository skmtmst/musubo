// @vitest-environment happy-dom
/*
 * タグの保管の窓（DeleteTagDialog）を描いて押す。
 * 影響を読むまでは押せない・参照先は0件を出さず未取得は「—」・積んだマイルは残ると言い切る・
 * 公開や下書きの版を行に出す・使用中は理由を言う・保管は読んだ版と影響の版と冪等キーで送る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'

const captured = vi.hoisted(() => ({ archiveClick: undefined as undefined | (() => void) }))
vi.mock('@/components/shared/button', async original => {
  const actual = await original<typeof import('@/components/shared/button')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (React.Children.toArray(props.children).some(child => typeof child === 'string' && child.includes('このタグを保管する'))) captured.archiveClick = props.onClick as () => void
    return <actual.default {...props} />
  } }
})

const net = vi.hoisted(() => ({ dependencies: vi.fn(), archive: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, tags: { ...actual.api.tags, dependencies: net.dependencies, archive: net.archive, delete: net.remove } } }
})

import type { TagDeleteImpactReferences, TagDependencies } from '@/lib/api'
import { DeleteTagDialog } from './tags-page-v4'

const KEYS: Array<keyof TagDeleteImpactReferences> = [
  'broadcasts', 'forms', 'scenarios', 'autoReplies', 'savedSearches', 'automations', 'commonActions', 'richMenus', 'templates',
  'webinars', 'reminders', 'entryRoutes', 'trackedLinks', 'bookingMenus', 'affiliateOffers', 'events', 'analyticsFunnels', 'friendAddSettings',
]
const zero = () => Object.fromEntries(KEYS.map((key) => [key, 0])) as TagDeleteImpactReferences
const tag = { id: 't1', name: 'VIP', color: '#000', friendCount: 7, createdAt: '2026-01-01T00:00:00.000Z', mileageReward: 10 } as Tag
function impact(overrides: Partial<TagDependencies> = {}): TagDependencies {
  return {
    tag: { id: 't1', name: 'VIP', version: 5, status: 'active' }, friendCount: 7, referenceCounts: zero(), references: [],
    linkedActions: [], pendingRunCount: 0,
    mileageImpact: { configured: false, self: 0, referrer: 0, multiplier: null, priority: 0, reapplyPolicy: 'first_only', historyPreserved: true },
    blockingReferenceCount: 0, canArchive: true, canDelete: true, checkedAt: '', revision: 'rev-3',
    ...overrides,
  }
}
const rowValue = (name: string) => [...document.querySelectorAll('[data-qa-dialog="tag-delete"] dl > div')]
  .find((row) => row.querySelector('dt')?.textContent === name)?.querySelector('dd')?.textContent
const archiveButton = () => screen.getByRole('button', { name: 'このタグを保管する' }) as HTMLButtonElement
const confirmInput = () => screen.getByPlaceholderText('VIP') as HTMLInputElement

beforeEach(() => {
  net.dependencies.mockResolvedValue({ success: true, data: impact() })
  net.archive.mockResolvedValue({ success: true, data: null })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('タグの保管の窓', () => {
  it('閉じた窓の確定では保管されない', async () => {
    const onCancel = vi.fn()
    const first = render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={onCancel} onArchived={() => {}} />)
    await waitFor(() => expect(rowValue('参照先')).toBe('なし'))
    fireEvent.change(confirmInput(), { target: { value: 'VIP' } })
    const oldClick = captured.archiveClick!
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    await act(async () => { oldClick(); await Promise.resolve() })
    first.unmount()
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={onCancel} onArchived={() => {}} />)
    await waitFor(() => expect(rowValue('参照先')).toBe('なし'))
    await act(async () => { oldClick(); await Promise.resolve() })
    expect(net.archive).not.toHaveBeenCalled()
    fireEvent.change(confirmInput(), { target: { value: 'VIP' } })
    fireEvent.click(archiveButton())
    await waitFor(() => expect(net.archive).toHaveBeenCalledTimes(1))
  })

  it('保管対象のアカウントと環境を表示する', async () => {
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    expect(screen.getByText('LINEアカウント')).toBeTruthy()
    expect(screen.getByText('環境')).toBeTruthy()
    await waitFor(() => expect(rowValue('参照先')).toBe('なし'))
  })

  it('アカウントを切り替えたら前の影響結果と確認入力では保管できない', async () => {
    net.dependencies.mockResolvedValueOnce({ success: true, data: impact() }).mockReturnValueOnce(new Promise(() => {}))
    const view = render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    await waitFor(() => expect(rowValue('参照先')).toBe('なし'))
    fireEvent.change(confirmInput(), { target: { value: 'VIP' } })
    expect(archiveButton().disabled).toBe(false)
    view.rerender(<DeleteTagDialog tag={tag} accountId="other" onCancel={() => {}} onArchived={() => {}} />)
    expect(confirmInput().value).toBe('')
    fireEvent.click(archiveButton())
    expect(net.archive).not.toHaveBeenCalled()
  })
  // 止まっている理由（footerLead）は、自前の footer を渡す窓では今は描かれていない（報告済み）。ここでは押せないことを見る。
  it('影響を読んでいる間は名前の欄も押し口も止め、参照先は「—」で埋める', async () => {
    net.dependencies.mockReturnValue(new Promise(() => {}))
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    expect(net.dependencies).toHaveBeenCalledWith('t1', 'acc')
    expect(confirmInput().disabled).toBe(true)
    expect(archiveButton().disabled).toBe(true)
    expect(rowValue('参照先')).toBe('—')
    expect(rowValue('参照先（自動）')).toBe('—')
    expect(rowValue('積んだマイル')).toBe('そのまま残る')
  })

  it('影響を読めなければ、名前を打っても押せない', async () => {
    net.dependencies.mockRejectedValue(new Error('down'))
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-qa-dialog="tag-delete"]')?.getAttribute('data-impact')).toBe('error'))
    fireEvent.change(confirmInput(), { target: { value: 'VIP' } })
    expect(archiveButton().disabled).toBe(true)
  })

  it('参照先は18種類すべてを呼び名で出し、0件の種類は出さない（アフィリエイトは手で選ぶ側に数えない）', async () => {
    const refs = Object.fromEntries(KEYS.map((key, index) => [key, index + 1])) as TagDeleteImpactReferences
    refs.forms = 0
    net.dependencies.mockResolvedValue({ success: true, data: impact({ referenceCounts: refs, canDelete: false }) })
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    await waitFor(() => expect(rowValue('参照先')).not.toBe('—'))
    expect(rowValue('参照先')).toBe('一斉配信1・テンプレート9・リッチメニュー8・ウェビナー10・イベント予約16・予約メニュー14・流入経路12・計測リンク13・ファネル17')
    expect(rowValue('参照先（自動）')).toBe('シナリオ3・自動応答4・保存検索5・オートメーション6・共通アクション7・リマインダ11・友だち追加時の配信18')
    expect(rowValue('参照先')).not.toContain('回答フォーム')
    expect(rowValue('参照先')).not.toContain('アフィリエイト')
    expect(screen.getByText('アフィリエイトのオファーで使用中のタグは保管できません')).toBeTruthy()
  })

  it('取得できて参照が無ければ「なし」と書き、消せるタグに赤い警告を出さない', async () => {
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    await waitFor(() => expect(rowValue('参照先')).toBe('なし'))
    expect(rowValue('参照先（自動）')).toBe('なし')
    expect(document.querySelector('[data-qa="tag-delete-blocked-warning"]')).toBeNull()
  })

  it('有効な参照で止まるときは、その理由を出す', async () => {
    net.dependencies.mockResolvedValue({ success: true, data: impact({ referenceCounts: { ...zero(), broadcasts: 2 }, canDelete: false }) })
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    expect(await screen.findByText('有効な参照があるタグは保管できません')).toBeTruthy()
  })

  it('公開・下書きの版があれば「使用中の版」の行を足し、無ければ足さない', async () => {
    net.dependencies.mockResolvedValue({ success: true, data: impact({ linkedActions: [
      { kind: 'common_action', name: 'a', version: 3, state: 'published' },
      { kind: 'common_action', name: 'b', version: 4, state: 'draft' },
    ] }) })
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    await waitFor(() => expect(rowValue('使用中の版')).toBe('公開 第3版・下書き 第4版'))
    expect(screen.getByText('公開している版があるので消せません')).toBeTruthy()
    cleanup()
    net.dependencies.mockResolvedValue({ success: true, data: impact() })
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={() => {}} />)
    await waitFor(() => expect(rowValue('参照先')).toBe('なし'))
    expect(rowValue('使用中の版')).toBeUndefined()
  })

  it('名前を打つまでは押せず、打つと読んだ版・影響の版・冪等キーで保管の口へ送る。削除の口は呼ばない', async () => {
    const onArchived = vi.fn()
    render(<DeleteTagDialog tag={tag} accountId="acc" onCancel={() => {}} onArchived={onArchived} />)
    await waitFor(() => expect(confirmInput().disabled).toBe(false))
    expect(archiveButton().disabled).toBe(true)
    fireEvent.change(confirmInput(), { target: { value: 'VIP' } })
    expect(archiveButton().disabled).toBe(false)
    await act(async () => { fireEvent.click(archiveButton()) })
    expect(net.archive).toHaveBeenCalledWith('t1', 'acc', { expectedVersion: 5, impactRevision: 'rev-3' }, expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(net.remove).not.toHaveBeenCalled()
    expect(onArchived).toHaveBeenCalledWith('「VIP」を保管しました')
  })
})
