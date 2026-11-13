// @vitest-environment happy-dom
/*
 * 友だち詳細「配信の受け取り」（mAbif）：目的ごとの状態・理由は必須・本人が止めた宣伝を戻すときの注意の窓・閲覧のみ。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/api/helpers/friend-delivery-consents', () => ({ friendDeliveryConsentsApi: api, friendDeliveryConsentHistoryApi: { list: api.history } }))

const { default: Drawer, useDeliveryConsents } = await import('./delivery-consent')

const row = (purpose: string, state: string, source: string, version = 1) => ({ purpose, state, reason: '本人の操作', source, updatedBy: null, updatedAt: '2026-10-12T05:05:00.000Z', version })
const ROWS = [row('transaction', 'granted', 'manual'), row('marketing', 'revoked', 'liff', 3)]

beforeEach(() => {
  api.save.mockResolvedValue({ success: true, data: ROWS })
  api.history.mockResolvedValue({ success: true, data: { total: 1, nextCursor: null, items: [{ id: 1, purpose: 'marketing', operation: 'update', before: { state: 'granted', reason: '', source: 'manual', updatedBy: null, updatedAt: '', version: 2 }, after: { state: 'revoked', reason: '本人の操作', source: 'liff', updatedBy: null, updatedAt: '', version: 3 }, actor: { kind: 'self', id: null }, reason: '本人の操作', createdAt: '2026-10-12T05:05:00.000Z' }] } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const open = (canEdit = true) => render(<Drawer open friendId="f1" friendName="見本 143" rows={ROWS as never} canEdit={canEdit} onClose={() => {}} onSaved={() => {}} />)

describe('配信の受け取り', () => {
  it('4つの目的ごとに状態を出す。記録が無い目的は「不明」', async () => {
    open()
    expect((await screen.findAllByText('予約の連絡')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('受け取る').length).toBeGreaterThan(0)
    expect(screen.getByText('止めている')).toBeTruthy()
    expect(screen.getAllByText('不明').length).toBe(2)
  })

  it('理由が空なら保存せず、欄の下に理由を出す', async () => {
    open()
    fireEvent.click((await screen.findAllByRole('button', { name: '変える' }))[0])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    expect(await screen.findByText('理由を入れてください。')).toBeTruthy()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('目的を変えるときは、版（なければ 0）と理由を添えて保存する', async () => {
    open()
    fireEvent.click((await screen.findAllByRole('button', { name: '変える' }))[0])
    fireEvent.click(screen.getByLabelText('止めている', { selector: 'input' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '電話でご連絡' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('f1', 'transaction', { state: 'revoked', reason: '電話でご連絡', expectedVersion: 1 }))
  })

  it('本人が止めた宣伝を「受け取る」に戻すときは、注意の窓を挟み、確かめてから保存する', async () => {
    open()
    const buttons = await screen.findAllByRole('button', { name: '変える' })
    fireEvent.click(buttons[2])
    fireEvent.click(screen.getByLabelText('受け取る', { selector: 'input' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '来店時に了承を得た' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog', { name: /本人が止めた宣伝/ }))
    expect(dialog.textContent).toContain('お客さまの意思に反して')
    expect(api.save).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '受け取るに戻す' })) })
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('f1', 'marketing', { state: 'granted', reason: '来店時に了承を得た', expectedVersion: 3 }))
  })

  it('注意を開いてから版が変われば新しい版で勝手に上書きしない', async () => {
    const view = open()
    fireEvent.click((await screen.findAllByRole('button', { name: '変える' }))[2])
    fireEvent.click(screen.getByLabelText('受け取る', { selector: 'input' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '来店時に了承' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    const dialog = await screen.findByRole('alertdialog')
    view.rerender(<Drawer open friendId="f1" friendName="山田 花子" rows={[row('transaction', 'granted', 'manual'), row('marketing', 'revoked', 'liff', 4)] as never} canEdit onClose={() => {}} onSaved={() => {}} />)
    fireEvent.click(within(dialog).getByRole('button', { name: '受け取るに戻す' }))
    await waitFor(() => expect(api.save.mock.calls.every(call => call[2].expectedVersion !== 4)).toBe(true))
  })

  it('注意を開いてから友だちが変われば別の友だちへ送らない', async () => {
    const view = open()
    fireEvent.click((await screen.findAllByRole('button', { name: '変える' }))[2])
    fireEvent.click(screen.getByLabelText('受け取る', { selector: 'input' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '来店時に了承' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('alertdialog')
    view.rerender(<Drawer open friendId="f2" friendName="別の友だち" rows={ROWS as never} canEdit onClose={() => {}} onSaved={() => {}} />)
    const old = screen.queryByRole('alertdialog')
    if (old) fireEvent.click(within(old).getByRole('button', { name: '受け取るに戻す' }))
    await waitFor(() => expect(api.save).not.toHaveBeenCalled())
  })

  it('本人のアカウントが不明なときに選択中の別アカウントを代わりに使わない', async () => {
    render(<Drawer open friendId="f1" friendName="山田 花子" friendAccountId={null} selectedAccountId="other" rows={ROWS as never} canEdit onClose={() => {}} onSaved={() => {}} />)
    fireEvent.click((await screen.findAllByRole('button', { name: '変える' }))[2])
    fireEvent.click(screen.getByLabelText('受け取る', { selector: 'input' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '来店時に了承' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('山田 花子')
    expect(dialog.textContent).toContain('不明')
    expect(dialog.textContent).toContain('環境')
    expect(dialog.textContent).not.toContain('other')
  })

  it('選択アカウントを変えて戻しても古い確認は復活しない', async () => {
    const props = { open: true, friendId: 'f1', friendName: '山田 花子', friendAccountId: 'owner', rows: ROWS as never, canEdit: true, onClose: () => {}, onSaved: () => {} }
    const view = render(<Drawer {...props} selectedAccountId="a" />)
    fireEvent.click((await screen.findAllByRole('button', { name: '変える' }))[2])
    fireEvent.click(screen.getByLabelText('受け取る', { selector: 'input' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '来店時に了承' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('alertdialog')
    view.rerender(<Drawer {...props} selectedAccountId="b" />)
    view.rerender(<Drawer {...props} selectedAccountId="a" />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('閲覧のみの人には、［変える］を置かない', async () => {
    open(false)
    await screen.findAllByText('予約の連絡')
    expect(screen.queryByRole('button', { name: '変える' })).toBeNull()
  })
})

describe('履歴（前 → 後）', () => {
  it('口の履歴から、前の値・後の値・だれが変えたかを出す', async () => {
    open()
    expect(await screen.findByText('受け取る → 止めている')).toBeTruthy()
    expect(screen.getByText('本人')).toBeTruthy()
    expect(api.history).toHaveBeenCalledWith('f1', { limit: 20 })
  })
})

it('友だちを切り替えた後に古い受け取り設定の応答を表示しない', async () => {
  let finishOld: (value: unknown) => void = () => {}
  api.list.mockImplementation((friendId: string) => friendId === 'f1'
    ? new Promise(resolve => { finishOld = resolve })
    : Promise.resolve({ success: true, data: [row('marketing', 'granted', 'manual', 9)] }))
  const hook = renderHook(({ friendId }) => useDeliveryConsents(friendId), { initialProps: { friendId: 'f1' } })
  hook.rerender({ friendId: 'f2' })
  await waitFor(() => expect(hook.result.current.rows[0]?.version).toBe(9))
  await act(async () => { finishOld({ success: true, data: [row('marketing', 'revoked', 'liff', 3)] }) })
  expect(hook.result.current.rows[0]?.version).toBe(9)
})
