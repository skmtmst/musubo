// @vitest-environment happy-dom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '@/lib/api'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api/helpers/gap3', () => ({ accountAiFeaturesApi: api }))
vi.mock('@/components/step-up-prompt', async original => {
  const actual = await original<typeof import('@/components/step-up-prompt')>()
  return { ...actual, default: ({ request }: { request: { retry: (token: string) => Promise<void> } }) => <button onClick={() => void request.retry('verified')}>本人確認を完了</button> }
})
import AiFeatures from './ai-features'

const item = (feature: 'banner' | 'google_review', enabled = false, version = 0) => ({ feature, enabled, version, consentAt: null, consentBy: null, disclosureVersion: null })
beforeEach(() => { api.get.mockReset(); api.save.mockReset(); api.get.mockResolvedValue({ success: true, data: { items: [item('banner'), item('google_review')], disclosure: '入力内容がAI提供会社に送られます', disclosureVersion: 'v1' } }) })
afterEach(() => { cleanup(); forgetSessionSnapshot() })

it('オンには同意を求め、版と同意文の版を送る。オフにも最新の版を使う', async () => {
  api.save.mockResolvedValueOnce({ success: true, data: item('banner', true, 1) }).mockResolvedValueOnce({ success: true, data: item('banner', false, 2) })
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  expect(screen.getByText('2 件中 0 件オン')).toBeTruthy()
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('入力内容がAI提供会社に送られます')).toBeTruthy()
  const confirm = within(dialog).getByRole('button', { name: '同意してオンにする' })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(confirm)
  await waitFor(() => expect(api.save).toHaveBeenCalledWith('a', 'banner', { enabled: true, expectedVersion: 0, consent: true, disclosureVersion: 'v1' }, undefined))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'バナー生成' }).getAttribute('aria-checked')).toBe('true'))
  expect(screen.getByText('2 件中 1 件オン')).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'バナー生成' }))
  await waitFor(() => expect(api.save).toHaveBeenLastCalledWith('a', 'banner', { enabled: false, expectedVersion: 1 }, undefined))
})

it('本人確認を求められたら完了後に同じ内容と確認トークンで再試行する', async () => {
  api.save.mockRejectedValueOnce(new ApiError(428, '確認', 'STEP_UP_REQUIRED')).mockResolvedValueOnce({ success: true, data: item('banner', true, 1) })
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  fireEvent.click(await screen.findByRole('button', { name: '本人確認を完了' }))
  await waitFor(() => expect(api.save).toHaveBeenLastCalledWith('a', 'banner', { enabled: true, expectedVersion: 0, consent: true, disclosureVersion: 'v1' }, 'verified'))
})

it('権限のない人は状態を取得せず、操作をロックする', () => {
  render(<AiFeatures accountId="a" canManage={false} lockedReason="オーナーまたは管理者だけが変更できます" />)
  expect(api.get).not.toHaveBeenCalled()
  expect(screen.queryByText('状態を確認できません')).toBeNull()
  expect(screen.queryByText(/件中.*件オン/)).toBeNull()
  expect(screen.getAllByText('オーナーまたは管理者だけが変更できます').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('switch', { name: 'バナー生成' }))
  expect(api.save).not.toHaveBeenCalled()
})

it('保存失敗はオンと表示せず、読み直しを案内する', async () => {
  api.save.mockRejectedValueOnce(new Error('conflict'))
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  expect(await screen.findByText('AI の機能を保存できませんでした。設定を読み直してからお試しください。')).toBeTruthy()
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: '読み直す' })).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'バナー生成' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '破棄する' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByText('AI の機能を保存できませんでした。設定を読み直してからお試しください。')).toBeTruthy()
  expect(screen.getByRole('button', { name: '読み直す' })).toBeTruthy()
})


it.each(['read', 'write'] as const)('代理ログイン（%s）では変更できない', async mode => {
  rememberSessionSnapshot({ impersonation: { id: 'proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' })
  render(<AiFeatures accountId="a" canManage />)
  const toggle = await screen.findByRole('switch', { name: 'バナー生成' })
  expect(screen.getAllByText('代理ログイン中は変更できません。代理ログインを終了してから操作してください。').length).toBeGreaterThan(0)
  fireEvent.click(toggle)
  expect(api.save).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('競合は最新の設定に読み直し、同時変更を伝える', async () => {
  api.get.mockResolvedValueOnce({ success: true, data: { items: [item('banner'), item('google_review')], disclosure: '同意文', disclosureVersion: 'v1' } }).mockResolvedValueOnce({ success: true, data: { items: [item('banner', true, 2), item('google_review')], disclosure: '同意文', disclosureVersion: 'v1' } })
  api.save.mockRejectedValueOnce(new ApiError(409, 'conflict', 'version_conflict'))
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  expect(await screen.findByText('ほかの人が先に変更しました。最新の状態を表示しています。')).toBeTruthy()
  expect(api.get).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('switch', { name: 'バナー生成' }).getAttribute('aria-checked')).toBe('true')
})

it('同意文が古ければ読み直して新しい文への再同意を求める', async () => {
  api.get.mockResolvedValueOnce({ success: true, data: { items: [item('banner'), item('google_review')], disclosure: '古い同意文', disclosureVersion: 'v1' } }).mockResolvedValueOnce({ success: true, data: { items: [item('banner'), item('google_review')], disclosure: '新しい同意文', disclosureVersion: 'v2' } })
  api.save.mockRejectedValueOnce(new ApiError(400, 'consent', 'ai_consent_required'))
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  expect(await screen.findByText('新しい同意文')).toBeTruthy()
  expect(screen.getByText('同意文が更新されました。内容を確認してもう一度同意してください。')).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: '内容に同意します' }) as HTMLInputElement).checked).toBe(false)
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: '読み直す' })).toBeNull()
  expect(api.get).toHaveBeenCalledTimes(2)
  api.save.mockResolvedValueOnce({ success: true, data: item('banner', true, 1) })
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  await waitFor(() => expect(api.save).toHaveBeenLastCalledWith('a', 'banner', { enabled: true, expectedVersion: 0, consent: true, disclosureVersion: 'v2' }, undefined))
})

it('同意文の更新後にキャンセルしたら、不要になった再同意の案内を閉じる', async () => {
  api.save.mockRejectedValueOnce(new ApiError(400, 'consent', 'ai_consent_required'))
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  expect(await screen.findByText('同意文が更新されました。内容を確認してもう一度同意してください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByText('同意文が更新されました。内容を確認してもう一度同意してください。')).toBeNull()
  expect(screen.queryByRole('button', { name: '読み直す' })).toBeNull()
})

it('権限エラーは読み直しではなく権限の不足を伝える', async () => {
  api.save.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'forbidden'))
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  expect(await screen.findByText('AI の機能を変更する権限がありません。オーナーまたは管理者に依頼してください。')).toBeTruthy()
})

it('保存時に返った同意の理由を欄に表示し、再操作で消す', async () => {
  api.save.mockRejectedValueOnce({ status: 422, fields: { consent: '同意を確認してください' } })
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  const checkbox = screen.getByRole('checkbox', { name: '内容に同意します' })
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  expect(await screen.findByText('同意を確認してください')).toBeTruthy()
  expect(checkbox.getAttribute('aria-invalid')).toBe('true')
  fireEvent.click(checkbox)
  await waitFor(() => expect(screen.queryByText('同意を確認してください')).toBeNull())
})

it('スイッチの欄名で保存に失敗したとき、窓の中で失敗を知らせる', async () => {
  api.save.mockRejectedValueOnce({ status: 422, fields: { enabled: '設定を確認してください' } })
  render(<AiFeatures accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '内容に同意します' }))
  fireEvent.click(screen.getByRole('button', { name: '同意してオンにする' }))
  const dialog = screen.getByRole('dialog')
  expect(await within(dialog).findByText('AI の機能を保存できませんでした。設定を読み直してからお試しください。')).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'Google口コミの返信案' }).getAttribute('aria-invalid')).not.toBe('true')
})
