import { readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { beforeEach as seedIdentity } from 'vitest'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ review: vi.fn(), publishReply: vi.fn(), listReviews: vi.fn(), syncReviews: vi.fn(), generateDraft: vi.fn(), saveDraft: vi.fn(), createPost: vi.fn(), profile: vi.fn(), role: 'owner' as string | null }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: { review: fixture.review, publishReply: fixture.publishReply, listReviews: fixture.listReviews, syncReviews: fixture.syncReviews, generateDraft: fixture.generateDraft, saveDraft: fixture.saveDraft, createPost: fixture.createPost, profile: fixture.profile } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fixture.role, canManageRole: (role: string) => role === 'owner' || role === 'admin' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/google', useSearchParams: () => new URLSearchParams() }))
import { compareText } from './performance'
import { formatShortStamp, formatYmd } from './format'
import { PostEditor } from './posts'
import { ReviewDraft, ReviewsBoard } from './reviews'
import ProfileBoard from './profile'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import { ApiError } from '@/lib/api'

const review = {
  id: 'rv-2', reviewName: 'r', reviewerDisplayName: 'Kenji', starRating: 2, comment: '待ちました。', createTime: '2026-09-30T11:12:00Z', updateTime: null,
  needsAttention: true, replyStatus: 'unreplied', replyDraft: '下書き', replyDraftAiGenerated: false, replyDraftGeneratedAt: null, replyComment: null, replyUpdateTime: null,
  firstSeenAt: '2026-09-30T11:12:00Z', updatedAt: '2026-09-30T11:12:00Z',
}
const connection = (writeEnabled: boolean, canPublishReply: boolean) => ({
  success: true, store: { id: 's', name: '試験店', lineAccountId: 'a' }, connection: { status: 'connected', locationTitle: '試験店', locationMapsUrl: null },
  candidates: [], summary: { unrepliedCount: 0, draftCount: 0, attentionCount: 0, newCount: 0, storedCount: 0, postsAttentionCount: 0, syncStale: false },
  writeEnabled, oauthConfigured: true, aiAvailable: true, permissions: { canManageConnection: true, canPublishReply },
}) as unknown as GoogleConnectionData

beforeEach(() => { fixture.review.mockResolvedValue({ success: true, review, store: { id: 's', name: '試験店' }, connection: {} }) })
afterEach(() => { cleanup(); vi.resetAllMocks(); fixture.role = 'owner' })

it('閲覧のみのプロフィールでは変更操作を灰色にし、営業時間は読める', async () => {
  fixture.role = verifiedStaffRole('viewer')
  fixture.profile.mockResolvedValue({
    profile: { title: '試験店', specialHours: [], regularHours: [], phoneNumbers: {}, address: null },
    today: { date: '2026-10-09', closed: false, periods: [{ open: '11:00', close: '20:00' }] },
    holidays: [], closed: false, googleUpdates: null, photoCount: null,
  })
  render(<ProfileBoard accountId="a" go={vi.fn()} />)
  expect(await screen.findByRole('button', {name:'営業時間を開く'})).toHaveProperty('disabled',false)
  expect(screen.queryByText('本日の営業時間')).toBeNull()
  for (const name of ['プロフィールを編集する']) {
    expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true')
  }
})

describe('Googleビジネスの表示の道具', () => {
  it('前期比は「前の28日より +12%」、下がったら「−3%」、比べられないときは「—」', () => {
    expect(compareText(28, 1820, 1625)).toBe('前の28日より +12%')
    expect(compareText(28, 38, 39)).toBe('前の28日より −3%')
    expect(compareText(7, 10, 0)).toBe('前の7日より —')
    expect(compareText(7, null, 3)).toBe('前の7日より —')
  })
  it('日時は店舗の時刻（日本時間）で出す', () => {
    expect(formatShortStamp('2026-09-30T11:12:00Z')).toBe('09/30 20:12')
    expect(formatYmd('2026-09-12T01:20:00Z')).toBe('09/12')
    expect(formatShortStamp(null)).toBe('—')
  })
})

describe('返信を作る：送れない設定でも確認できるが送信しない', () => {
  it('AI下書きは設定操作や初回確認なしにボタンだけで生成する', async () => {
    fixture.generateDraft.mockResolvedValue({ draft: 'ご来店ありがとうございます。' })
    render(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(false, true)} go={vi.fn()} onPublished={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'AIで下書きを作る' }))
    await waitFor(() => expect(fixture.generateDraft).toHaveBeenCalledWith('a', 'rv-2'))
    expect((screen.getByRole('textbox', { name: '返信文' }) as HTMLTextAreaElement).value).toBe('ご来店ありがとうございます。')
    expect(screen.getByText(/口コミの評価・本文と店舗名をAIの提供会社に送ります/)).toBeTruthy()
    expect(fixture.publishReply).not.toHaveBeenCalled()
  })
  it('検証環境では確認できるが送信できない', async () => {
    render(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(false, true)} go={vi.fn()} onPublished={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '下書きを保存' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返信する' }))
    expect(screen.getByText('この返信をGoogleに公開しますか？')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '返信先・内容・個人情報の有無を確認しました' }))
    expect(screen.getByRole('button', { name: 'この内容で返信する' }).getAttribute('aria-disabled')).toBe('true')
    expect(fixture.publishReply).not.toHaveBeenCalled()
  })
  it('送れる設定で公開の権限があれば「返信する」を出す', async () => {
    render(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(true, true)} go={vi.fn()} onPublished={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '返信する' })).toBeTruthy()
  })
  it.each([true, false])('返信済みの競合は再送せず、返信文の有無にかかわらず最新を確認できる（返信文あり=%s）', async (withExistingReply) => {
    const existingReply = '別の担当者による返信です。'.repeat(15)
    fixture.publishReply.mockRejectedValue(new ApiError(409, '返信済み', 'already_replied', withExistingReply ? { existingReply } : undefined))
    const onPublished = vi.fn()
    render(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(true, true)} go={vi.fn()} onPublished={onPublished} />)
    fireEvent.click(await screen.findByRole('button', { name: '返信する' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '返信先・内容・個人情報の有無を確認しました' }))
    fireEvent.click(screen.getByRole('button', { name: 'この内容で返信する' }))
    expect(await screen.findByText('別の担当者がすでに返信しています。')).toBeTruthy()
    expect(screen.getByText(withExistingReply ? new RegExp(existingReply) : /返信文を読み込めませんでした/)).toBeTruthy()
    const confirm = screen.getByRole('button', { name: '返信する' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(fixture.publishReply).toHaveBeenCalledTimes(1)

    fixture.review.mockRejectedValueOnce(new Error('取得失敗'))
    fireEvent.click(screen.getByRole('button', { name: '最新を読み込んで続ける' }))
    expect(await screen.findByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    fixture.review.mockResolvedValue({ success: true, review: { ...review, replyStatus: 'replied', replyComment: existingReply }, store: { id: 's', name: '試験店' }, connection: {} })
    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
    expect(await screen.findByText(`公開済みの返信：${existingReply}`)).toBeTruthy()
    expect(screen.queryByText('別の担当者がすでに返信しています。')).toBeNull()
    expect(screen.queryByRole('button', { name: '返信する' })).toBeNull()
    expect(fixture.publishReply).toHaveBeenCalledTimes(1)
    expect(onPublished).not.toHaveBeenCalled()
  })
})


describe('投稿フォームの入力と保存', () => {
  it('空の本文は欄で知らせてフォーカスを移し、保存先へ送らない', async () => {
    render(<PostEditor accountId="a" kind="standard" postId={null} go={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存する' }))
    const input = screen.getByLabelText('本文')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(screen.getAllByText('本文を入力してください。')).toHaveLength(1)
    expect(fixture.createPost).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '営業しています。' } })
    expect(input.getAttribute('aria-invalid')).not.toBe('true')
  })
  it('特典の入力不足は最初のタイトル欄へ移し、期間の誤りも各欄に結び付ける', () => {
    render(<PostEditor accountId="a" kind="offer" postId={null} go={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '公開内容を確認する' }))
    expect(document.activeElement).toBe(screen.getByLabelText('タイトル（特典・イベントのとき）'))
    for (const label of ['期間 はじめ', '期間 おわり']) {
      const field = screen.getByLabelText(label)
      expect(field.getAttribute('aria-invalid')).toBe('true')
      const errorIds = field.getAttribute('aria-describedby')?.split(' ') ?? []
      expect(errorIds.some((id) => document.getElementById(id)?.getAttribute('role') === 'alert')).toBe(true)
    }
    expect(fixture.createPost).not.toHaveBeenCalled()
  })
  it('保存失敗でも本文を残し、通信の失敗だけを帯で知らせる', async () => {
    fixture.createPost.mockRejectedValue(new Error('保存に失敗しました'))
    const go = vi.fn()
    render(<PostEditor accountId="a" kind="standard" postId={null} go={go} />)
    const input = screen.getByLabelText('本文') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '営業しています。' } })
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存する' }))
    await waitFor(() => expect(screen.getByText('下書きを保存できませんでした。')).toBeTruthy())
    expect(input.value).toBe('営業しています。')
    expect(fixture.createPost).toHaveBeenCalledWith('a', expect.objectContaining({ summary: '営業しています。' }))
    expect(go).not.toHaveBeenCalled()
  })
})

it('WEB176：平均と件数は期間集計ではなく総合と表示する', async () => {
  fixture.listReviews.mockResolvedValue({ total: 0, perPage: 20, items: [] });
  const data = connection(true, true);
  data.connection.averageRating = 4.5;
  data.connection.totalReviewCount = 42;
  render(<ReviewsBoard accountId="a" data={data} go={vi.fn()} onSynced={vi.fn()} />);
  expect(screen.getByText('総合・42件')).toBeTruthy();
  expect(screen.queryByText('この30日・42 件')).toBeNull();
});


it.each(['viewer', null])('口コミは変更権限がない間（%s）も読めるが、下書き・同期操作を灰色にする', async (role) => {
  fixture.role = verifiedStaffRole(role)
  fixture.listReviews.mockResolvedValue({ success: true, reviews: [{ ...review, replyDraft: null }, { ...review, id: 'published', replyStatus: 'published', replyComment: '返信済みの本文' }], total: 2, page: 1, perPage: 20 })
  const data = connection(true, true)
  data.summary.syncStale = true
  const go = vi.fn()
  render(<ReviewsBoard accountId="a" data={data} go={go} onSynced={vi.fn()} />)
  await screen.findAllByText('Kenji')
  expect(document.querySelector('[data-read-only-notice]')).toBeNull() // 親が帯を持つ。
  for (const name of ['下書きを作る', 'Googleから同期する']) {
    const button = screen.getByRole('button', { name })
    expect(role === null ? (button as HTMLButtonElement).disabled : button.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(button)
  }
  fireEvent.click(screen.getByRole('button', { name: '返信を見る' }))
  expect(go).toHaveBeenCalledWith({ tab: 'reviews', view: 'draft', id: 'published' })
  expect(fixture.syncReviews).not.toHaveBeenCalled()
})

it.each(['viewer', null])('下書きのURLを直接開いても変更権限がない間（%s）は読むだけ', async (role) => {
  fixture.role = verifiedStaffRole(role)
  fixture.review.mockResolvedValue({ review: { ...review, replyDraftAiGenerated: true } })
  render(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(true, true)} go={vi.fn()} onPublished={vi.fn()} />)
  await screen.findByText('待ちました。')
  expect((screen.getByRole('textbox', { name: '返信文' }) as HTMLTextAreaElement).value).toBe('下書き')
  expect(screen.getByText('AIが作った返信の下書き', { exact: true })).toBeTruthy()
  expect(document.querySelector('[data-read-only-notice]')).toBeNull() // 親が帯を持つ。
  expect(screen.getByRole('textbox', { name: '返信文' })).toHaveProperty('readOnly', true)
  for (const name of ['下書きを保存', 'AIで下書きを作る', '返信する']) {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement
    expect(role === null ? button.disabled : button.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(button)
  }
  expect(fixture.generateDraft).not.toHaveBeenCalled()
  expect(fixture.saveDraft).not.toHaveBeenCalled()
  expect(fixture.publishReply).not.toHaveBeenCalled()
})

it('編集を任された担当者は口コミの下書きを作り、保存できる', async () => {
  fixture.role = verifiedStaffRole('staff')
  const identity = readStaffIdentity()!
  rememberStaffIdentity({ ...identity, permissionKeys: ['/restaurant-test/google'] })
  fixture.saveDraft.mockResolvedValue({ review: { ...review, replyDraft: '直した返信' } })
  render(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(true, false)} go={vi.fn()} onPublished={vi.fn()} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '返信文' }), { target: { value: '直した返信' } })
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  await waitFor(() => expect(fixture.saveDraft).toHaveBeenCalledWith('a', 'rv-2', '直した返信'))
  expect(screen.getByRole('button', { name: '返信する' }).getAttribute('aria-disabled')).toBe('true')
})


it('閲覧のみでも保存済みの下書きは開いて読むことができる', async () => {
  fixture.role = verifiedStaffRole('viewer')
  fixture.listReviews.mockResolvedValue({ reviews: [{ ...review, replyStatus: 'draft' }], total: 1, page: 1, perPage: 20 })
  const go = vi.fn()
  render(<ReviewsBoard accountId="a" data={connection(false, false)} go={go} onSynced={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '返信を見る' }))
  expect(go).toHaveBeenCalledWith({ tab: 'reviews', view: 'draft', id: 'rv-2' })
  expect(screen.queryByRole('button', { name: '下書きを作る' })).toBeNull()
})

it('公開の確認中に閲覧のみに変わっても、送信へ進めない', async () => {
  const view = render(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(true, true)} go={vi.fn()} onPublished={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '返信する' }))
  await screen.findByText('この返信をGoogleに公開しますか？')
  fixture.role = verifiedStaffRole('viewer')
  view.rerender(<ReviewDraft accountId="a" reviewId="rv-2" data={connection(true, true)} go={vi.fn()} onPublished={vi.fn()} />)
  expect(document.querySelector('[data-read-only-notice]')).toBeNull() // 親の帯との二重化なし。
  expect(screen.queryByRole('button', { name: 'この内容で返信する' })).toBeNull()
  expect(fixture.publishReply).not.toHaveBeenCalled()
})


it('同期中に閲覧のみへ変わっても失敗の案内は残し、再試行の操作を灰色にする', async () => {
  fixture.listReviews.mockResolvedValue({ reviews: [review], total: 1, page: 1, perPage: 20 })
  let rejectSync!: (reason: Error) => void
  fixture.syncReviews.mockImplementation(() => new Promise((_resolve, reject) => { rejectSync = reject }))
  const props = { accountId: 'a', data: connection(true, true), go: vi.fn(), onSynced: vi.fn() }
  const view = render(<ReviewsBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Googleから同期する' }))
  fixture.role = verifiedStaffRole('viewer')
  view.rerender(<ReviewsBoard {...props} />)
  await act(async () => { rejectSync(new Error('模擬の同期失敗')) })
  expect(await screen.findByText(/前回取得した内容を表示しています/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'もう一度', exact: true }).getAttribute('aria-disabled')).toBe('true')
  expect(document.querySelector('[data-read-only-notice]')).toBeNull() // 親の帯との二重化なし。
})


it('送信中に閲覧のみへ変わっても結果不明の案内を残し、再送を誘わない', async () => {
  let rejectPublish!: (reason: Error) => void
  fixture.publishReply.mockImplementation(() => new Promise((_resolve, reject) => { rejectPublish = reject }))
  const props = { accountId: 'a', reviewId: 'rv-2', data: connection(true, true), go: vi.fn(), onPublished: vi.fn() }
  const view = render(<ReviewDraft {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: '返信する' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で返信する' }))
  fixture.role = verifiedStaffRole('viewer')
  view.rerender(<ReviewDraft {...props} />)
  await act(async () => { rejectPublish(new ApiError(502, '送信結果を確認できません', 'upstream_error')) })
  expect(await screen.findByText(/Googleへの送信結果を確認できませんでした/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'この内容で返信する' })).toBeNull()
  expect(screen.getByRole('button', { name: '返信する' }).getAttribute('aria-disabled')).toBe('true')
  expect(fixture.publishReply).toHaveBeenCalledTimes(1)
  expect(props.onPublished).not.toHaveBeenCalled()
})

afterEach(() => { verifiedStaffRole(null) })

seedIdentity(() => { verifiedStaffRole('owner') })

it('保存した口コミの下書きを開き直して確認画面に進める', async () => {
  let stored = { ...review, replyDraft: '' }
  fixture.review.mockImplementation(async () => ({ review: stored }))
  fixture.saveDraft.mockImplementation(async (_account: string, _id: string, text: string) => {
    stored = { ...stored, replyDraft: text }
    return { review: stored }
  })
  const props = { accountId: 'a', reviewId: 'rv-2', data: connection(false, true), go: vi.fn(), onPublished: vi.fn() }
  const view = render(<ReviewDraft {...props} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '返信文' }), { target: { value: '保存した返信' } })
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  await waitFor(() => expect(fixture.saveDraft).toHaveBeenCalledWith('a', 'rv-2', '保存した返信'))
  view.unmount()
  render(<ReviewDraft {...props} />)
  expect(await screen.findByDisplayValue('保存した返信')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返信する' }))
  expect(screen.getByText('この返信をGoogleに公開しますか？')).toBeTruthy()
})
