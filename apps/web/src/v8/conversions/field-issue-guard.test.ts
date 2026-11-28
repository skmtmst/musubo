// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusConversionField } from './field-issue'

describe('focusConversionField の入れ子詳細展開と select / disabled 保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('入れ子の閉じた details を外側からすべて開き、disabled を飛ばして select へフォーカスする', () => {
    document.body.innerHTML = `
      <details id="outer">
        <summary>詳細</summary>
        <details id="inner">
          <summary>さらに詳細</summary>
          <div id="cv-target">
            <button type="button" disabled>無効ボタン</button>
            <select id="cv-select"><option value="a">A</option></select>
          </div>
        </details>
      </details>
    `
    const outer = document.getElementById('outer') as HTMLDetailsElement
    const inner = document.getElementById('inner') as HTMLDetailsElement
    const select = document.getElementById('cv-select') as HTMLSelectElement
    expect(outer.open).toBe(false)
    expect(inner.open).toBe(false)

    focusConversionField('cv-target')

    expect(outer.open).toBe(true)
    expect(inner.open).toBe(true)
    expect(document.activeElement).toBe(select)
  })

  it('要素自体が select の場合も直接フォーカスし、空IDでも落ちない', () => {
    document.body.innerHTML = `<select id="cv-direct"><option value="1">1</option></select>`
    const select = document.getElementById('cv-direct') as HTMLSelectElement
    focusConversionField('')
    focusConversionField('cv-direct')
    expect(document.activeElement).toBe(select)
  })
})
