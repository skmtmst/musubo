// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MessageForm from './message-form'
import type { MessageTemplateDefinition } from '@/lib/hq-templates-api'

const calls = vi.hoisted(() => ({ references: vi.fn() }))
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { messageReferences: calls.references } }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false }) }))
afterEach(cleanup)
beforeEach(() => calls.references.mockReset())

const value: MessageTemplateDefinition = {
  schemaVersion: 1,
  template: { id: 'hq-authored-message', name: '案内', category: 'general', messageType: 'flex', messageContent: '本文', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' },
  media: [],
  card: { format: 'flex', title: '案内', body: '本文', buttons: [{ id: 'one', label: '回答', action: 'form', value: '' }] },
}
function show() {
  return render(<MessageForm name="案内" onNameChange={() => {}} value={value} onChange={() => {}} folders={[]} folderId={null} onFolderChange={() => {}} folderLoadFailed={false} disabled={false} catalogFailed={false} onReloadCatalog={() => {}} />)
}

it('不正な参照先の応答は空の一覧ではなく読み込み失敗として再試行できる', async () => {
  calls.references.mockResolvedValueOnce(null).mockResolvedValueOnce([])
  show()
  expect(await screen.findByText(/参照先を読み込めませんでした/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '参照先を再読み込み' }))
  await waitFor(() => expect(screen.queryByText(/参照先を読み込めませんでした/)).toBeNull())
})

it('参照先に不正な項目が混じった場合も失敗を知らせる', async () => {
  calls.references.mockResolvedValueOnce([null]).mockResolvedValueOnce([])
  show()
  expect(await screen.findByText(/参照先を読み込めませんでした/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '参照先を再読み込み' }))
  await waitFor(() => expect(screen.queryByText(/参照先を読み込めませんでした/)).toBeNull())
})

it('参照先の読み込み中は一覧を空として選択させない', async () => {
  let finish!: (value: unknown[]) => void
  calls.references.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const scenarioValue = { ...value, card: { ...value.card!, buttons: [{ id: 'one', label: '案内', action: 'scenario' as const, value: '' }] } }
  render(<MessageForm name="案内" onNameChange={() => {}} value={scenarioValue} onChange={() => {}} folders={[]} folderId={null} onFolderChange={() => {}} folderLoadFailed={false} disabled={false} catalogFailed={false} onReloadCatalog={() => {}} />)
  const picker = screen.getByRole('button', { name: /ボタン1の参照先/ }) as HTMLButtonElement
  expect(picker.disabled).toBe(true)
  finish([])
  await waitFor(() => expect(picker.disabled).toBe(false))
})

it('再読み込み中の連打は1回の要求にまとまり、動作の種類は変更できる', async () => {
  let finish!: (value: unknown[]) => void
  calls.references.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const change = vi.fn()
  render(<MessageForm name="案内" onNameChange={() => {}} value={value} onChange={change} folders={[]} folderId={null} onFolderChange={() => {}} folderLoadFailed={false} disabled={false} catalogFailed={false} onReloadCatalog={() => {}} />)
  const retry = await screen.findByRole('button', { name: '参照先を再読み込み' })
  fireEvent.click(retry)
  fireEvent.click(retry)
  expect(calls.references).toHaveBeenCalledTimes(2)
  expect((retry as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'ボタン1を押したとき' }))
  fireEvent.click(within(screen.getByRole('listbox')).getByText('URLを開く'))
  expect(change.mock.calls[0][0].card.buttons[0].action).toBe('url')
  finish([])
  await waitFor(() => expect(screen.queryByText(/参照先を読み込めませんでした/)).toBeNull())
})

it('画面の再表示後に古い要求が失敗しても新しい結果を上書きしない', async () => {
  let failOld!: (reason: Error) => void
  calls.references.mockImplementationOnce(() => new Promise((_, reject) => { failOld = reject })).mockResolvedValueOnce([])
  render(<React.StrictMode><MessageForm name="案内" onNameChange={() => {}} value={value} onChange={() => {}} folders={[]} folderId={null} onFolderChange={() => {}} folderLoadFailed={false} disabled={false} catalogFailed={false} onReloadCatalog={() => {}} /></React.StrictMode>)
  await waitFor(() => expect(calls.references).toHaveBeenCalledTimes(2))
  failOld(new Error('old'))
  await waitFor(() => expect(screen.queryByText(/参照先を読み込めませんでした/)).toBeNull())
})
