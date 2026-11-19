// @vitest-environment happy-dom
/*
 * 保存した検索の一覧（タグの「保存した検索」タブ）を描いて押す。
 * 数の帯は API の集計の実値だけ・行の名前は編集へ／ボタンは友だち一覧へ・
 * 条件は名前に直して出す・使用中は削除を止める・3つの絞り込みが一覧に効く。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSearch } from '@line-crm/shared'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

const heldDelete = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.title.startsWith('保存した検索') && props.onConfirm) heldDelete.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})

const net = vi.hoisted(() => ({
  list: vi.fn(),
  marks: vi.fn(),
  scenarios: vi.fn(),
  fields: vi.fn(),
  tags: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      savedSearches: { ...actual.api.savedSearches, list: net.list, delete: net.remove },
      tags: { ...actual.api.tags, list: net.tags },
      supportMarks: { ...actual.api.supportMarks, list: net.marks },
      scenarios: { ...actual.api.scenarios, list: net.scenarios },
      friendFields: { ...actual.api.friendFields, list: net.fields },
    },
  }
})

import { flushListUrlState } from '@/components/shared/list-url-state'
import SearchesTab from './searches-tab'
import { ApiError } from '@/lib/api'

function search(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: 's1', name: 'VIPかつ未契約', scope: 'friends', conditions: { all: [{ kind: 'mark', op: 'eq', value: 'mk1' }], any: [{ kind: 'scenario', op: 'eq', value: 'sc1' }] },
    createdBy: 'staff-1', lineAccountId: 'acc', isShared: false, displayOrder: 0, createdAt: '2026-09-01T00:00:00.000Z',
    matchCount: 12, usedIn: [], canDelete: true,
    ...overrides,
  } as SavedSearch
}
const summary = { total: 3, usedInBroadcasts: 1, zeroMatches: 1, callsThisMonth: 58 }
const rows = () => [...document.querySelectorAll('tbody tr')]
const rowOf = (id: string) => document.querySelector<HTMLElement>(`tbody tr[data-row-id="${id}"]`)!

async function chooseOption(text: string) {
  const listbox = await screen.findByRole('listbox')
  const option = within(listbox).getAllByRole('option').find((item) => item.textContent?.trim().endsWith(text))!
  fireEvent.click(within(option).getByRole('button'))
}

async function openMenu(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `保存した検索「${name}」の操作` }))
  return screen.findAllByRole('menuitem')
}

beforeEach(() => {
  window.history.replaceState(null, '', '/tags?tab=searches')
  flushListUrlState()
  net.list.mockResolvedValue({ success: true, items: [
    search(),
    search({ id: 's2', name: '離脱注意', matchCount: 0, usedIn: [{ kind: 'broadcast', id: 'b1', name: '秋の案内', mode: 'live' }], canDelete: false }),
    search({ id: 's3', name: '未集計の検索', matchCount: null, usedIn: undefined, canDelete: false }),
  ], summary })
  net.marks.mockResolvedValue({ success: true, data: [{ id: 'mk1', name: '要対応' }] })
  net.scenarios.mockResolvedValue({ success: true, data: [{ id: 'sc1', name: '7日間フォロー' }] })
  net.fields.mockResolvedValue({ success: true, data: [] })
  net.tags.mockResolvedValue({ success: true, data: [] })
  net.remove.mockResolvedValue({ success: true, data: null })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('数の帯', () => {
  it('4つの指標をAPIの集計の実値で出し、名前の解決には今のアカウントの口を呼ぶ', async () => {
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    const band = document.querySelector<HTMLElement>('[data-design="KPIs"]')!
    for (const title of ['保存した条件', '配信で使っている', '該当なし', '今月の利用']) expect(within(band).getByText(title)).toBeTruthy()
    expect(band.textContent).toContain('58')
    expect(band.textContent).toContain('友だち一覧で開いた回数')
    expect(net.fields).toHaveBeenCalledWith('acc', undefined, { suppressFeatureDisabledEvent: true })
    expect(net.marks).toHaveBeenCalledWith('acc', { suppressFeatureDisabledEvent: true })
    expect(net.scenarios).toHaveBeenCalledWith({ accountId: 'acc' })
    expect(net.list).toHaveBeenCalledWith('acc', { limit: 50 })
  })

  it('利用回数の記録が無ければ数を作らず、未接続と言う', async () => {
    net.list.mockResolvedValue({ success: true, items: [search()], summary: { ...summary, callsThisMonth: null } })
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    const band = document.querySelector<HTMLElement>('[data-design="KPIs"]')!
    expect(band.textContent).toContain('利用の記録は未接続')
    expect(band.textContent).not.toContain('58')
  })
})

describe('行', () => {
  it('割当済みと未割り当てを、空の状態セルにせず伝える', async () => {
    net.list.mockResolvedValue({ success: true, items: [search(), search({ id: 'unassigned', name: '割当待ち', lineAccountId: null })], summary })
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    expect(within(rowOf('s1')).getByText('割り当て済み')).toBeTruthy()
    expect(within(rowOf('unassigned')).getByText('未割り当て')).toBeTruthy()
  })
  it('行の名前のリンクは編集へ、ボタンは条件を当てた友だち一覧へ。省略しても全文を持つ', async () => {
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    const row = rowOf('s1')
    const name = within(row).getByText('VIPかつ未契約')
    expect(name.closest('a')?.getAttribute('href')).toMatch(/^\/tags\/searches\/edit\?id=s1(&|$)/)
    expect(name.getAttribute('title')).toBe('VIPかつ未契約')
    expect(row.querySelector('[title="条件を確認・編集"]')).toBeNull()
    expect(within(row).getByRole('link', { name: '「VIPかつ未契約」で友だち一覧を開く' }).getAttribute('href')).toMatch(/^\/friends\?savedSearch=s1(&|$)/)
    expect(within(row).getByRole('button', { name: '保存した検索「VIPかつ未契約」の操作' })).toBeTruthy()
  })

  it('閲覧のみには名前の編集リンクと変える操作を出さない', async () => {
    render(<SearchesTab accountId="acc" canEdit={false} />)
    await screen.findByText('VIPかつ未契約')
    expect(within(rowOf('s1')).getByText('VIPかつ未契約').closest('a')).toBeNull()
    const items = (await openMenu('VIPかつ未契約')).map((item) => item.textContent ?? '')
    expect(items.some((text) => text.includes('友だち一覧へ'))).toBe(true)
    for (const label of ['編集', '複製して保存', '削除する']) expect(items.some((text) => text.includes(label))).toBe(false)
  })

  it('行の詳細の条件は対応マーク・シナリオの名前に直し、「かつ」「または」でつなぐ', async () => {
    net.list.mockResolvedValue({ success: true, items: [search({ id: 's4', name: '組み合わせ', conditions: {
      all: [{ kind: 'mark', op: 'eq', value: 'mk1' }, { kind: 'scenario', op: 'eq', value: 'sc1' }],
      any: [{ kind: 'name', op: 'contains', value: '田' }, { kind: 'name', op: 'contains', value: '山' }],
    } as never })], summary })
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('組み合わせ')
    await waitFor(() => expect(net.scenarios).toHaveBeenCalled())
    fireEvent.click(rowOf('s4'))
    const term = await screen.findByText('条件', { selector: 'dt' })
    const value = term.nextElementSibling!
    await waitFor(() => expect(value.textContent).toBe('対応マークが「要対応」 かつ シナリオが「7日間フォロー」 かつ （名前に「田」を含む または 名前に「山」を含む）'))
  })

  it('該当人数と使っている所は返ってきた値で出し、未集計は「—」', async () => {
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    expect(rowOf('s1').textContent).toContain('12人')
    expect(rowOf('s1').textContent).toContain('なし')
    expect(rowOf('s2').textContent).toContain('0人')
    expect(rowOf('s2').textContent).toContain('一斉配信「秋の案内」')
    expect(rowOf('s3').textContent).toContain('—')
    expect(rowOf('s3').textContent).not.toContain('0人')
  })

  it('使用中・使用先が未取得の検索は削除を押せず理由を出し、消せる検索は確認ののち削除の口を呼ぶ', async () => {
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    let del = (await openMenu('離脱注意')).find((item) => item.textContent?.includes('削除する'))!
    expect((del as HTMLButtonElement).disabled).toBe(true)
    expect(del.textContent).toContain('使用中のため削除できません（1 件）')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0))
    del = (await openMenu('未集計の検索')).find((item) => item.textContent?.includes('削除する'))!
    expect((del as HTMLButtonElement).disabled).toBe(true)
    expect(del.textContent).toContain('使用先を確認できないため削除できません')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0))
    del = (await openMenu('VIPかつ未契約')).find((item) => item.textContent?.includes('削除する'))!
    expect((del as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(del)
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(net.remove).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '削除する' })) })
    expect(net.remove).toHaveBeenCalledWith('s1', 'acc')
  })
})

it('アカウント切替後は古い確認から削除しない', async () => {
  const view = render(<SearchesTab accountId="acc" canEdit />)
  await screen.findByText('VIPかつ未契約')
  fireEvent.click((await openMenu('VIPかつ未契約')).find(item => item.textContent?.includes('削除する'))!)
  await screen.findByRole('alertdialog')
  const previous = heldDelete.confirm!
  view.rerender(<SearchesTab accountId="another" canEdit />)
  await act(async () => { await previous() })
  expect(net.remove).not.toHaveBeenCalled()
})

it('キャンセル後は古い確認から削除しない', async () => {
  render(<SearchesTab accountId="acc" canEdit />)
  await screen.findByText('VIPかつ未契約')
  fireEvent.click((await openMenu('VIPかつ未契約')).find(item => item.textContent?.includes('削除する'))!)
  const dialog = await screen.findByRole('alertdialog')
  const previous = heldDelete.confirm!
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await previous() })
  expect(net.remove).not.toHaveBeenCalled()
})

describe('絞り込み', () => {
  it('表は設計の列を持ち、名前の検索・使っている所・該当人数の絞り込みが行に効く', async () => {
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    const heads = [...document.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(heads).toEqual(expect.arrayContaining(['条件名・内容', '該当', '共有', '使っている所', '更新']))
    expect(rows()).toHaveLength(3)

    fireEvent.change(screen.getByPlaceholderText('条件名で探す'), { target: { value: '離脱' } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].textContent).toContain('離脱注意')
    fireEvent.change(screen.getByPlaceholderText('条件名で探す'), { target: { value: '' } })
    await waitFor(() => expect(rows()).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: '使っている所で絞り込む' }))
    await chooseOption('なし')
    // 使用先が未取得の検索は「なし」の一覧から隠さない（隠すと使用中の物を消しにいく）。
    await waitFor(() => expect(rows().map((row) => row.getAttribute('data-row-id'))).toEqual(['s1', 's3']))

    fireEvent.click(screen.getByRole('button', { name: '該当人数で絞り込む' }))
    await chooseOption('1人以上')
    await waitFor(() => expect(rows().map((row) => row.getAttribute('data-row-id'))).toEqual(['s1']))
  })
})


describe('失敗時の日本語と一覧の保持', () => {
  it.each([
    [401, undefined, 'ログイン'],
    [403, undefined, '権限'],
    [409, '先に変更されています。一覧を読み直してください。', '先に変更されています'],
    [429, undefined, '混み合っています'],
    [500, 'D1_ERROR: SELECT secret FROM tenant', '削除に失敗しました'],
  ] as const)('削除のHTTP %sを言い分け、行と再試行を残す', async (status, message, expected) => {
    net.remove.mockRejectedValueOnce(new ApiError(status, message))
    render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('VIPかつ未契約')
    await openMenu('VIPかつ未契約')
    fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(document.body.textContent).toContain(expected))
    expect(document.body.textContent).not.toMatch(/API error|D1_ERROR|SELECT secret/)
    expect(rowOf('s1')).toBeTruthy()
    expect(net.remove).toHaveBeenCalledTimes(1)
  })

  it('読み込みの503に内部文を出さず、再読み込みを残す', async () => {
    net.list.mockRejectedValueOnce(new ApiError(503, 'D1_ERROR: SELECT secret FROM tenant'))
    render(<SearchesTab accountId="acc" canEdit />)
    await waitFor(() => expect(document.body.textContent).toContain('保存した検索の読み込みに失敗しました'))
    expect(document.body.textContent).not.toMatch(/API error|D1_ERROR|SELECT secret/)
    expect(net.list).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('VIPかつ未契約')
    expect(net.list).toHaveBeenCalledTimes(2)
  })
})
