// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ create: vi.fn(), version: vi.fn(), get: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: {
  conversions: { definitions: async () => ({ success: true, data: { items: [{ id: 'point-1', name: '購入' }] } }) },
  tags: { list: async () => ({ success: true, data: [] }) },
  forms: { list: async () => ({ success: true, data: [] }) },
  analytics: { v6Funnels: { create: net.create, createVersion: net.version, get: net.get } },
} }))
import FunnelFormV8 from './funnel-form'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  net.create.mockReset().mockResolvedValue({ success: false, error: '通信を確認してください' })
  net.version.mockReset()
  net.get.mockReset()
})
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

it('入力不足は欄だけで知らせ、名前→段の名前→条件へ移り、保存しない', async () => {
  render(<FunnelFormV8 accountId="account-1" onCancel={() => {}} onCreated={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  const name = screen.getByLabelText('名前', { exact: true })
  await waitFor(() => expect(document.activeElement).toBe(name))
  expect(name.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getAllByText('名前を入力してください')).toHaveLength(1)
  expect(document.querySelector('[data-design-part="dialog"] > [role="alert"]')).toBeNull()
  fireEvent.change(name, { target: { value: '購入まで' } })
  fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('段1の名前')))
  fireEvent.change(screen.getByLabelText('段1の名前'), { target: { value: '友だち追加' } })
  fireEvent.change(screen.getByLabelText('段2の名前'), { target: { value: '購入' } })
  fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  const choice = screen.getByRole('button', { name: '2段目で何をしたら進むか' })
  await waitFor(() => expect(document.activeElement).toBe(choice))
  expect(choice.getAttribute('aria-invalid')).toBe('true')
  expect(net.create).not.toHaveBeenCalled()
})

it('入力が揃えば同じ条件で保存し、通信の失敗は窓の帯で知らせる', async () => {
  render(<FunnelFormV8 accountId="account-1" presetConversion={{ id: 'point-1', name: '購入' }} onCancel={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText('名前', { exact: true }), { target: { value: '購入まで' } })
  fireEvent.change(screen.getByLabelText('段1の名前'), { target: { value: '友だち追加' } })
  fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  await waitFor(() => expect(net.create).toHaveBeenCalledWith('account-1', {
    name: '購入まで', windowDays: 30,
    steps: [{ label: '友だち追加', kind: 'friend_add', match: {} }, { label: '購入', kind: 'conversion', match: { conversionPointId: 'point-1' } }],
  }))
  expect((await screen.findByRole('alert')).textContent).toContain('通信を確認してください')
  expect(document.querySelector('input[aria-invalid="true"]')).toBeNull()
})

it('編集の競合で入力と版を保ち、比較は読むだけ、最新の読み込みを選んだときだけ置き換える', async () => {
  const edit = { funnelId: 'fn1', name: '元の名前', windowDays: '30', steps: [
    { label: '友だち追加', kind: 'friend_add', value: '', match: {} },
    { label: '購入', kind: 'purchase', value: '', match: {} },
  ], segment: null, comparisonGroups: [], expectedVersionNumber: 1 }
  net.version.mockResolvedValue({ success: false, error: 'analytics_funnel_version_conflict' })
  net.get.mockResolvedValue({ success: true, data: { id: 'fn1', name: '別の担当者の名前', currentVersion: {
    versionNumber: 2, windowDays: 90, steps: edit.steps, segment: { tag: 'latest' }, comparisonGroups: [],
  } } })
  render(<FunnelFormV8 accountId="account-1" edit={edit} onCancel={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText('名前', { exact: true }), { target: { value: '自分の入力' } })
  fireEvent.click(screen.getByRole('button', { name: '新版として保存する' }))
  await screen.findByText('ほかの人が先にこのファネルを保存しました')
  expect(net.get).not.toHaveBeenCalled()
  expect((screen.getByLabelText('名前', { exact: true }) as HTMLInputElement).value).toBe('自分の入力')
  fireEvent.click(screen.getByRole('button', { name: '違いを比べる' }))
  await screen.findByText(/最新の内容：別の担当者の名前/)
  expect((screen.getByLabelText('名前', { exact: true }) as HTMLInputElement).value).toBe('自分の入力')
  fireEvent.click(within(screen.getByRole('dialog', { name: '最新の保存と比べる' })).getByRole('button', { name: 'キャンセル', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '最新の保存と比べる' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '最新を読み込んで続ける' }))
  await waitFor(() => expect((screen.getByLabelText('名前', { exact: true }) as HTMLInputElement).value).toBe('別の担当者の名前'))
  fireEvent.click(screen.getByRole('button', { name: '新版として保存する' }))
  await waitFor(() => expect(net.version).toHaveBeenLastCalledWith('account-1', 'fn1', expect.objectContaining({ expectedVersionNumber: 2, segment: { tag: 'latest' } })))
})

it('新版の保存後も編集を保ち、続けて保存すると新しい版を添える', async () => {
  const done = vi.fn()
  net.version.mockResolvedValue({ success: true, data: { id: 'v2', versionNumber: 2 } })
  render(<FunnelFormV8 accountId="account-1" edit={{ funnelId: 'fn1', name: '編集中', windowDays: '30', steps: [
    { label: '入口', kind: 'friend_add', value: '', match: {} },
    { label: '購入', kind: 'purchase', value: '', match: {} },
  ], segment: null, comparisonGroups: [], expectedVersionNumber: 1 }} onCancel={() => {}} onCreated={done} />)
  fireEvent.click(screen.getByRole('button', { name: '新版として保存する' }))
  await waitFor(() => expect(done).toHaveBeenCalledOnce())
  await waitFor(() => expect((screen.getByRole('button', { name: '新版として保存する' }) as HTMLButtonElement).disabled).toBe(false))
  expect((screen.getByLabelText('名前', { exact: true }) as HTMLInputElement).value).toBe('編集中')
  const anchor = document.createElement('a'); anchor.href = '/templates'; document.body.appendChild(anchor)
  const navigation = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  anchor.dispatchEvent(navigation)
  expect(navigation.defaultPrevented).toBe(false)
  anchor.remove()
  fireEvent.click(screen.getByRole('button', { name: '新版として保存する' }))
  await waitFor(() => expect(net.version).toHaveBeenLastCalledWith('account-1', 'fn1', expect.objectContaining({ expectedVersionNumber: 2 })))
})

it('変更を保存した後は離脱確認を残さない', async () => {
  net.version.mockResolvedValue({ success: true, data: { id: 'v2', versionNumber: 2 } })
  render(<FunnelFormV8 accountId="account-1" edit={{ funnelId: 'fn1', name: '編集前', windowDays: '30', steps: [
    { label: '入口', kind: 'friend_add', value: '', match: {} },
    { label: '購入', kind: 'purchase', value: '', match: {} },
  ], segment: null, comparisonGroups: [], expectedVersionNumber: 1 }} onCancel={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText('名前', { exact: true }), { target: { value: '編集後' } })
  fireEvent.click(screen.getByRole('button', { name: '新版として保存する' }))
  await waitFor(() => expect(net.version).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole('button', { name: '新版として保存する' }).hasAttribute('disabled')).toBe(false))
  const anchor = document.createElement('a'); anchor.href = '/templates'; document.body.appendChild(anchor)
  const navigation = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  anchor.dispatchEvent(navigation)
  expect(navigation.defaultPrevented).toBe(false)
  anchor.remove()
})

it('保存中は入力の変更を受け付けない', async () => {
  net.create.mockReturnValue(new Promise(() => {}))
  render(<FunnelFormV8 accountId="account-1" presetConversion={{ id: 'point-1', name: '購入' }} onCancel={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText('名前', { exact: true }), { target: { value: '購入まで' } })
  fireEvent.change(screen.getByLabelText('段1の名前'), { target: { value: '友だち追加' } })
  fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  await waitFor(() => expect(net.create).toHaveBeenCalledOnce())
  const input = screen.getByLabelText('名前', { exact: true })
  expect(input.closest('[inert]')).not.toBeNull()
})

it('ファネルの段の種類はサーバーの全種類を利用者が選べる', async () => {
  const { V6_FUNNEL_STEP_KINDS } = await import('../../../../../packages/db/src/analytics-funnels')
  const { FUNNEL_STEP_KINDS } = await import('./funnel-form')
  expect(FUNNEL_STEP_KINDS.map(option => option.key).sort()).toEqual([...V6_FUNNEL_STEP_KINDS].sort())
  render(<FunnelFormV8 accountId="account-1" onCancel={() => {}} onCreated={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '2段目で何をしたら進むか' }))
  const choice = await screen.findByRole('radio', { name: 'ほかの条件' })
  fireEvent.click(choice)
  fireEvent.click(within(choice.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: '選択する' }))
  fireEvent.click(screen.getByRole('button', { name: '2段目の種類' }))
  const list = await screen.findByRole('listbox')
  expect(within(list).getAllByRole('option').map(option => option.textContent?.trim())).toEqual(FUNNEL_STEP_KINDS.map(option => option.label))
})
