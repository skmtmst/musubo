// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  testApplyState: vi.fn(),
  testApply: vi.fn(),
  testApplyRevert: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        testApplyState: fx.testApplyState,
        testApply: fx.testApply,
        testApplyRevert: fx.testApplyRevert,
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import RichMenuTestApply from './test-apply'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

describe('RichMenuTestApply 403再試行抑止・破損応答防御・再オープン初期化', () => {
  it('403 のときは権限不足の案内だけを出し、再試行ボタンを出さない', async () => {
    fx.testApplyState.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    await act(async () => {
      root.render(<RichMenuTestApply groupId="g-403" accountId="acc-1" />)
    })

    fireEvent.click(screen.getByRole('button', { name: '自分のLINEで試す' }))
    const dialog = await screen.findByRole('dialog', { name: '自分のLINEで試す' })
    expect(await within(dialog).findByText('テスト適用の状態を見る権限がありません。')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '再試行' })).toBeNull()
  })

  it('recent が配列でない破損応答でもクラッシュせず読み込み失敗として扱う', async () => {
    fx.testApplyState.mockResolvedValueOnce({
      success: true,
      data: { linked: true, destination: null, active: null, recent: null },
    })
    await act(async () => {
      root.render(<RichMenuTestApply groupId="g-bad" accountId="acc-1" />)
    })

    fireEvent.click(screen.getByRole('button', { name: '自分のLINEで試す' }))
    const dialog = await screen.findByRole('dialog', { name: '自分のLINEで試す' })
    expect(await within(dialog).findByText('テスト適用の状態を確認できませんでした。時間をおいて、もう一度お試しください。')).toBeTruthy()
  })

  it('閉じて開き直したときに前回の宛先や通知を残さず読み込み中から始める', async () => {
    fx.testApplyState
      .mockResolvedValueOnce({
        success: true,
        data: {
          linked: true,
          confirmationRevision: 1,
          destinationToken: 'a'.repeat(64),
          linkGuidance: null,
          destination: { staffName: '担当者A', lineUserIdMasked: 'U***1234' },
          active: null,
          recent: [],
        },
      })
      .mockReturnValueOnce(new Promise(() => {}))

    await act(async () => {
      root.render(<RichMenuTestApply groupId="g-1" accountId="acc-1" />)
    })

    fireEvent.click(screen.getByRole('button', { name: '自分のLINEで試す' }))
    const dialog1 = await screen.findByRole('dialog', { name: '自分のLINEで試す' })
    await within(dialog1).findByText('宛先: 担当者AのLINE（U***1234）')

    fireEvent.click(within(dialog1).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '自分のLINEで試す' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '自分のLINEで試す' }))
    const dialog2 = await screen.findByRole('dialog', { name: '自分のLINEで試す' })
    expect(within(dialog2).queryByText('宛先: 担当者AのLINE（U***1234）')).toBeNull()
    expect(within(dialog2).getByText('読み込み中…')).toBeTruthy()
  })
})
