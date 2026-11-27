// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import LogRecordJson from './log-record-json'

it.each([30_000, 60_000])('%i文字の記録を少しずつ表示し、コピーは伏せた全文にする', async length => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const sample = { token: '見本の非公開値', message: 'あ'.repeat(length) }
  try {
    act(() => root.render(<LogRecordJson value={sample} canCopy />))
    act(() => host.querySelector('button')!.click())
    expect(host.querySelector('pre')!.textContent!.length).toBeLessThanOrEqual(1000)
    expect(host.querySelector('pre')!.textContent).toContain('［伏せています］')
    expect(host.textContent).not.toContain('見本の非公開値')
    const more = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('続きを表示'))!
    expect(more.textContent).toContain('残り')
    act(() => more.click())
    expect(host.querySelector('pre')!.textContent!.length).toBeGreaterThan(1000)
    const copy = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('JSON をコピー'))!
    await act(async () => copy.click())
    const copied = writeText.mock.calls[0]![0] as string
    expect(copied).toContain('あ'.repeat(length))
    expect(copied).toContain('［伏せています］')
    expect(copied).not.toContain('見本の非公開値')
  } finally { act(() => root.unmount()); host.remove() }
})
