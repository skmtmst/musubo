// @vitest-environment happy-dom
/*
 * 対応マークの一覧（rIhbN・vKDj5）を描いて押す。
 * 帯のマークの数は一覧そのものから・使用先の列に人数を重ねない・未取得は「—」・
 * 自動で変わる列はAPIのきまり・絞り込みが効く・保管は影響確認の版と冪等キーで置き換えて送る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportMarkListItem } from '@/lib/api'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

const net = vi.hoisted(() => ({ list: vi.fn(), stats: vi.fn(), impact: vi.fn(), archive: vi.fn(), restore: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      supportMarks: { ...actual.api.supportMarks, list: net.list, archiveImpact: net.impact, archive: net.archive, restore: net.restore },
      listStats: { ...actual.api.listStats, get: net.stats },
    },
  }
})

import { ApiError } from '@/lib/api'
import { flushListUrlState } from '@/components/shared/list-url-state'
import MarksTab from './marks-tab'

function mark(overrides: Partial<SupportMarkListItem> = {}): SupportMarkListItem {
  return {
    id: 'mk1', name: '要対応', color: '#EF4B55', isDefault: false, autoOnInbound: false, displayOrder: 0,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', version: 2, isInherited: false,
    automationRules: [], friendCount: 8, usedIn: { broadcasts: 2, scenarios: 1, autoReplies: 0, savedSearches: 0, automations: 0 },
    ...overrides,
  } as SupportMarkListItem
}
const impact = {
  mark: mark(), friendCount: 8, usedIn: { broadcasts: 0, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 },
  automationRules: [], displayTargets: [], replacementOptions: [{ id: 'mk2', name: '対応中', isDefault: true }],
  canArchive: true, impactRevision: 'rev-7', checkedAt: '2026-10-01T00:00:00+09:00', expectedVersion: 2,
}
const table = () => screen.getByRole('table')
const rowOf = (id: string) => table().querySelector<HTMLElement>(`tbody tr[data-row-id="${id}"]`)!
const cell = (id: string, index: number) => rowOf(id).querySelectorAll('td')[index]!.textContent ?? ''

beforeEach(() => {
  window.history.replaceState(null, '', '/tags?tab=marks')
  flushListUrlState()
  net.list.mockResolvedValue({ success: true, data: [
    mark(),
    mark({ id: 'mk2', name: '対応中', friendCount: 0, usedIn: { broadcasts: 0, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 }, automationRules: [{ id: 'r1', name: '担当が決まったら' } as never] }),
    mark({ id: 'mk3', name: '未取得', friendCount: 0, usedIn: undefined }),
  ] })
  net.stats.mockResolvedValue({ success: true, data: { marks: { unanswered: 5, inProgress: 3, resolved: 2, changedLast7: 9 } } })
  net.impact.mockResolvedValue({ success: true, data: impact })
  net.archive.mockResolvedValue({ success: true, data: { archived: true, replacedFriendCount: 8, replacementMark: null } })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('対応マークの一覧', () => {
  it('保管も含めて今のアカウントの一覧を読み、設計の列を並べる', async () => {
    render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    expect(net.list).toHaveBeenCalledWith('acc', { includeArchived: true })
    const heads = [...table().querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(heads).toEqual(['並び替え', 'マーク', '付いている人', 'はじめの値', '自動で変わる', '出す場所', '操作'])
  })

  it('帯の「マーク」は一覧そのものから数え、人数の3つは受信箱の集計から出す', async () => {
    net.stats.mockResolvedValue({ success: true, data: { marks: { unanswered: 5, inProgress: 3, resolved: 2, changedLast7: 9, total: 99, inUse: 99 } } })
    render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    const band = document.querySelector<HTMLElement>('[data-design="KPIs"], [data-kpi-band]') ?? document.body
    await waitFor(() => expect(band.textContent).toContain('使っている 1'))
    for (const title of ['マーク', '未対応', '対応中', '過去7日の変更']) expect(within(band).getAllByText(title).length).toBeGreaterThan(0)
    expect(band.textContent).toContain('3種類')
    expect(band.textContent).not.toContain('99')
  })

  it('統括の一覧は取得中に0件とせず、取得した配列を反映してから件数を出す', async () => {
    const items = [mark(), mark({ id: 'mk2', name: '対応中' })]
    const host = { items: [] as typeof items, status: 'loading' as const, busy: false, reload: vi.fn(), onCreate: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn(), onDistribute: vi.fn(), onOrder: vi.fn().mockResolvedValue(undefined) }
    const view = render(<MarksTab accountId={null} canEdit host={host} />)
    expect(screen.queryByText('0種類')).toBeNull()
    expect(screen.queryByText('まだ対応マークはありません')).toBeNull()
    view.rerender(<MarksTab accountId={null} canEdit host={{ ...host, items, status: 'ready' }} />)
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('要対応')).toBeTruthy())
    expect(screen.getByRole('table')).toBeTruthy()
    view.rerender(<MarksTab accountId={null} canEdit host={{ ...host, items: [], status: 'loading' }} />)
    expect(screen.queryByText('0種類')).toBeNull()
    expect(screen.queryByText('まだ対応マークはありません')).toBeNull()
  })

  it('出す場所の列は設定からの参照だけを数え、人数を重ねない。未取得は「—」、取得できて0件は「なし」', async () => {
    render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    expect(cell('mk1', 5)).toBe('配信2件・シナリオ1件')
    expect(cell('mk1', 5)).not.toContain('友だち')
    expect(cell('mk2', 5)).toBe('なし')
    expect(cell('mk3', 5)).toBe('—')
  })

  it('自動で変わる列はAPIが返すきまりの名前を出す', async () => {
    render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    expect(cell('mk2', 4)).toBe('担当が決まったら')
    expect(cell('mk1', 4)).toBe('—')
  })

  it('「使っているかで絞り込む」は「すべて」を別の選択肢に持ち、使っていない物だけに絞れる', async () => {
    render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: '使っているかで絞り込む' }))
    const listbox = await screen.findByRole('listbox')
    const options = within(listbox).getAllByRole('option')
    expect(options[0]!.textContent).toContain('すべて')
    fireEvent.click(within(options.find((option) => option.textContent?.trim().endsWith('なし'))!).getByRole('button'))
    await waitFor(() => expect([...table().querySelectorAll('tbody tr')].map((row) => row.getAttribute('data-row-id'))).toEqual(['mk2', 'mk3']))
  })
})

describe('保管', () => {
  it('戻す確認に対象を表示し、アカウントを切り替えた後の古い操作を断る', async () => {
    net.list.mockResolvedValue({ success: true, data: [mark({ archivedAt: '2026-10-01T00:00:00Z' }), mark({ id: 'active', name: '有効' })] })
    const view = render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: /保管/ }))
    await waitFor(() => expect(rowOf('mk1')).toBeTruthy())
    fireEvent.click(within(table()).getByRole('button', { name: '対応マーク「要対応」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '保管から戻す' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    const button = within(dialog).getByRole('button', { name: '保管から戻す' })
    const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
    const old = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    view.rerender(<MarksTab accountId="other" canEdit />)
    view.rerender(<MarksTab accountId="acc" canEdit />)
    old()
    expect(net.restore).not.toHaveBeenCalled()
  })
  it('戻す確認と同じアカウントを送る', async () => {
    net.list.mockResolvedValue({ success: true, data: [mark({ archivedAt: '2026-10-01T00:00:00Z' }), mark({ id: 'active', name: '有効' })] })
    net.restore.mockResolvedValue({ success: false, error: 'test' })
    render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: /保管/ }))
    await waitFor(() => expect(rowOf('mk1')).toBeTruthy())
    fireEvent.click(within(table()).getByRole('button', { name: '対応マーク「要対応」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '保管から戻す' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保管から戻す' }))
    expect(net.restore).toHaveBeenCalledWith('mk1', 'acc', 2)
  })
  async function openArchive() {
    render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    await act(async () => { fireEvent.click(within(table()).getByRole('button', { name: '対応マーク「要対応」の操作' })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '保管する' })) })
    return screen.findByRole('alertdialog', { name: '「要対応」を保管しますか' })
  }

  it('影響を確かめてから、人数と置き換え・履歴を言う fy5dz の窓を出す', async () => {
    const dialog = await openArchive()
    expect(net.impact).toHaveBeenCalledWith('mk1', 'acc')
    expect(dialog.closest('[data-design-node="fy5dz"]')).not.toBeNull()
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    await waitFor(() => expect(dialog.textContent).toContain('いま 8 人に付いています。保管すると、この 8 人は下で選んだマークへ置き換え、履歴に残します。'))
    expect(dialog.textContent).not.toContain('対応マークが未設定へ戻ります')
  })

  it('確定すると、選んだ置き換え先・影響確認の版・読んだ版・冪等キーで保管の口へ送る', async () => {
    const dialog = await openArchive()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '置き換えて保管する' }).hasAttribute('disabled')).toBe(false))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '置き換えて保管する' })) })
    expect(net.archive).toHaveBeenCalledWith('mk1', 'acc', { replacementMarkId: 'mk2', impactRevision: 'rev-7', expectedVersion: 2 }, expect.stringMatching(/^[0-9a-f-]{36}$/))
  })

  it('保管確認中にアカウントを切り替えたら古い窓から送らない', async () => {
    const view = render(<MarksTab accountId="acc" canEdit />)
    await screen.findByRole('table')
    fireEvent.click(within(table()).getByRole('button', { name: '対応マーク「要対応」の操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '保管する' }))
    const dialog = await screen.findByRole('alertdialog', { name: '「要対応」を保管しますか' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '置き換えて保管する' }).hasAttribute('disabled')).toBe(false))
    const confirm = within(dialog).getByRole('button', { name: '置き換えて保管する' })
    view.rerender(<MarksTab accountId="other" canEdit />)
    fireEvent.click(confirm)
    expect(net.archive).not.toHaveBeenCalled()
  })

  it('保管の失敗はAPIの文言を出さず、読み直してからもう一度と言う', async () => {
    net.archive.mockRejectedValue(new ApiError(500, 'internal: d1 locked'))
    const dialog = await openArchive()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '置き換えて保管する' }).hasAttribute('disabled')).toBe(false))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '置き換えて保管する' })) })
    expect(await within(dialog).findByText('対応マークを保管できませんでした。状態を読み直してから、もう一度お試しください。')).toBeTruthy()
    expect(document.body.textContent).not.toContain('d1 locked')
  })
})
