// @vitest-environment happy-dom
import { fireEvent } from '@testing-library/react'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  webinarApi: { webinarSession: api.load, setSessionCapacity: api.save, videoAsset: async () => ({ data: { asset: null } }) },
}))
import WebinarVideoTestPane from '@/test-utils/webinar-video'
import type { Webinar, WebinarEditor } from '@/lib/api'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

const START = Math.floor(Date.parse('2026-10-08T20:00:00+09:00') / 1000)
const SESSION = { sessionStartAt: START, capacity: 50, reservedCount: 38, remaining: 12, state: 'open' }
const roots: Root[] = []
const editing = vi.fn()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function render(canEdit = true) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<WebinarVideoTestPane initialWebinar={{ id: 'webinar-1', title: 'ウェビナー', videoPrefix: null, durationSeconds: 1800, schedule: [{ type: 'once', at: '2026-10-08T20:00:00+09:00' }] } as Webinar} initialEditor={{ version: 2, deliveryKind: 'scheduled', actionPolicy: { missingResultPolicy: 'retry_next_day' } } as WebinarEditor} readOnly={!canEdit} onDirtyChange={editing} />))
  return host
}

async function click(host: HTMLElement, label: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label')?.includes(label))
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

async function change(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label$="の定員（人）"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    fireEvent.change(input, { target: { value } })
  })
}

describe('開催回の定員と申込状況', () => {
  beforeEach(() => {
    api.load.mockResolvedValue({ data: { session: SESSION } })
    api.save.mockImplementation(async (_id, _at, capacity) => ({ data: { session: { ...SESSION, capacity } } }))
  })
  afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.resetAllMocks()
  })

  it('対象の日時で取得し、定員・申込・残席を実数で表示する', async () => {
    const host = await render()
    expect(api.load).toHaveBeenCalledWith('webinar-1', START)
    expect(host.textContent).toContain('50 人')
    expect(host.textContent).toContain('38 人')
    expect(host.textContent).toContain('残り 12 人')
  })

  it('保存失敗で入力を残し、再保存が成功したら未保存を解除する', async () => {
    api.save.mockRejectedValueOnce(new Error('offline'))
    const host = await render()
    await click(host, 'の開催回の操作')
    await click(host, '定員を変更する')
    await change(host, '60')
    expect(editing).toHaveBeenLastCalledWith(true)
    await click(host, '定員を保存')
    expect(api.save).toHaveBeenLastCalledWith('webinar-1', START, 60)
    expect(host.querySelector<HTMLInputElement>('input[aria-label$="の定員（人）"]')?.value).toBe('60')
    expect(host.textContent).toContain('入力は残しています')
    await click(host, '定員を保存')
    expect(host.querySelector<HTMLInputElement>('input[aria-label$="の定員（人）"]')).toBeNull()
    expect(host.textContent).toContain('60 人')
    expect(editing).toHaveBeenLastCalledWith(false)
  })

  it('小数を保存せず、空欄は無制限として保存する', async () => {
    const host = await render()
    await click(host, 'の開催回の操作')
    await click(host, '定員を変更する')
    await change(host, '3.5')
    await click(host, '定員を保存')
    expect(api.save).not.toHaveBeenCalled()
    expect(host.textContent).toContain('整数')
    await change(host, '')
    await click(host, '定員を保存')
    expect(api.save).toHaveBeenCalledWith('webinar-1', START, null)
    expect(host.textContent).toContain('無制限')
  })

  it('取得失敗は人数を推測せず、読み直して実数へ戻す', async () => {
    api.load.mockRejectedValueOnce(new Error('offline'))
    const host = await render()
    expect([...host.querySelectorAll('[aria-labelledby="webinar-sessions-title"] span')].some(node => node.textContent === '無制限')).toBe(false)
    expect(host.textContent).toContain('読み込めません')
    await click(host, 'もう一度読み込む')
    expect(host.textContent).toContain('50 人')
    expect(api.load).toHaveBeenCalledTimes(2)
  })

  it('閲覧専用では定員変更を開始できない', async () => {
    const host = await render(false)
    expect(host.querySelector('button[aria-label$="の開催回の操作"]')).toBeNull()
    expect(host.querySelector('input[aria-label$="の定員（人）"]')).toBeNull()
    expect(api.save).not.toHaveBeenCalled()
  })
})
