// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), gate: vi.fn(), cancel: vi.fn() }))
vi.mock('@/lib/api/helpers/gap3', () => ({ accountAiFeaturesApi: { get: fixture.get, save: fixture.save } }))
vi.mock('@/lib/session-snapshot', () => ({ readSessionSnapshot: () => null, readPermissionSessionSnapshot: () => null, SESSION_SNAPSHOT_CHANGED: 'session' }))
vi.mock('@/components/step-up-prompt', () => ({ useStepUpGate: () => ({ gate: fixture.gate, cancel: fixture.cancel, prompt: null }) }))
import BannerAiSetting from './banner-ai-setting'

const row = (enabled: boolean, version = 0) => ({ feature: 'banner', enabled, version, consentBy: null, consentAt: null, disclosureVersion: null })
const response = (enabled: boolean) => ({ success: true, data: { items: [row(enabled)], disclosure: '画像を提供会社へ送ります', disclosureVersion: 'v1' } })
beforeEach(() => { fixture.get.mockReset(); fixture.save.mockReset(); fixture.gate.mockReset(); fixture.get.mockResolvedValue(response(false)); fixture.gate.mockResolvedValue('grant'); fixture.save.mockResolvedValue({ success: true, data: row(true, 1) }) })
afterEach(cleanup)

it('オンは説明への同意と本人確認の後だけ、選択中の店へ保存する', async () => {
  render(<BannerAiSetting accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  expect(screen.getByText(/画像を提供会社へ送ります/)).toBeTruthy()
  expect(fixture.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '同意して本人確認へ' }))
  await waitFor(() => expect(fixture.save).toHaveBeenCalledWith('a', 'banner', { enabled: true, expectedVersion: 0, consent: true, disclosureVersion: 'v1' }, 'grant'))
  expect(await screen.findByText('バナー生成：オン')).toBeTruthy()
})

it('読込失敗をオフと表示せず再試行できる', async () => {
  fixture.get.mockRejectedValueOnce(new Error('offline'))
  render(<BannerAiSetting accountId="a" canManage />)
  expect(await screen.findByText(/AI の機能を読み込めませんでした/)).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('バナー生成：オフ')).toBeTruthy()
})

it('本人確認中に店が変わったら古い店に保存しない', async () => {
  let resolve!: (value: string | null) => void
  fixture.gate.mockImplementation(() => new Promise<string | null>(r => { resolve = r }))
  const view = render(<BannerAiSetting accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('button', { name: '同意して本人確認へ' }))
  view.rerender(<BannerAiSetting accountId="b" canManage />)
  resolve('grant')
  await screen.findByText('バナー生成：オフ')
  expect(fixture.save).not.toHaveBeenCalled()
})

it('オフは保存成功まで画面をオンのままにし、正しい版を渡す', async () => {
  fixture.get.mockResolvedValue(response(true))
  let resolve!: (value: unknown) => void
  fixture.save.mockImplementation(() => new Promise(r => { resolve = r }))
  render(<BannerAiSetting accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  expect(screen.getByText('バナー生成：オン')).toBeTruthy()
  expect(fixture.save).toHaveBeenCalledWith('a', 'banner', { enabled: false, expectedVersion: 0 }, undefined)
  resolve({ success: true, data: row(false, 1) })
  expect(await screen.findByText('バナー生成：オフ')).toBeTruthy()
})

it('本人確認がキャンセルされたら保存しない', async () => {
  fixture.gate.mockResolvedValue(null)
  render(<BannerAiSetting accountId="a" canManage />)
  fireEvent.click(await screen.findByRole('switch', { name: 'バナー生成' }))
  fireEvent.click(screen.getByRole('button', { name: '同意して本人確認へ' }))
  await waitFor(() => expect(fixture.gate).toHaveBeenCalled())
  expect(fixture.save).not.toHaveBeenCalled()
  expect(screen.getByText('バナー生成：オフ')).toBeTruthy()
})

it('変更権限がない人には操作を出さず読み取りもしない', () => {
  render(<BannerAiSetting accountId="a" canManage={false} />)
  expect(screen.queryByRole('switch')).toBeNull()
  expect(fixture.get).not.toHaveBeenCalled()
})
