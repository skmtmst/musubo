// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const upload = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, uploads: { ...actual.api.uploads, image: upload } } }
})
import { useInboxDraft } from './use-inbox-draft'
function Demo() {
  const draft = useInboxDraft({ selectedAccountId: 'sample-account', selectedChatId: 'sample-chat' })
  return <div>
    <input type="file" aria-label="画像を選ぶ" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void draft.handlePickAttachment(file, 'media') }} />
    {draft.pendingImage ? <><span>{draft.pendingImageMeta?.name}</span><button onClick={draft.clearPendingImage}>画像を外す</button></> : null}
    <button disabled={draft.imageUploading}>送る</button>
  </div>
}
function pending() { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function pick(name: string) { fireEvent.change(screen.getByLabelText('画像を選ぶ'), { target: { files: [new File(['sample'], name, { type: 'image/png' })] } }) }
const result = (name: string) => ({ success: true, data: { url: `https://example.invalid/${name}` } })
beforeEach(() => upload.mockReset())
afterEach(() => cleanup())

it('古い画像の完了後も新しい画像の読み込み中は送れない', async () => {
  const old = pending(), latest = pending()
  upload.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  render(<Demo />)
  pick('old.png'); pick('new.png')
  expect(screen.getByRole('button', { name: '送る' })).toHaveProperty('disabled', true)
  await act(async () => old.resolve(result('old')))
  expect(screen.getByRole('button', { name: '送る' })).toHaveProperty('disabled', true)
  await act(async () => latest.resolve(result('new')))
  expect(screen.getByText('new.png')).toBeTruthy()
  expect(screen.getByRole('button', { name: '送る' })).toHaveProperty('disabled', false)
})

it('読み込み中の画像を外すと送れるようになり、古い完了でも復活しない', async () => {
  const latest = pending()
  upload.mockResolvedValueOnce(result('old')).mockReturnValueOnce(latest.promise)
  render(<Demo />)
  await act(async () => pick('old.png'))
  expect(screen.getByText('old.png')).toBeTruthy()
  pick('new.png')
  fireEvent.click(screen.getByRole('button', { name: '画像を外す' }))
  expect(screen.getByRole('button', { name: '送る' })).toHaveProperty('disabled', false)
  await act(async () => latest.resolve(result('new')))
  expect(screen.queryByText('new.png')).toBeNull()
})
