// @vitest-environment happy-dom
/*
 * イベント編集（EventForm）の「保存を忘れない」。
 * 概要・公開設定タブで書きかけがある間だけ、離れるときに確かめる。
 * 枠タブの操作はその場でサーバへ送る即時型なので番兵の対象外。
 * 保存後は書きかけが解け、確認は出ない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventDetail } from '@/lib/api'

const eventsGet = vi.hoisted(() => vi.fn())
const listSlots = vi.hoisted(() => vi.fn())
const updateEvent = vi.hoisted(() => vi.fn())
const routerPush = vi.hoisted(() => vi.fn())

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
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    accounts: [{ id: 'acc-1', name: 'テスト店' }],
    selectedAccount: { id: 'acc-1', name: 'テスト店' },
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

import EventForm from '@/v8/events/edit-form'

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
    questions_json: null,
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
  routerPush.mockClear()
  eventsGet.mockResolvedValue(serverRow(1))
  listSlots.mockResolvedValue({ items: [] })
  updateEvent.mockImplementation(async (_accountId: string, _id: string, _payload: Partial<EventDetail>, version: number) => ({
    ...serverRow(version + 1),
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

function nameInput(): HTMLInputElement {
  const input = host.querySelector('input[placeholder="例：第1回 AAA 説明会"]')
  if (!input) throw new Error('name input not found')
  return input as HTMLInputElement
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

describe('イベント編集の書きかけがある間の離脱確認', () => {
  it('名前を変えて一覧へ戻ると確認が出て、続ければ入力が残る', async () => {
    await renderForm()
    expect(nameInput().value).toBe('体験レッスン')

    await act(async () => {
      nameInput().focus()
      const { fireEvent } = await import('@testing-library/react')
      fireEvent.change(nameInput(), { target: { value: '体験レッスン改' } })
    })

    const breadcrumb = document.createElement('a')
    breadcrumb.href = '/events'
    breadcrumb.textContent = 'イベント予約'
    document.body.appendChild(breadcrumb)
    await click(breadcrumb)
    breadcrumb.remove()
    // 確認の窓は document.body 直下のポータルに出る。
    expect(document.body.textContent).toContain('保存していない変更があります')
    expect(routerPush).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('体験レッスン改')
  })

  it('何も変えていなければ確認を出さない', async () => {
    await renderForm()
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.body.textContent).not.toContain('保存していない変更があります')
  })

  it('保存後は確認を出さない', async () => {
    await renderForm()
    await act(async () => {
      const { fireEvent } = await import('@testing-library/react')
      fireEvent.change(nameInput(), { target: { value: '体験レッスン改' } })
    })
    const saveButton = [...host.querySelectorAll('button')].find((b) => b.textContent === '概要を保存する')
    if (!saveButton) throw new Error('save button not found')
    await click(saveButton)
    expect(updateEvent).toHaveBeenCalledTimes(1)

    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
