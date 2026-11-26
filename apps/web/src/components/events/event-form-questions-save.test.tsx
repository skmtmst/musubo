// @vitest-environment happy-dom
/*
 * R82: イベントを続けて保存すると申込時の質問が消える回帰試験。
 *
 * Worker は質問を questions_json の文字列で返す。保存後の応答をほぐさず
 * draft へ載せると questions が消え、2回目の保存で questions:null を送って
 * 定義ごと消してしまう。見る筋書き:
 *   1. 質問1件を持つイベントを開くと質問欄に出る
 *   2. 保存しても質問欄に残り、送った質問も残っている
 *   3. もう一度保存しても、送る質問が消えていない
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventDetail } from '@/lib/api'

const eventsGet = vi.hoisted(() => vi.fn())
const listSlots = vi.hoisted(() => vi.fn())
const updateEvent = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      tags: { list: async () => ({ success: true, data: [] }) },
    },
    eventsApi: {
      ...actual.eventsApi,
      getEvent: eventsGet,
      listSlots,
      updateEvent,
    },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    accounts: [{ id: 'acc-1', name: 'テスト店' }],
    selectedAccount: { id: 'acc-1', name: 'テスト店', liffId: 'liff-test' },
    selectedAccountId: 'acc-1',
    loading: false,
  }),
}))

vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import EventForm, { toEventDraft } from '@/v8/events/edit-form'

const QUESTION = { id: 'q1', label: 'アレルギーはありますか', type: 'text' as const, required: true, options: null }

/** Worker が返す行の形。質問は questions_json の文字列でしか返らない。 */
function serverRow(version: number): EventDetail {
  return {
    id: 'ev-1',
    name: '体験レッスン',
    venue_name: null,
    venue_url: null,
    image_url: null,
    description: null,
    description_centered: 0,
    max_bookings_per_friend: null,
    requires_approval: 0,
    approval_deadline_hours: 24,
    cancel_deadline_hours_before: null,
    reminder_day_before_enabled: 1,
    reminder_hours_before: null,
    is_published: 0,
    sort_order: 0,
    confirmation_message_extra: null,
    reminder_message_extra: null,
    og_title: null,
    og_description: null,
    og_image_url: null,
    visible_tag_id: null,
    waitlist_enabled: 0,
    entry_cutoff_hours_before: null,
    target_type: 'single',
    account_ids: null,
    questions_json: JSON.stringify([QUESTION]),
    version,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  eventsGet.mockReset()
  listSlots.mockReset()
  updateEvent.mockReset()
  eventsGet.mockResolvedValue(serverRow(1))
  listSlots.mockResolvedValue({ items: [] })
  /*
   * 本物の口と同じ決めごと: questions が配列なら questions_json へ正規化し、
   * null なら定義ごと消す。行は questions_json の文字列で返す。
   */
  updateEvent.mockImplementation(async (_accountId: string, _id: string, payload: Partial<EventDetail>, version: number) => ({
    ...serverRow(version + 1),
    is_published: payload.is_published ?? 0,
    questions_json: payload.questions ? JSON.stringify(payload.questions) : null,
  }))
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

async function renderForm() {
  await act(async () => { root.render(<EventForm accountId="acc-1" eventId="ev-1" />) })
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

function questionInput(): HTMLInputElement | null {
  return document.querySelector('#eq-label-q1')
}

function saveButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === '概要を保存する')
  expect(found, '「概要を保存」がある').toBeTruthy()
  return found as HTMLButtonElement
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

describe('R82 続けて保存しても質問が消えない', () => {
  it('応答の questions_json をほぐして draft へ戻す', () => {
    const draft = toEventDraft(serverRow(3))
    expect(draft.questions).toEqual([QUESTION])
    expect(draft.version).toBe(3)
  })

  it('1回目の保存で質問を送り、2回目の保存でも質問が残る', async () => {
    await renderForm()
    expect(questionInput()?.value).toBe('アレルギーはありますか')

    await click(saveButton())
    expect(updateEvent).toHaveBeenCalledTimes(1)
    expect(updateEvent.mock.calls[0][2].questions).toEqual([QUESTION])
    // 保存後も質問欄に残っている（消えていたら次の保存で null を送る）。
    expect(questionInput()?.value).toBe('アレルギーはありますか')

    await click(saveButton())
    expect(updateEvent).toHaveBeenCalledTimes(2)
    expect(updateEvent.mock.calls[1][2].questions).toEqual([QUESTION])
  })

  it('概要の保存後も同じタブに残り、予約枠へ自動で移らない', async () => {
    await renderForm()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('保存して次へ'))).toBe(false)
    await click(saveButton())
    expect(updateEvent).toHaveBeenCalledTimes(1)
    expect(questionInput()).not.toBeNull()
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('概要')
  })

  it('予約 URL は公開設定に置き、公開を保存してから表示・コピーする', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await renderForm()
    expect(document.querySelector('input[aria-label="予約 URL"]')).toBeNull()
    const tab = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.includes('公開設定'))!
    await click(tab)
    expect(document.body.textContent).toContain('公開して保存すると、ここに URL が出ます')
    await click(document.querySelector('input[name="event-publish-state"][value="published"]')!)
    expect(document.body.textContent).toContain('公開して保存すると、ここに URL が出ます')
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent === '公開設定を保存する')!
    await click(save)
    const url = document.querySelector<HTMLInputElement>('input[aria-label="予約 URL"]')!
    expect(url.value).toContain('liffId=liff-test')
    expect(url.value).toContain('id=ev-1')
    await click(document.querySelector('button[aria-label="予約 URL をコピー"]')!)
    expect(writeText).toHaveBeenCalledWith(url.value)
    vi.unstubAllGlobals()
  })

  it('横断公開を選ぶと編集中のアカウントを含めて保存し、単一へ戻すと対象の配列を送らない', async () => {
    await renderForm()
    const multi = document.querySelector<HTMLInputElement>('input[name="event-target-type"][value="multi-account-dedup"]')!
    await click(multi)
    expect(multi.checked).toBe(true)
    await click(saveButton())
    expect(updateEvent.mock.calls[0][2]).toMatchObject({ target_type: 'multi-account-dedup', account_ids: ['acc-1'], questions: [QUESTION] })
    // 保存の返事で単一へ戻るため、もう一度横断にしてから単一を選ぶ。
    await click(document.querySelector('input[name="event-target-type"][value="multi-account-dedup"]')!)
    await click(document.querySelector('input[name="event-target-type"][value="single"]')!)
    await click(saveButton())
    expect(updateEvent.mock.calls[1][2]).toMatchObject({ target_type: 'single', account_ids: null, questions: [QUESTION] })
  })
})
