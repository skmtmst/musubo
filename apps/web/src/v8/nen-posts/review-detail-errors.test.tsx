// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '@/lib/api'
import { DetailV8 } from './review-detail'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, nenMembers: {
    ...actual.api.nenMembers,
    photo: vi.fn(), photoAssetStatus: vi.fn(), photoDerivatives: vi.fn(),
    savePhotoRotation: vi.fn(), processPhotoAssets: vi.fn(),
  } } }
})
vi.mock('./detail', () => ({
  PhotoReviewDetail: ({ loading, notice, rotationSaving, assetProcessing, onSaveRotation, onProcessReviewAsset }: ComponentProps<typeof import('./detail').PhotoReviewDetail>) => <>
    <p role="status">{notice}</p>
    <button disabled={loading || rotationSaving} onClick={() => void onSaveRotation(90)}>向きを変更する</button>
    <button disabled={loading || assetProcessing} onClick={onProcessReviewAsset}>作り直す</button>
  </>,
}))
const rotate = vi.mocked(api.nenMembers.savePhotoRotation)
const processAsset = vi.mocked(api.nenMembers.processPhotoAssets)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.nenMembers.photo).mockResolvedValue({ success: true, data: { id: 'photo-1', review_version: 1 } })
  vi.mocked(api.nenMembers.photoAssetStatus).mockResolvedValue({ success: false, error: 'fixture unavailable' })
  vi.mocked(api.nenMembers.photoDerivatives).mockResolvedValue({ success: false, error: 'fixture unavailable' })
})
afterEach(cleanup)

function show(canEdit = true) {
  render(<DetailV8 accountId="account-1" initialPhotoId="photo-1" photos={[{ id: 'photo-1' }]} canEdit={canEdit}
    onPhotoChange={vi.fn()} onReject={vi.fn()} onBack={vi.fn()} onReload={vi.fn()} />)
}

describe('写真詳細の操作が失敗した時の案内', () => {
  it.each([
    ['向きを変更する', 500, '写真の向きを保存できませんでした。'],
    ['作り直す', 500, '審査用画像を作り直せませんでした。'],
    ['向きを変更する', 403, '写真を操作する権限がありません。管理者に権限を確認してください。'],
    ['作り直す', 403, '写真を操作する権限がありません。管理者に権限を確認してください。'],
  ])('%s が%dで失敗しても内部の英語を出さず、処理中を解除する', async (label, status, message) => {
    const error = new ApiError(status, `API error: ${status}`)
    rotate.mockRejectedValue(error)
    processAsset.mockRejectedValue(error)
    show()
    const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message))
    expect(screen.getByRole('status').textContent).not.toContain('API error:')
    await waitFor(() => expect(button.disabled).toBe(false))
    if (label === '向きを変更する') {
      expect(rotate).toHaveBeenCalledWith('photo-1', { accountId: 'account-1', rotation: 90, expectedVersion: 1 }, expect.any(String))
      const key = rotate.mock.calls[0][2]
      fireEvent.click(button)
      await waitFor(() => expect(rotate).toHaveBeenCalledTimes(2))
      expect(rotate.mock.calls[1][2]).toBe(key)
    } else {
      expect(processAsset).toHaveBeenCalledWith('photo-1', { lineAccountId: 'account-1', expectedVersion: 1, operation: 'review' }, expect.any(String))
    }
  })

  it('閲覧のみの担当は、操作の処理を直接呼ばれても更新しない', async () => {
    show(false)
    await waitFor(() => expect((screen.getByRole('button', { name: '向きを変更する' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '向きを変更する' }))
    fireEvent.click(screen.getByRole('button', { name: '作り直す' }))
    expect(rotate).not.toHaveBeenCalled()
    expect(processAsset).not.toHaveBeenCalled()
  })
})
