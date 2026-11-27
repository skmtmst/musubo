// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import LogRecordJson, { LOG_RECORD_SHOWN_CHARS } from './log-record-json'

it('長い記録を省略するとき絵文字の途中で切らず、コピーは全文を保つ', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const prefix = '{\n  "message": "'
  const value = { message: 'あ'.repeat(LOG_RECORD_SHOWN_CHARS - 1 - prefix.length) + '😀' + '後'.repeat(20) }
  try {
    act(() => root.render(<LogRecordJson value={value} canCopy />))
    act(() => host.querySelector('button')!.click())
    const displayed = host.querySelector('pre')!.textContent!
    expect(displayed.length).toBe(LOG_RECORD_SHOWN_CHARS - 1)
    expect(host.textContent).toContain('先頭の 99,999 文字だけ')
    expect(/[\uD800-\uDBFF]$/.test(displayed)).toBe(false)
    const copy = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('JSON をコピー'))!
    await act(async () => copy.click())
    expect(writeText.mock.calls[0]![0]).toContain('😀')
    expect(writeText.mock.calls[0]![0]).toContain('後'.repeat(20))
  } finally { act(() => root.unmount()); host.remove() }
})
