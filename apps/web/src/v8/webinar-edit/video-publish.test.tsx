// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoPane from './video'
import ReviewPane from './review'
import type { EditContext, WizardChrome } from './types'

// 動画選択・下書き保存・公開前検証を実際の編集画面で確かめる。
const fixture = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = 'http://worker.test'
  return { mediaList: vi.fn(), update: vi.fn(), videoAsset: vi.fn(), validation: vi.fn(), notifications: vi.fn(), publish: vi.fn() }
})
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, media: { ...actual.api.media, list: fixture.mediaList } }, webinarApi: {
    ...actual.webinarApi, update: fixture.update, videoAsset: fixture.videoAsset,
    publishValidation: fixture.validation, notifications: fixture.notifications, publish: fixture.publish,
  } }
})
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock() }))

const media = { id: 'med-1', lineAccountId: 'acc-a', kind: 'video', filename: 'seminar.mp4', durationMs: 3600000 }
const chrome: WizardChrome = { title: 'テストウェビナー', identity: null, steps: null, footerActions: null }
function context(overrides: Partial<EditContext['webinar']> = {}): EditContext {
  return {
    webinar: { id: 'w1', accountId: 'acc-a', title: 'テストウェビナー', slug: 'test', status: 'draft', videoPrefix: null,
      videoMediaId: null, durationSeconds: 7200, schedule: [], cta: null, createdAt: '', updatedAt: '', ...overrides },
    editor: { version: 7, deliveryKind: 'on_demand', actionPolicy: { missingResultPolicy: 'escalate' } },
    readOnly: false, publicUrl: null, canOpenPublicPage: false, publicPageReason: '', ctaCount: 0, analytics: null, analyticsState: 'idle',
    onEditorChange: vi.fn(), onWebinarSaved: vi.fn(), onCtasReport: vi.fn(), onPublished: vi.fn(), goStep: vi.fn(), retryAnalytics: vi.fn(),
  } as unknown as EditContext
}
async function openVideo(ctx = context()) {
  render(<VideoPane ctx={ctx} chrome={chrome} onDirtyChange={() => {}} registerSave={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: ctx.webinar.videoPrefix || ctx.webinar.videoMediaId ? '差し替える' : '動画を選ぶ' }))
  const dialog = await screen.findByRole('dialog', { name: '動画を差し替える' })
  return within(dialog)
}
function renderReview(ctx = context()) {
  return render(<ReviewPane ctx={ctx} chromeFor={primary => ({ ...chrome, footerActions: primary })} />)
}

beforeEach(() => {
  fixture.mediaList.mockResolvedValue({ success: true, data: { items: [media, { ...media, id: 'med-2', filename: 'second.mp4' }] } })
  fixture.update.mockResolvedValue({ success: true, data: context().webinar })
  fixture.videoAsset.mockResolvedValue({ data: { asset: null } })
  fixture.validation.mockResolvedValue({ data: { version: 7, checks: [{ key: 'video_ready', label: '動画の準備', status: 'passed', detail: null }], blockers: [], warnings: [] } })
  fixture.notifications.mockResolvedValue({ data: { settings: {} } })
  fixture.publish.mockResolvedValue({ success: true, data: {} })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks() })

describe('ウェビナーの動画設定の保存保護', () => {
  it('同一アカウントの動画候補から選び、IDだけ保存して公開しない', async () => {
    const dialog = await openVideo()
    await waitFor(() => expect(fixture.mediaList).toHaveBeenCalledWith('acc-a', { kind: 'video', limit: 100 }))
    const select = await dialog.findByRole('combobox', { name: '動画' })
    fireEvent.change(select, { target: { value: 'med-2' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.update).toHaveBeenCalledWith('w1', { durationSeconds: 7200, videoMediaId: 'med-2' }))
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('保存された動画を初期選択し、解除はnullを保存する', async () => {
    const dialog = await openVideo(context({ videoMediaId: 'med-1', videoPrefix: 'media/acc-a/video.mp4' }))
    const select = await dialog.findByRole('combobox', { name: '動画' }) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('med-1'))
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.update).toHaveBeenCalledWith('w1', { durationSeconds: 7200, videoMediaId: null }))
  })

  it('ライブラリ外の既存動画を維持すると動画IDやprefixを上書きしない', async () => {
    const dialog = await openVideo(context({ videoPrefix: 'webinars/legacy' }))
    expect((dialog.getByRole('combobox', { name: '動画' }) as HTMLSelectElement).value).toBe('__external__')
    fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.update).toHaveBeenCalledWith('w1', { durationSeconds: 7200 }))
  })

  it('R2 prefix自由入力や旧CTA入力を復活させない', async () => {
    const dialog = await openVideo()
    expect(dialog.queryByLabelText('動画 R2 プレフィックス')).toBeNull()
    expect(dialog.queryByText('従来CTAボタンの設定')).toBeNull()
    expect(dialog.queryByText('CTA ボタンを表示する')).toBeNull()
  })

  it('動画候補を再読込しても選んだ動画と時間の入力を失わない', async () => {
    fixture.mediaList.mockRejectedValueOnce(new Error('unavailable'))
    const dialog = await openVideo(context({ videoMediaId: 'med-1' }))
    await dialog.findByText('登録メディアの動画を読み込めませんでした。')
    fireEvent.change(dialog.getByRole('textbox', { name: '動画の長さ（分）' }), { target: { value: '90' } })
    fireEvent.click(dialog.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(fixture.mediaList).toHaveBeenCalledTimes(2))
    await waitFor(() => expect((dialog.getByRole('combobox', { name: '動画' }) as HTMLSelectElement).value).toBe('med-1'))
    fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.update).toHaveBeenCalledWith('w1', { durationSeconds: 5400, videoMediaId: 'med-1' }))
  })

  it('空の動画時間ではAPIを呼ばず理由を表示する', async () => {
    const dialog = await openVideo()
    fireEvent.change(dialog.getByRole('textbox', { name: '動画の長さ（分）' }), { target: { value: '' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
    expect(await dialog.findByText('動画の長さ（分）を入れてください。')).toBeTruthy()
    expect(fixture.update).not.toHaveBeenCalled()
  })
})

describe('現行V8の公開確認と専用API', () => {
  it.each(['video_ready', 'schedule_ready', 'duration_ready'])('検査で%sが失敗している間は公開できない', async key => {
    fixture.validation.mockResolvedValue({ data: { version: 7, checks: [{ key, label: key, status: 'failed', detail: null }], blockers: ['設定を確認してください'], warnings: [] } })
    renderReview()
    await screen.findByText(/このままでは公開できません/)
    expect((screen.getByRole('button', { name: 'この版を公開' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'この版を公開' }))
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('公開前検査の版が編集画面の版と違う場合は公開しない', async () => {
    fixture.validation.mockResolvedValue({ data: { version: 6, checks: [{ key: 'video_ready', label: '動画の準備', status: 'passed', detail: null }], blockers: [], warnings: [] } })
    renderReview()
    await screen.findByText('動画の準備')
    const publish=screen.getByRole('button', { name: 'この版を公開' }) as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    fireEvent.click(publish)
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('公開前検査の取得失敗では公開せず、再読込から復帰できる', async () => {
    fixture.validation.mockRejectedValueOnce(new Error('unavailable'))
    renderReview()
    await screen.findByText('公開前の確認を読み込めませんでした。このままでは公開できません。')
    expect((screen.getByRole('button', { name: 'この版を公開' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'この版を公開' }) as HTMLButtonElement).disabled).toBe(false))
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('確認段の明示操作でだけ専用公開APIと版を送り、完了画面へ移る', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const ctx = context()
    renderReview(ctx)
    await waitFor(() => expect((screen.getByRole('button', { name: 'この版を公開' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getAllByText('テストウェビナー').length).toBeGreaterThan(0)
    expect(fixture.publish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'この版を公開' }))
    await waitFor(() => expect(fixture.publish).toHaveBeenCalledWith('w1', 7))
    expect(fixture.update).not.toHaveBeenCalled()
    expect(ctx.onPublished).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith('/webinars/published?id=w1')
  })
})
