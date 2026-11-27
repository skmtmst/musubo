// @vitest-environment happy-dom
/* タグ一覧のフォルダ、絞り込み、件数、読み込み状態を現役V8で確かめる。 */
import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { flushListUrlState } from '@/components/shared/list-url-state'
import type { Tag, TagGroup } from '@line-crm/shared'

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const state = vi.hoisted(() => ({
  tags: null as null | (() => Promise<unknown>),
  groups: null as null | (() => Promise<unknown>),
  updateGroup: vi.fn(async () => ({ success: true, data: null })),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      tags: {
        ...actual.api.tags,
        list: (...args: unknown[]) => state.tags!(),
        reorder: vi.fn(async () => ({ success: true as const, data: null })),
        update: vi.fn(async () => ({ success: true as const, data: null })),
      },
      tagGroups: {
        ...actual.api.tagGroups,
        update: state.updateGroup,
        list: (...args: unknown[]) => state.groups!(),
      },
      listStats: {
        ...actual.api.listStats,
        get: vi.fn(async () => ({ success: false as const, error: 'unused' })),
      },
      featureSettings: {
        ...actual.api.featureSettings,
        visibility: vi.fn(async () => ({
          success: true as const,
          data: { features: { friend_fields: true, support_marks: true, saved_searches: true } },
        })),
      },
    },
  }
})

vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))

import TagsList from '@/v8/tags/list'

const LONG_FOLDER = 'とても長いフォルダ名のテスト用フォルダ0123456789'

const ITEMS: Tag[] = [
  {
    id: 't1', name: 'EC顧客連携済み', color: '#3B82F6', groupId: 'g1',
    friendCount: 5, assignSource: 'ec', createdAt: '2026-01-13T00:00:00.000Z',
    lineAccountId: 'account-a', status: 'active',
  },
  {
    id: 't2', name: '未契約', color: '#8b938d', groupId: null,
    friendCount: 0, createdAt: '2026-01-13T00:00:00.000Z',
    lineAccountId: 'account-a', status: 'active',
  },
]

const GROUPS: TagGroup[] = [
  { id: 'g1', accountId: 'account-a', name: LONG_FOLDER, sortOrder: 0, color: '#3B82F6', createdAt: '', updatedAt: '' },
]

afterEach(() => {
  cleanup()
  flushListUrlState()
  window.history.replaceState(null, '', '/tags')
  vi.restoreAllMocks()
})

describe('m21o タグ一覧のフォルダ欄と件数', () => {
  it('フォルダは文字だけで、選び直し欄を行に置かない', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    // 長い名前は全文を重ねて読める（title）。表と狭幅カードの両方に出る。
    const titled = screen.getAllByTitle(LONG_FOLDER)
    expect(titled.length).toBeGreaterThan(0)
    expect(titled[0].textContent).toContain(LONG_FOLDER)
    // 未分類も文字で出る。
    expect(screen.getAllByTitle('未分類').length).toBeGreaterThan(0)
    // 行ごとの選び直し欄は無い。編集画面の「所属フォルダ」で変える。
    expect(screen.queryByRole('button', { name: 'EC顧客連携済み のフォルダ' })).toBeNull()
    expect(screen.queryByRole('button', { name: '未契約 のフォルダ' })).toBeNull()
  })

  it('付け方は1行で、全文は重ねて読める', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    const labeled = screen.getAllByTitle('EC 連携')
    expect(labeled.length).toBeGreaterThan(0)
    expect(labeled[0].textContent).toContain('EC 連携')
  })

  it('件数は表の下のページ送りに出て、フォルダには内訳を出す', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    expect(screen.getAllByText('2件中 1〜2件')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'すべて 2' })).toBeTruthy()
    expect(screen.queryByText('タグ数')).toBeNull()
  })

  it('表示件数とよく使う絞り込みは道具の段にあり、件数は表の下に出る', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    const pager = screen.getByRole('button', { name: '表示件数' })
    const menu = screen.getByRole('button', { name: 'よく使う絞り込み' })
    const flow = pager.closest('[data-list-toolbar]')
    expect(flow).not.toBeNull()
    expect(flow!.contains(menu)).toBe(true)
    expect(flow!.contains(screen.getByText('2件中 1〜2件'))).toBe(false)
  })

  it('「よく使う」は重ねて選べ、絞り込みに効く', async () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'よく使う絞り込み' })) })
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '未使用のタグ' })) })
    expect(await screen.findByRole('button', { name: 'よく使う絞り込み（1 件選択中）' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('EC顧客連携済み')).toBeNull())
    expect(screen.getAllByText('未契約').length).toBeGreaterThan(0)
    // 選んだ条件をもう一度開いて外すと全件に戻る。
    fireEvent.click(screen.getByRole('button', { name: 'よく使う絞り込み（1 件選択中）' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'すべて外す' }))
    expect(await screen.findByText('EC顧客連携済み')).toBeTruthy()
  })

  describe('V8の列と選び口（幅の検査はブラウザで行う）', () => {
    it('行の操作から、そのタグの編集へ進める', async () => {
      render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
      const row = screen.getAllByRole('row').find(row => within(row).queryByText('EC顧客連携済み'))!
      const actions = within(row).getAllByRole('button', { name: 'タグ「EC顧客連携済み」の操作' })
      expect(actions).toHaveLength(1)
      fireEvent.click(actions[0])
      const link = await screen.findByRole('menuitem', { name: '編集する', exact: true })
      const destination = new URL(link.getAttribute('href')!, 'https://fixture.invalid')
      expect(destination.pathname).toBe('/tags/edit')
      expect(destination.searchParams.get('id')).toBe('t1')
    })

    it('行には付け方と所属フォルダの全文を残す', () => {
      render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
      const row = screen.getAllByRole('row').find(row => within(row).queryByText('EC顧客連携済み'))!
      expect(within(row).getByTitle('EC 連携').textContent).toContain('EC 連携')
      expect(within(row).getByTitle(`フォルダ：${LONG_FOLDER}`).getAttribute('title')).toBe(`フォルダ：${LONG_FOLDER}`)
      expect(within(row).queryByRole('button', { name: 'EC顧客連携済み のフォルダ' })).toBeNull()
    })

    it('「よく使う」を開くと4条件を選べる', async () => {
      render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
      fireEvent.click(screen.getByRole('button', { name: 'よく使う絞り込み' }))
      for (const name of ['未使用のタグ', '今月増えたタグ', '自動付与あり', '連動あり']) {
        expect(await screen.findByRole('menuitem', { name, exact: true })).toBeTruthy()
      }
    })
  })

  it('作る入口からタグの作成へ進める', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    const links = screen.getAllByRole('link', { name: 'タグを作る', exact: true })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link.getAttribute('href')).toBe('/tags/new')
  })

  it('見出しの操作にはCSVで一括登録があり、タグの作成を重ねない', () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    const actions = document.querySelector('[data-template-region="heading"]')!
    expect(actions).toBeTruthy()
    expect(within(actions as HTMLElement).getByRole('button', { name: 'CSVで一括登録する', exact: true })).toBeTruthy()
    expect(within(actions as HTMLElement).queryByRole('link', { name: 'タグを作る', exact: true })).toBeNull()
  })

  it('畳まれたフォルダ選択から名前と色の編集を開き、同じAPIへ保存する', async () => {
    render(<TagsList accountId="account-a" fixture={{ items: ITEMS, groups: GROUPS }} />)
    fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true }))
    fireEvent.click(within(await screen.findByRole('option', { name: 'フォルダを管理' })).getByRole('button'))
    const dialog = await screen.findByRole('dialog', { name: 'フォルダを管理' })
    fireEvent.click(within(dialog).getByRole('button', { name: `フォルダ「${LONG_FOLDER}」の操作` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '名前を変更する' }))
    const edit = await screen.findByRole('dialog', { name: 'フォルダを編集する' })
    expect(within(edit).getByText('色')).toBeTruthy()
    fireEvent.change(within(edit).getByLabelText('フォルダ名'), { target: { value: '変更したフォルダ' } })
    fireEvent.click(within(edit).getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(state.updateGroup).toHaveBeenCalledWith('g1', { name: '変更したフォルダ', color: '#3B82F6', accountId: 'account-a' }))
  })

  it('空のときは「まだタグがありません」と出す', () => {
    // 表と狭幅カードの両方に同じ案内が出る。
    render(<TagsList accountId="account-a" fixture={{ items: [], groups: [] }} />)
    expect(screen.getAllByText('まだタグがありません').length).toBeGreaterThan(0)
  })

  it('読み込み中と失敗を言い分ける', async () => {
    let resolveList!: (value: unknown) => void
    state.tags = () => new Promise((resolve) => { resolveList = resolve })
    state.groups = async () => ({ success: true, data: [] })
    render(<TagsList accountId="account-a" />)
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull())
    resolveList({ success: true, data: [] })
    expect((await screen.findAllByText('まだタグがありません')).length).toBeGreaterThan(0)
    cleanup()

    state.tags = async () => ({ success: false, error: 'boom' })
    render(<TagsList accountId="account-a" />)
    expect((await screen.findAllByText('タグを読み込めませんでした')).length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(screen.queryByText('まだタグがありません')).toBeNull()
    })
  })
})
