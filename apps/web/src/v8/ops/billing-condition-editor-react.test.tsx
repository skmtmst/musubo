// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NORMAL_MUSUBO_CONDITION, type MusuboConditionDefinition } from '@line-crm/shared'
import BillingConditionEditor from './billing-condition-editor'

let host: HTMLDivElement
let root: Root
const onSave = vi.fn(async (_condition: MusuboConditionDefinition) => {})
const onCreate = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onSave.mockClear()
  onCreate.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function editInput(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find((item) => item.textContent?.includes(label))?.querySelector('input')
  expect(input).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input!.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('運営の利用条件編集', () => {
  it('料金の初期値と割引対象を示し、変更後の料金を保存する', async () => {
    await act(async () => { root.render(<BillingConditionEditor conditions={[{ ...NORMAL_MUSUBO_CONDITION }]} onSave={onSave} onCreate={onCreate} />) })
    expect(host.textContent).toContain('¥5,900')
    expect(host.textContent).toContain('¥19,300')
    expect(host.textContent).toContain('LINEアカウント基本料金のみ（固定）')
    await act(async () => { editInput('LINE 1個目の基本料金', '5000') })
    expect(host.textContent).toContain('¥5,000')
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === '変更を保存')!
    await act(async () => { save.click() })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ schedule: expect.objectContaining({ firstLineYen: 5000, headquartersYen: 5500, linkedAccountSlotYen: 3300 }) }))
  })

  it('条件の新規作成操作を親画面へ渡す', async () => {
    await act(async () => { root.render(<BillingConditionEditor conditions={[{ ...NORMAL_MUSUBO_CONDITION }]} onSave={onSave} onCreate={onCreate} />) })
    const create = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('新しい条件'))!
    await act(async () => { create.click() })
    expect(onCreate).toHaveBeenCalledOnce()
  })
})
