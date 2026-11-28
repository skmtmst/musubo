// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const list = vi.hoisted(() => vi.fn())
const folders = vi.hoisted(() => vi.fn())
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { listByKind: list, folders: { list: folders }, get: async () => { throw new Error('no') } } }))
import HqTemplatePicker from './template-picker'

const rows = [{ id: 't-1', name: '店からの案内', kind: 'message', content_summary: 'お休みのお知らせ' }]
const props = { onClose: vi.fn(), onPick: vi.fn(async () => null) }
beforeEach(() => { document.documentElement.dataset.theme = 'v8'; list.mockReset(); list.mockResolvedValue(rows); folders.mockReset(); folders.mockResolvedValue([]) })
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; vi.clearAllMocks() })

it('初回失敗→再試行で本当に読み直し、一覧から選べる', async () => {
  list.mockRejectedValueOnce(new Error('network'))
  render(<HqTemplatePicker open {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
  fireEvent.click(await screen.findByRole('radio', { name: '店からの案内' }))
  fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
  expect(list).toHaveBeenCalledTimes(2)
  await waitFor(() => expect(props.onPick).toHaveBeenCalledWith('t-1'))
  expect(props.onClose).toHaveBeenCalledTimes(1)
})

it('再試行も失敗したら再び理由と再試行を出す', async () => {
  list.mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'))
  render(<HqTemplatePicker open {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(await screen.findByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
  expect(screen.queryByText('統括のテンプレートがまだありません。「テンプレート」で作ってください。')).toBeNull()
})

it('閉じて開き直したあとの古い取得成功を捨てる', async () => {
  let finish!: (value: typeof rows) => void
  list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<HqTemplatePicker open {...props} />)
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  view.rerender(<HqTemplatePicker open={false} {...props} />)
  view.rerender(<HqTemplatePicker open {...props} />)
  await screen.findByRole('radio', { name: '店からの案内' })
  await act(async () => { finish([{ ...rows[0], id: 'old', name: '古い取得' }]) })
  expect(screen.queryByRole('radio', { name: '古い取得' })).toBeNull()
})

it('フォルダの失敗を知らせ、一覧を保ってフォルダだけ読み直せる', async () => {
  folders.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ id: 'folder-1', name: 'お知らせ' }])
  render(<HqTemplatePicker open {...props} />)
  await screen.findByText('フォルダを読み込めませんでした。すべての候補から選べます。')
  expect(screen.getByRole('radio', { name: '店からの案内' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを読み直す' }))
  await screen.findByText('お知らせ')
  expect(list).toHaveBeenCalledTimes(1)
  expect(folders).toHaveBeenCalledTimes(2)
})

it('一覧の後から届いたフォルダを表示し、閉じた窓の古い応答を捨てる', async () => {
  let finish!: (value: { id: string; name: string }[]) => void
  folders.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<HqTemplatePicker open {...props} />)
  await screen.findByRole('radio', { name: '店からの案内' })
  await act(async () => { finish([{ id: 'late', name: '後からのフォルダ' }]) })
  expect(await screen.findByText('後からのフォルダ')).toBeTruthy()
  folders.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  view.rerender(<HqTemplatePicker open={false} {...props} />)
  view.rerender(<HqTemplatePicker open {...props} />)
  await waitFor(() => expect(folders).toHaveBeenCalledTimes(2))
  view.rerender(<HqTemplatePicker open={false} {...props} />)
  view.rerender(<HqTemplatePicker open {...props} />)
  await waitFor(() => expect(folders).toHaveBeenCalledTimes(3))
  await act(async () => { finish([{ id: 'old', name: '古いフォルダ' }]) })
  expect(screen.queryByText('古いフォルダ')).toBeNull()
})

it('不正な一覧は空と見せず、読み直せる', async () => {
  list.mockResolvedValueOnce({}).mockResolvedValueOnce(rows)
  render(<HqTemplatePicker open {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('radio', { name: '店からの案内' })).toBeTruthy()
  expect(list).toHaveBeenCalledTimes(2)
})

it('一覧の行が不正なときも読み直せる', async () => {
  list.mockResolvedValueOnce([null]).mockResolvedValueOnce(rows)
  render(<HqTemplatePicker open {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('radio', { name: '店からの案内' })).toBeTruthy()
})

it('選択中の連打を止め、失敗したら選び直せる', async () => {
  let reject!: (reason: Error) => void
  const onPick = vi.fn(() => new Promise<string | null>((_, fail) => { reject = fail }))
  render(<HqTemplatePicker open onClose={props.onClose} onPick={onPick} />)
  fireEvent.click(await screen.findByRole('radio', { name: '店からの案内' }))
  const button = screen.getByRole('button', { name: 'このテンプレートを使う' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(onPick).toHaveBeenCalledTimes(1)
  await act(async () => { reject(new Error('offline')) })
  expect(await screen.findByText('テンプレートを読み込めませんでした。もう一度お試しください。')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'このテンプレートを使う' }).hasAttribute('disabled')).toBe(false)
  onPick.mockResolvedValueOnce(null)
  fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
  await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
  expect(onPick).toHaveBeenCalledTimes(2)
})
