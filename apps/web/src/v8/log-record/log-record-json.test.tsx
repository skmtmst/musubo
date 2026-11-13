// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogRecordJson, { LOG_RECORD_SHOWN_CHARS } from './log-record-json'
import { formatLogRecord, REDACTED, redactLogRecord } from './redact'

let host: HTMLDivElement
let root: Root
const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  if (!found) throw new Error(`ボタン「${text}」が無い`)
  return found as HTMLButtonElement
}

const SECRET_RECORD = {
  id: 'run_1',
  status: 'failed',
  headers: { Authorization: 'Bearer abc.def.ghi', 'X-Line-Signature': 'sig-value', 'content-type': 'application/json' },
  webhookSecret: 'whsec_123',
  accessToken: 'token-value',
  friend: { displayName: '見本 143', email: 'hanako@example.com', phone: '090-0000-0000', lineUserId: 'U0123' },
  targetUrl: 'https://example.com/hook',
  note: 'see https://example.com/cb?token=leak#frag',
  raw: 'Bearer zzz',
  jwt: 'eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q',
  attempts: [{ at: '2026-10-25T08:00:00.000Z', password: 'pw' }],
}

describe('記録の伏せ方', () => {
  it('秘密値・個人情報の項目と鍵の形の値を伏せ、元の値は変えない', () => {
    const text = formatLogRecord(SECRET_RECORD)
    for (const leak of ['abc.def.ghi', 'sig-value', 'whsec_123', 'token-value', '見本 143', 'hanako@example.com', '090-0000-0000', 'U0123', 'https://example.com/hook', 'token=leak', 'zzz', 'SflKxwRJSMeKKF2Q', '"pw"']) {
      expect(text).not.toContain(leak)
    }
    expect(text).toContain('"status": "failed"')
    expect(text).toContain('"content-type": "application/json"')
    expect(text).toContain(`https://example.com/cb?${REDACTED}`)
    expect(SECRET_RECORD.webhookSecret).toBe('whsec_123')
  })

  it('空の項目は空のまま・自分を指す記録でも止まらない', () => {
    const loop: Record<string, unknown> = { token: null, secret: '' }
    loop.self = loop
    expect(redactLogRecord(loop)).toEqual({ token: null, secret: '', self: '［同じ記録を指しています］' })
  })
})

describe('記録の JSON を開いて写す', () => {
  it('閉じている間は整形せず、開くと伏せた後の JSON を出して写せる', async () => {
    let reads = 0
    const value = { ...SECRET_RECORD, get status() { reads += 1; return 'failed' } }
    act(() => root.render(<LogRecordJson value={value} label="やり取り" canCopy />))
    expect(host.querySelector('pre')).toBeNull()
    expect(reads).toBe(0)
    expect(host.textContent).not.toContain('JSON をコピー')
    expect(button('やり取りの JSON を開く').getAttribute('aria-expanded')).toBe('false')

    act(() => button('やり取りの JSON を開く').click())
    const pre = host.querySelector('pre')
    expect(pre?.textContent).toContain('"status": "failed"')
    expect(pre?.textContent).not.toContain('whsec_123')
    expect(button('やり取りの JSON を閉じる').getAttribute('aria-expanded')).toBe('true')

    await act(async () => { button('JSON をコピー').click() })
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0]![0]
    expect(copied).toBe(pre?.textContent)
    expect(copied).not.toContain('Bearer')
    expect(copied).not.toContain('見本 143')
  })

  it('閲覧のみの人には写す操作を出さない（開いて読むのはできる）', () => {
    act(() => root.render(<LogRecordJson value={{ id: 'r' }} canCopy={false} />))
    act(() => button('記録の JSON を開く').click())
    expect(host.querySelector('pre')?.textContent).toContain('"id": "r"')
    expect(host.textContent).not.toContain('JSON をコピー')
  })

  it('大きい記録は先頭だけを出し、写すのは全文', async () => {
    const big = { body: 'あ'.repeat(LOG_RECORD_SHOWN_CHARS + 500) }
    act(() => root.render(<LogRecordJson value={big} canCopy />))
    act(() => button('記録の JSON を開く').click())
    expect(host.querySelector('pre')!.textContent!.length).toBe(LOG_RECORD_SHOWN_CHARS)
    expect(host.textContent).toContain('先頭の 100,000 文字だけ')
    await act(async () => { button('JSON をコピー').click() })
    expect(writeText.mock.calls[0]![0].length).toBeGreaterThan(LOG_RECORD_SHOWN_CHARS)
  })
})
