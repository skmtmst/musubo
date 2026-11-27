// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import LogRecordJson from './log-record-json'

it('記録に特殊な項目名があっても開いた JSON で内容を確認できる', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const value = JSON.parse('{"__proto__":{"result":"見本の結果"}}')
    act(() => root.render(<LogRecordJson value={value} canCopy={false} />))
    act(() => host.querySelector('button')!.click())
    expect(host.querySelector('pre')?.textContent).toContain('"__proto__"')
    expect(host.querySelector('pre')?.textContent).toContain('見本の結果')
  } finally { act(() => root.unmount()); host.remove() }
})
