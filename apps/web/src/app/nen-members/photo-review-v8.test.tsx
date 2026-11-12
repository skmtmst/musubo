// @vitest-environment happy-dom
/*
 * ★V8-B 投稿（・・・・・）の骨格。
 * データの口は 管理画面 と同じ（photos・metrics・review・publications）。
 * 板の印・札・カードの操作・見送る窓・掲載の表を見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeControl } from '@/test-utils/time-control'

const fetchPhotos = vi.hoisted(() => vi.fn())
const nenMembers = vi.hoisted(() => ({
  photoReviewMetrics: vi.fn(),
  photoRewardPolicyVersions: vi.fn(),
  photoPublications: vi.fn(),
  reviewPhoto: vi.fn(),
  bulkReviewPhotos: vi.fn(),
  retryPhotoReviewNotification: vi.fn(),
  withdrawPhotoPublication: vi.fn(),
  createPhotoRewardPolicyVersion: vi.fn(),
  revertPhotoRewardPolicyVersion: vi.fn(),
  photoPublicationOrder: vi.fn(),
  savePhotoPublicationOrder: vi.fn(),
  photo: vi.fn(),
  publishPhoto: vi.fn(),
}))
const staffMe = vi.hoisted(() => ({ me: vi.fn() }))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error { status?: number; code?: string },
  api: { staff: staffMe, nenMembers },
  fetchApi: (...args: unknown[]) => fetchPhotos(...args),
}))

import PhotoReviewV8 from '@/v8/nen-posts/review'

const flush = () => act(async () => { await Promise.resolve() })

const photo = {
  id: 'p1',
  status: 'pending',
  pet_name: 'こむぎ',
  pet_call_name: 'こむぎ',
  pet_gender: 'female',
  owner_name: '見本 169',
  customer_id: '10234',
  caption: '散歩のあと',
  created_at: '2026-09-30T10:00:00Z',
  image_url: null,
  latest_risk_flag: 'none',
  review_notification_status: 'sent',
  point_sync_status: 'synced',
  publication_consent_at: null,
  publication_withdrawn_at: null,
  review_version: 1,
}

const metrics = {
  pendingCount: 1,
  reviewedCount: 0,
  attentionCount: 0,
  averageReviewMinutes: null,
  oldestPendingAt: null,
}

const versions = [
  { versionNumber: 3, policyKey: 'default', points: 100, summary: '', effectiveFrom: null, createdBy: '見本 18', createdAt: '2026-09-20T10:00:00Z', status: 'in_use' },
]

const publication = {
  id: 'pub1',
  version: 1,
  pet_name: 'こむぎ',
  owner_name: '',
  image_url: null,
  placements: [{ active: 1, placement_label: 'サイト（お客様の声）', placement_type: 'site' }],
  view_count: 2140,
  publication_consent_at: '2026-09-01T00:00:00Z',
}

function mockAll() {
  fetchPhotos.mockResolvedValue({ success: true, data: [photo] })
  nenMembers.photoReviewMetrics.mockResolvedValue({ success: true, data: metrics })
  nenMembers.photoRewardPolicyVersions.mockResolvedValue({ success: true, data: versions })
  nenMembers.photoPublications.mockResolvedValue({
    success: true,
    data: {
      summary: { publishedCount: 1, placementCount: 1, topPhoto: null, consentedCount: 1 },
      items: [publication],
      pendingWithdrawals: [],
      withdrawnItems: [],
    },
  })
}

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); vi.clearAllMocks(); vi.useRealTimers() })

describe('投稿 V8', () => {
  it('審査待ちは TkA4D の印でカードと操作を出す', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
    mockAll()
    const { container } = render(<PhotoReviewV8 accountId="account-a" />)
    await screen.findByText('散歩のあと', { exact: false })
    expect(container.querySelector('[data-design-node="TkA4D"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'こむぎの写真を採用する' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'こむぎの写真を見送る' })).toBeTruthy()
    expect(screen.getByText('報酬の決まり')).toBeTruthy()
    expect(screen.getByText('見送り理由の内訳（今月）')).toBeTruthy()
  })

  it('見るだけの権限は Jn95h の印で操作を押せなくする', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'staff' } })
    mockAll()
    const { container } = render(<PhotoReviewV8 accountId="account-a" />)
    await screen.findByText('散歩のあと', { exact: false })
    expect(container.querySelector('[data-design-node="Jn95h"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'こむぎの写真を採用する' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'こむぎの写真を見送る' })).toBeNull()
  })

  it('見送るを押すと ujcar の窓が開く', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
    mockAll()
    const { container } = render(<PhotoReviewV8 accountId="account-a" />)
    await screen.findByText('散歩のあと', { exact: false })
    fireEvent.click(screen.getByRole('button', { name: 'こむぎの写真を見送る' }))
    expect(await screen.findByText('この写真を見送りますか？')).toBeTruthy()
    expect(document.querySelector('[data-design-node="ujcar"]')).toBeTruthy()
    expect(screen.getByText('見送った理由')).toBeTruthy()
  })

  it('見送りのプレビューは送信される理由・補足・再投稿案内を一度ずつ表示する', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
    mockAll()
    render(<PhotoReviewV8 accountId="account-a" />)
    await screen.findByText('散歩のあと', { exact: false })
    fireEvent.click(screen.getByRole('button', { name: 'こむぎの写真を見送る' }))
    fireEvent.click(screen.getByRole('radio', { name: 'ほかの人の顔が写っています' }))
    fireEvent.click(screen.getByRole('radio', { name: '暗くて見えにくいです' }))
    const supplement = '明るいところで、もう一度お願いできますか。'
    const preview = screen.getByText('お写真をご投稿いただきありがとうございます。', { exact: false })
    expect(preview.textContent?.split(supplement)).toHaveLength(2)
    expect(preview.textContent).toContain('今回は「写真が暗い・ぼやけている」のため、掲載を見送らせていただきました。')
    expect(preview.textContent).toContain('内容をご確認のうえ、よろしければ別のお写真をご投稿ください。')
    fireEvent.click(screen.getByRole('switch', { name: 'もう一度 送ってもらえるようお願いする' }))
    expect(preview.textContent).not.toContain('別のお写真をご投稿ください。')
  })

  it('公式サイト掲載は SyQA1 の印で表を出す', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
    mockAll()
    const { container } = render(<PhotoReviewV8 accountId="account-a" />)
    await screen.findByText('散歩のあと', { exact: false })
    fireEvent.click(screen.getByRole('tab', { name: '公式サイト掲載' }))
    expect(await screen.findByRole('columnheader', { name: /掲載先/ })).toBeTruthy()
    expect(container.querySelector('[data-design-node="SyQA1"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: '掲載先から外す' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '出すときの決めごと' })).toBeTruthy()
  })
  it('履歴の保存は採用報酬と版を送り、予約日時を日本時間で送る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-10T15:09:00Z'))
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
    mockAll()
    nenMembers.createPhotoRewardPolicyVersion.mockResolvedValue({ success: true, data: { version: { versionNumber: 4 } } })
    render(<PhotoReviewV8 accountId="account-a" />)
    await screen.findByText('散歩のあと', { exact: false })
    fireEvent.click(screen.getByRole('button', { name: '版の履歴を見る' }))
    fireEvent.click(await screen.findByRole('button', { name: '新しい版を作る' }))
    await screen.findByRole('dialog', { name: '新しい版を作る' })
    fireEvent.change(screen.getByLabelText('採用したら（マイル）'), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('ひとこと（なぜ変えるか）'), { target: { value: '10月の報酬' } })
    fireEvent.click(screen.getByLabelText('使い始め（日本時間・空ならすぐ）'))
    const dateTime = await screen.findByRole('dialog', { name: '日時を選ぶ' })
    fireEvent.click(await screen.findByRole('button', { name: '2026年10月15日（木）' }))
    await setTimeControl(within(dateTime).getByRole('combobox', { name: '時刻' }), '00:00')
    fireEvent.click(within(dateTime).getByRole('button', { name: '確定' }))
    fireEvent.click(screen.getByRole('button', { name: '版を予約する' }))
    await flush()
    expect(nenMembers.createPhotoRewardPolicyVersion).toHaveBeenCalledWith({ points: 120, publicationPoints: 0, summary: '10月の報酬', effectiveFrom: '2026-10-15T00:00:00+09:00', expectedVersion: 3 })
  })

  it('閲覧のみでは履歴は見られるが新しい版を作れない', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'staff' } })
    mockAll()
    render(<PhotoReviewV8 accountId="account-a" />)
    await screen.findByText('散歩のあと', { exact: false })
    fireEvent.click(screen.getByRole('button', { name: '版の履歴を見る' }))
    await screen.findByText('いま使っている版')
    expect(screen.queryByLabelText('採用したら（マイル）')).toBeNull()
  })

})

it('V8の掲載順を動かして、読み込んだ版と全件を送る', async () => {
  staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
  mockAll()
  nenMembers.photoPublicationOrder.mockResolvedValue({success:true,data:{items:[{...publication,pet_name:'こむぎ'},{...publication,id:'pub2',pet_name:'あずき',version:4}]}})
  nenMembers.savePhotoPublicationOrder.mockResolvedValue({success:true,data:{items:[]}})
  render(<PhotoReviewV8 accountId="account-a" />)
  await screen.findByText('散歩のあと', {exact:false})
  fireEvent.click(screen.getByRole('tab',{name:'公式サイト掲載'}))
  fireEvent.click(await screen.findByRole('button',{name:'並び順を変える'}))
  fireEvent.click(await screen.findByRole('button',{name:'あずきを上へ'}))
  fireEvent.click(screen.getByRole('button',{name:'並び順を保存する'}))
  await flush()
  expect(nenMembers.savePhotoPublicationOrder).toHaveBeenCalledWith({accountId:'account-a',items:[{id:'pub2',expectedVersion:4},{id:'pub1',expectedVersion:1}]})
})

it('採用済み写真は現在の掲載版を読み、確認してから新規掲載する', async () => {
  staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
  mockAll()
  fetchPhotos.mockResolvedValue({success:true,data:[{...photo,status:'adopted',publication_consent_at:'2026-10-01'}]})
  nenMembers.photo.mockResolvedValue({success:true,data:{publication:null}})
  nenMembers.publishPhoto.mockResolvedValue({success:true,data:{version:1}})
  render(<PhotoReviewV8 accountId="account-a" />)
  await flush()
  fireEvent.click(await screen.findByRole('tab',{name:/採用/}))
  fireEvent.click(await screen.findByRole('button',{name:'公式サイトに出す'}))
  expect(await screen.findByText('公式サイトに掲載しますか？')).toBeTruthy()
  expect(nenMembers.publishPhoto).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'公式サイトに掲載する'}))
  await flush()
  expect(nenMembers.publishPhoto).toHaveBeenCalledWith('p1',{accountId:'account-a',expectedVersion:0},expect.any(String))
})

it('掲載解除は確認前と取消では送らず、確定で対象の版を一度だけ送る', async () => {
  staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
  mockAll()
  nenMembers.withdrawPhotoPublication.mockResolvedValue({ success: true, data: {} })
  render(<PhotoReviewV8 accountId="account-a" />)
  await screen.findByText('散歩のあと', { exact: false })
  fireEvent.click(screen.getByRole('tab', { name: '公式サイト掲載' }))
  fireEvent.click(await screen.findByRole('button', { name: '掲載先から外す' }))
  expect(nenMembers.withdrawPhotoPublication).not.toHaveBeenCalled()
  const confirmation = await screen.findByRole('dialog', { name: 'この写真を掲載先から外しますか？' })
  fireEvent.click(within(confirmation).getByRole('button', { name: 'キャンセル' }))
  expect(nenMembers.withdrawPhotoPublication).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '掲載先から外す' }))
  const next = await screen.findByRole('dialog', { name: 'この写真を掲載先から外しますか？' })
  fireEvent.click(within(next).getByRole('button', { name: '掲載先から外す' }))
  await flush()
  expect(nenMembers.withdrawPhotoPublication).toHaveBeenCalledTimes(1)
  expect(nenMembers.withdrawPhotoPublication).toHaveBeenCalledWith('pub1', { accountId: 'account-a', expectedVersion: 1 }, expect.any(String))
})
