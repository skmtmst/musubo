import { ApiError } from '@/lib/api'
import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * 回数券・月謝を作る（B2-2）：入力の確かめ・下書き保存・作る（販売を始める）・口が無い所の窓・閲覧のみ。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), save: vi.fn(), start: vi.fn() }))
const env = vi.hoisted(() => ({ role: 'owner' as string | null, push: vi.fn(), search: '' }))
vi.mock('@/lib/api/helpers/gap3', () => ({ bookingPassPlansApi: api }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: env.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/booking/passes/new',
  useSearchParams: () => new URLSearchParams(env.search),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => env.role }))
vi.mock('@/components/shared/entity-remote-field', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/entity-remote-field')>()),
  loadEntityCandidates: async () => [{ id: 'm1', name: 'ヨガ（初級）' }, { id: 'm2', name: '朝ヨガ' }],
}))

const { default: PassCreateV8 } = await import('./create')

const PLAN = { id: 'p-new', kind: 'ticket', name: 'ヨガ 10 回券', price: 15000, count: 10, monthlyLimit: null, validDays: 180, menuIds: [], allowWithoutPass: true, status: 'draft', version: 1 }

beforeEach(() => {
  env.role = 'owner'; env.search = ''
  api.create.mockResolvedValue({ success: true, data: PLAN })
  api.save.mockResolvedValue({ success: true, data: { ...PLAN, version: 2 } })
  api.start.mockResolvedValue({ success: true, data: { status: 'on_sale', version: 2 } })
  api.list.mockResolvedValue({ success: true, data: { items: [PLAN], total: 1, summary: {} } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const fill = (name: string, price: string) => {
  fireEvent.change(screen.getByLabelText('名前'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('値段'), { target: { value: price } })
}

describe('回数券・月謝を作る', () => {
  it('名前と値段が空なら、欄の下に理由を出して送らない', async () => {
    render(<PassCreateV8 />)
    await screen.findByLabelText('名前')
    await act(async () => { fireEvent.click(getPageAction({ name: '下書き保存' })) })
    expect(await screen.findByText('名前を入れてください。')).toBeTruthy()
    expect(screen.getByText('0 以上の整数（円）を入れてください。')).toBeTruthy()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('下書き保存は種類・名前・値段・回数・期限・使える予約を下書きとして保存して一覧へ戻る', async () => {
    render(<PassCreateV8 />)
    await screen.findByLabelText('名前')
    fill('ヨガ 10 回券', '15000')
    await act(async () => { fireEvent.click(getPageAction({ name: '下書き保存' })) })
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('a', {
      kind: 'ticket', name: 'ヨガ 10 回券', price: 15000, count: 10, monthlyLimit: null, validDays: 180, menuIds: [], allowWithoutPass: true,
    }, expect.any(String)))
    expect(api.start).not.toHaveBeenCalled()
    await waitFor(() => expect(env.push).toHaveBeenCalledWith('/booking/menus?tab=passes'))
  })

  it('月謝は「1 か月の回数」を送り、回数は null にする', async () => {
    render(<PassCreateV8 />)
    await screen.findByLabelText('名前')
    fireEvent.click(screen.getByRole('button', { name: '月謝' }))
    fill('ヨガ 月 4 回', '9800')
    await act(async () => { fireEvent.click(getPageAction({ name: '下書き保存' })) })
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('a', expect.objectContaining({ kind: 'monthly', count: null, monthlyLimit: 4 }), expect.any(String)))
  })

  it('［作る］は確かめの窓を出し、確かめたあとで保存して販売を始める', async () => {
    render(<PassCreateV8 />)
    await screen.findByLabelText('名前')
    fill('ヨガ 10 回券', '15000')
    fireEvent.click(screen.getByRole('button', { name: '作る' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('変えられません')
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    expect(api.create).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '販売を始める' })) })
    await waitFor(() => expect(api.start).toHaveBeenCalledWith('a', 'p-new', 1))
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it('LINE で売る（オンライン決済）は口が無いので「現在準備中です」の窓を出す', async () => {
    render(<PassCreateV8 />)
    await screen.findByLabelText('名前')
    const step4 = screen.getByRole('region', { name: '4 LINE で売る' })
    fireEvent.click(within(step4).getByRole('button', { name: '変える' }))
    expect((await screen.findByRole('dialog')).textContent).toContain('現在準備中です')
  })

  it('閲覧のみの人には、保存・作るの帯を置かない', async () => {
    env.role = 'staff'
    render(<PassCreateV8 />)
    await screen.findByLabelText('名前')
    expect(screen.queryByRole('button', { name: '下書き保存' })).toBeNull()
    expect(screen.queryByRole('button', { name: '作る' })).toBeNull()
  })

  it('直すとき（?id=）は、下書きの種類だけ読み込み、版を添えて保存する。販売を始めた券は直せない', async () => {
    env.search = 'id=p-new'
    render(<PassCreateV8 />)
    await waitFor(() => expect((screen.getByLabelText('名前') as HTMLInputElement).value).toBe('ヨガ 10 回券'))
    await act(async () => { fireEvent.click(getPageAction({ name: '下書き保存' })) })
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('a', 'p-new', expect.objectContaining({ expectedVersion: 1 })))
    cleanup()
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...PLAN, status: 'on_sale' }], total: 1, summary: {} } })
    render(<PassCreateV8 />)
    expect(await screen.findByText('この回数券・月謝は直せません')).toBeTruthy()
  })
})

it('作成後の販売開始だけが失敗した時は窓と入力を保ち、同じ版の開始だけを再試行する', async () => {
  api.start.mockRejectedValueOnce(new Error('通信に失敗しました。'))
  render(<PassCreateV8 />)
  const name = await screen.findByLabelText('名前')
  fill('ヨガ 10 回券', '15000')
  fireEvent.click(screen.getByRole('button', { name: '作る' }))
  const dialog = await screen.findByRole('dialog')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '販売を始める' })) })
  expect(api.create).toHaveBeenCalledTimes(1)
  expect(api.start).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(name).toHaveProperty('value', 'ヨガ 10 回券')
  expect(screen.getByLabelText('値段')).toHaveProperty('value', '15000')
  expect(within(dialog).getByRole('alert').textContent).toBeTruthy()
  expect(env.push).not.toHaveBeenCalled()
  await act(async () => {
    const retry = within(dialog).getByRole('button', { name: 'もう一度' })
    fireEvent.click(retry); fireEvent.click(retry)
  })
  expect(api.create).toHaveBeenCalledTimes(1)
  expect(api.save).not.toHaveBeenCalled()
  expect(api.start.mock.calls).toEqual([['a', 'p-new', 1], ['a', 'p-new', 1]])
  expect(env.push).toHaveBeenCalledTimes(1)
})

it('作成の応答を確認できない時も窓を残し、同じ要求キーで一度だけ再送する', async () => {
  api.create.mockRejectedValueOnce(new TypeError('fetch failed'))
  render(<PassCreateV8 />)
  await screen.findByLabelText('名前')
  fill('ヨガ 10 回券', '15000')
  fireEvent.click(screen.getByRole('button', { name: '作る' }))
  const dialog = await screen.findByRole('dialog')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '販売を始める' })) })
  expect(api.start).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBe(dialog)
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度' })) })
  expect(api.create).toHaveBeenCalledTimes(2)
  expect(api.create.mock.calls[0]).toEqual(api.create.mock.calls[1])
  expect(api.start).toHaveBeenCalledTimes(1)
})


it('項目の理由を確認の窓にも出し、入力を直すまで再送せず、戻ると入力と欄の理由が残る', async () => {
  api.create.mockRejectedValueOnce(new ApiError(422, '入力を確認してください。', undefined, undefined, undefined, undefined, { name: 'この名前は既に使われています。' }))
  render(<PassCreateV8 />)
  const name = await screen.findByLabelText('名前')
  fill('ヨガ 10 回券', '15000')
  fireEvent.click(screen.getByRole('button', { name: '作る' }))
  const dialog = await screen.findByRole('dialog')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '販売を始める' })) })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(within(dialog).getByRole('alert').textContent).toContain('この名前は既に使われています。')
  expect(name).toHaveProperty('value', 'ヨガ 10 回券')
  const retry = within(dialog).getByRole('button', { name: 'もう一度' })
  expect(retry).toHaveProperty('disabled', true)
  fireEvent.click(retry)
  expect(api.create).toHaveBeenCalledTimes(1)
  expect(api.start).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '戻って直す' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(name).toHaveProperty('value', 'ヨガ 10 回券')
  expect(screen.getByText('この名前は既に使われています。')).toBeTruthy()
  fireEvent.change(name, { target: { value: 'ヨガ 12 回券' } })
  fireEvent.click(screen.getByRole('button', { name: '作る' }))
  const corrected = await screen.findByRole('dialog')
  expect(within(corrected).getByRole('button', { name: '販売を始める' })).toHaveProperty('disabled', false)
})

it('回数券の販売確認を閉じた後は古い確定から販売しない', async () => {
  render(<PassCreateV8 />)
  await screen.findByLabelText('名前')
  fill('ヨガ 10 回券', '15000')
  fireEvent.click(screen.getByRole('button', { name:'作る' }))
  const dialog = within(await screen.findByRole('dialog'))
  const button = dialog.getByRole('button',{name:'販売を始める'})
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const held = (button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
  fireEvent.click(dialog.getByRole('button',{name:'キャンセル'}))
  await act(async () => { await held({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(api.create).not.toHaveBeenCalled()
  expect(api.start).not.toHaveBeenCalled()
})

it('回数券の内容を変えて戻しても古い販売確認を使わない', async () => {
  render(<PassCreateV8 />)
  await screen.findByLabelText('名前')
  fill('ヨガ 10 回券', '15000')
  const price = screen.getByLabelText('値段')
  fireEvent.click(screen.getByRole('button', { name:'作る' }))
  const dialog = within(await screen.findByRole('dialog'))
  const button = dialog.getByRole('button',{name:'販売を始める'})
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const held = (button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
  fireEvent.change(price,{target:{value:'16000'}})
  fireEvent.change(price,{target:{value:'15000'}})
  await act(async () => { await held({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(api.create).not.toHaveBeenCalled()
  expect(api.start).not.toHaveBeenCalled()
})
