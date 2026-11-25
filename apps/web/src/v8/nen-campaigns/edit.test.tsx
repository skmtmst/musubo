import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 NEN配信「配信を直す」（src/v8/nen-campaigns/edit.tsx：）と
 * 「コラムを書く」（column-new.tsx：）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * V8 のテーマで出す・選んだ値が保存に乗る・閲覧のみの人には押せない保存を置かない・
 * コラムは配信対象を1つの欄で選び、足りないと保存せずに理由を出す。
 */
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const calls = vi.hoisted(() => ({
  settings: vi.fn(),
  forms: vi.fn(),
  overview: vi.fn(),
  loginUsers: vi.fn(),
  updateSetting: vi.fn(),
  tags: vi.fn(),
  audience: vi.fn(),
  createColumn: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      nenCampaigns: { ...actual.api.nenCampaigns, settings: calls.settings, overview: calls.overview, updateSetting: calls.updateSetting, columnAudience: calls.audience, createColumn: calls.createColumn },
      forms: { ...actual.api.forms, list: calls.forms },
      accountSettings: { ...actual.api.accountSettings, getTestRecipientLoginUsers: calls.loginUsers },
      tags: { ...actual.api.tags, list: calls.tags },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) =>
    React.createElement('a', { href, className }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: calls.push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/nen-campaigns/edit',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '然 - NEN -', displayName: '然 - NEN -', liffId: null }, accounts: [], loading: false }),
}))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import CampaignEdit from './edit'
import ColumnNew from './column-new'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REVIEW = {
  campaignKey: 'review_request', label: '口コミのお願い', category: 'follow_up', triggerEvent: 'ec.order.arrived', delayDays: 10, deliveryTime: '10:00', isEnabled: true,
  title: '口コミのお願い', bodyText: '{{ペットの名前}}ちゃん、{{商品名}}はいかがでしたか。', buttonLabel: '感想を書く（30秒）', buttonUrl: null, imageUrl: null,
  dedupWindowDays: 30, excludeFormRespondents: false,
  afterActions: [
    { kind: 'open_form', formId: 'form-review', formName: '口コミ', buttonLabel: '感想を書く（30秒）' },
    { kind: 'award_mileage', amount: 200, trigger: 'form_submitted' },
  ],
  formIssue: null, updatedAt: '2026-08-25T10:00:00+09:00',
}

let host: HTMLDivElement
let root: Root

beforeEach(() => { clearToastsForTest();
  document.documentElement.dataset.theme = 'v8'
  role.value = verifiedStaffRole('owner')
  for (const fn of Object.values(calls)) fn.mockReset()
  calls.settings.mockResolvedValue({ success: true, data: [REVIEW] })
  calls.forms.mockResolvedValue({ success: true, data: [{ id: 'form-review', name: '口コミ', description: null, isActive: true }] })
  calls.overview.mockResolvedValue({ success: true, data: { jobs: { pendingByCampaign: { review_request: 0 } } } })
  calls.loginUsers.mockResolvedValue({ success: true, data: [{ id: 'f-1', staffName: 'Kenta', sameAccount: true }] })
  calls.updateSetting.mockResolvedValue({ success: true, data: { updatedAt: '2026-08-26T10:00:00+09:00' } })
  calls.tags.mockResolvedValue({ success: true, data: [{ id: 'tag-pet', name: 'ペット登録あり', lineAccountId: 'account-a' }] })
  calls.audience.mockResolvedValue({ success: true, data: { count: 1240 } })
  calls.createColumn.mockResolvedValue({ success: true, data: { id: 'c-new', queued: 0 } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
})

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === name || b.getAttribute('aria-label') === name)

async function pick(label: string, option: string) {
  await act(async () => { fireEvent.click(button(label)!) })
  const item = [...document.querySelectorAll('[role="option"]')].find((node) => (node.textContent ?? '').trim() === option) as HTMLElement | undefined
  expect(item, `${label} に「${option}」がある`).toBeTruthy()
  await act(async () => { fireEvent.click(item!.querySelector('button') ?? item!) })
}

describe('狭い板の配信プレビュー', () => {
  it.each(['配信を直す', 'コラムを書く'])('%s でも畳んだ見え方を開き、閉じられる', async (screen) => {
    await act(async () => { root.render(screen === '配信を直す' ? <CampaignEdit campaignKey="review_request" /> : <ColumnNew />) })
    await flush()
    await act(async () => { fireEvent.click(button('プレビューを見る')!) })
    await flush()
    const drawer = document.querySelector('[role="dialog"]')!
    expect(drawer.textContent).toContain('配信のプレビュー')
    expect(drawer.textContent).toContain('LINEでの見え方')
    expect(host.querySelector('[data-template-region="preview"]')).toBeNull()
    await act(async () => { fireEvent.click(drawer.querySelector('button[aria-label="閉じる"]')!) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.updateSetting).not.toHaveBeenCalled()
    expect(calls.createColumn).not.toHaveBeenCalled()
  })
})

describe('V8 NEN配信「配信を直す」（w5pwG）', () => {
  it('V8 のテーマで節が並び、選んだ日数・時刻・マイルが保存に乗る', async () => {
    await act(async () => { root.render(<><CampaignEdit campaignKey="review_request" /><ToastHost /></>) })
    await flush()
    expect(document.documentElement.dataset.theme).toBe('v8')
    expect(host.querySelector('[data-design-node="w5pwG"]')).not.toBeNull()
    for (const heading of ['配信フロー', 'いつ送りますか', '送るもの', '押されたあとにすること']) expect(host.textContent).toContain(heading)
    expect(host.textContent).toContain('200 マイル')
    await pick('きっかけからの日数', '注文が届いた日から 14 日後')
    const time = host.querySelector('input[aria-label="送る時刻"]') as HTMLInputElement
    await act(async () => { fireEvent.change(time, { target: { value: '19:00' } }); fireEvent.blur(time) })
    await pick('回答後にマイルを付ける', '500 マイル')
    await act(async () => { fireEvent.click(button('配信内容を保存する')!) })
    await flush()
    expect(calls.updateSetting).toHaveBeenCalledWith('account-a', 'review_request', expect.objectContaining({
      delayDays: 14,
      deliveryTime: '19:00',
      afterActions: expect.arrayContaining([expect.objectContaining({ kind: 'award_mileage', amount: 500 })]),
      expectedUpdatedAt: REVIEW.updatedAt,
    }))
    expect(host.textContent).toContain('配信内容を保存しました')
  })

  it('本文が空のまま保存すると、口を呼ばず本文の欄が赤くなり、真下に理由が出て、本文へ移る', async () => {
    calls.settings.mockResolvedValue({ success: true, data: [{ ...REVIEW, bodyText: '' }] })
    await act(async () => { root.render(<><CampaignEdit campaignKey="review_request" /><ToastHost /></>) })
    await flush()
    await act(async () => { fireEvent.click(button('配信内容を保存する')!) })
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(calls.updateSetting).not.toHaveBeenCalled()
    const body = document.getElementById('nen-edit-body')!
    expect(body.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('nen-edit-body-error')?.textContent).toBe('本文を入力してください')
    expect(body.contains(document.activeElement) || document.activeElement === body).toBe(true)
  })

  it('閲覧のみの人には帯を出し、保存・テスト送信・押せない選ぶ欄を置かない', async () => {
    role.value = verifiedStaffRole('staff')
    await act(async () => { root.render(<><CampaignEdit campaignKey="review_request" /><ToastHost /></>) })
    await flush()
    expect(host.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
    expect(button('配信内容を保存する')).toBeUndefined()
    expect(host.textContent).not.toContain('自分にテストを送る')
    expect([...document.querySelectorAll('button[disabled]')].map((b) => b.textContent)).toEqual([])
    expect(host.textContent).toContain('注文が届いた日から 10 日後')
  })
})

describe('V8 NEN配信「コラムを書く」（yRDwW）', () => {
  it('入力した画像・分類・題名・概要を見本に出し、文字だけへ戻すと画像を外す（送信しない）', async () => {
    await act(async () => { root.render(<ColumnNew />) })
    await flush()
    for (const [label, value] of [['題名', '季節のコラム'], ['分類', '秋のごはん'], ['概要', '食事の短い紹介'], ['記事の URL', 'https://example.test/article']]) {
      await act(async () => { fireEvent.change(host.querySelector(`input[aria-label="${label}"]`)!, { target: { value } }) })
    }
    await act(async () => { fireEvent.click(button('URL で入れる')!) })
    await act(async () => { fireEvent.change(host.querySelector('input[aria-label="画像の URL"]')!, { target: { value: 'https://example.test/article.jpg' } }) })
    const preview = host.querySelector('[data-template-region="preview"]')!
    for (const text of ['季節のコラム', '秋のごはん', '食事の短い紹介', 'コラムを読む']) expect(preview.textContent).toContain(text)
    expect(preview.querySelector('img[src="https://example.test/article.jpg"]')).not.toBeNull()
    await act(async () => { fireEvent.click(host.querySelector('input[type="radio"][value="text"]')!) })
    expect(preview.querySelector('img[src="https://example.test/article.jpg"]')).toBeNull()
    expect((host.querySelector('input[aria-label="画像の URL"]') as HTMLInputElement).value).toBe('')
    expect(calls.createColumn).not.toHaveBeenCalled()
  })

  it('配信対象はタグを1つの欄で選び、保存に乗る', async () => {
    await act(async () => { root.render(<ColumnNew />) })
    await flush()
    expect(host.querySelector('[data-design-node="yRDwW"]')).not.toBeNull()
    for (const heading of ['題名と分類', '記事のリンク', '届く形', 'いつ・だれに出しますか', '読んだ人にすること']) expect(host.textContent).toContain(heading)
    const input = (label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
    await act(async () => { fireEvent.change(input('題名'), { target: { value: '秋の食事、量はどれくらい？' } }) })
    await act(async () => { fireEvent.change(input('記事の URL'), { target: { value: 'https://nen.example.jp/columns/autumn-food' } }) })
    // 配信対象は選ぶ窓の1つの欄。空＝友だち全員、タグを選ぶとそのタグで絞る。
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="配信対象：選択する"]')!.click() })
    await flush()
    const picker = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!
    await act(async () => { picker.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="ペット登録あり"]')!.click() })
    await act(async () => { [...picker.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '選択する（1件）')!.click() })
    await flush()
    expect(host.textContent).toContain('1,240 人に届きます')
    await act(async () => { fireEvent.click(button('下書きを保存')!) })
    await flush()
    expect(calls.createColumn).toHaveBeenCalledWith('account-a', expect.objectContaining({ title: '秋の食事、量はどれくらい？', targetMode: 'tag', targetTagId: 'tag-pet' }))
    expect(calls.push).toHaveBeenCalledWith('/nen-campaigns?tab=columns&highlight=c-new')
  })

  it('題名と記事の URL が無いまま押すと、保存せずに理由を出す', async () => {
    await act(async () => { root.render(<ColumnNew />) })
    await flush()
    await act(async () => { fireEvent.click(button('下書きを保存')!) })
    await flush()
    expect(calls.createColumn).not.toHaveBeenCalled()
    expect(host.textContent).toContain('HTTPSの記事URLを入力してください。')
    const title = host.querySelector('input[aria-label="題名"]') as HTMLInputElement
    const article = host.querySelector('input[aria-label="記事の URL"]') as HTMLInputElement
    expect(title.getAttribute('aria-invalid')).toBe('true')
    expect(article.getAttribute('aria-invalid')).toBe('true')
    expect(host.querySelectorAll('#nen-col-title')).toHaveLength(1)
    expect(host.querySelectorAll('[data-design-part="notice"][role="alert"]')).toHaveLength(0)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    expect(document.activeElement).toBe(title)
    await act(async () => { fireEvent.change(title, { target: { value: '秋の食事' } }) })
    expect(title.getAttribute('aria-invalid')).not.toBe('true')
    expect(host.querySelector('#nen-col-title-error')).toBeNull()
  })

  it('閲覧のみの人には書く欄も保存も置かず、帯と戻る道だけ出す', async () => {
    role.value = verifiedStaffRole('staff')
    await act(async () => { root.render(<ColumnNew />) })
    await flush()
    expect(host.textContent).toContain('閲覧のみで見ています')
    expect(button('下書きを保存')).toBeUndefined()
    expect(host.querySelector('input[aria-label="題名"]')).toBeNull()
    expect([...document.querySelectorAll('button[disabled]')].map((b) => b.textContent)).toEqual([])
  })

  it('ID69: 元のコラムを選ぶ道は共通の文字リンク（TextLink）', async () => {
    await act(async () => { root.render(<ColumnNew />) })
    await flush()
    const link = [...host.querySelectorAll('a')].find((a) => (a.textContent ?? '').includes('一覧で元のコラムを選びます'))!
    expect(link.getAttribute('href')).toBe('/nen-campaigns?tab=columns')
    /* TextLink は矢印の印（svg）を足す。直す前の素のLinkだと印が無く、手書きの「→」が文字に残る。 */
    expect(link.querySelector('svg')).not.toBeNull()
    expect(link.textContent).not.toContain('→')
  })
})

it('保存のぶつかりでは入力を残し、比較では変えず、読み直すときだけ最新を入れる', async () => {
  const { ApiError } = await import('@/lib/api')
  await act(async () => { root.render(<CampaignEdit campaignKey="review_request" />) })
  await flush()
  const input = document.getElementById('nen-edit-body') as HTMLElement
  await act(async () => { input.textContent = '自分の入力'; fireEvent.input(input) })
  calls.updateSetting.mockRejectedValueOnce(new ApiError(409, '競合', 'VERSION_CONFLICT'))
  calls.settings.mockResolvedValue({ success: true, data: [{ ...REVIEW, bodyText: 'ほかの担当者の入力', updatedAt: '2026-10-09T08:00:00Z' }] })
  await act(async () => { fireEvent.click(button('配信内容を保存する')!) })
  await flush()
  expect(input.textContent).toBe('自分の入力')
  expect(button('違いを比べる')).toBeTruthy()
  await act(async () => { fireEvent.click(button('違いを比べる')!) })
  await flush()
  expect(input.textContent).toBe('自分の入力')
  expect(document.body.textContent).toContain('ほかの担当者の入力')
  const reload = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('最新を読み込んで続ける'))!
  await act(async () => { fireEvent.click(reload) })
  await flush()
  expect((document.getElementById('nen-edit-body') as HTMLElement).textContent).toBe('ほかの担当者の入力')
})

it('押された後の説明に設定のボタン名を出し、式を文字として見せない', async () => {
  await act(async () => { root.render(<CampaignEdit campaignKey="review_request" />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(screen.getByText('メッセージの「感想を書く」を押した人に何をするかです')).toBeTruthy()
  expect(host.textContent).not.toContain('${merged.')
})

afterEach(() => { verifiedStaffRole(null) })
