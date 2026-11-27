// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { emptyLayout } from '@line-crm/shared'
import { FormPhone } from './phone'

afterEach(cleanup)
it('初期選択のないプルダウンは見本でも「選択してください」と表示する', () => {
  const layout = emptyLayout()
  layout.sections[0].blocks = [{ id: 'question', kind: 'input', type: 'select', name: 'choice', label: '希望', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } as never]
  render(<FormPhone layout={layout} pageIndex={0} accountName="見本" bookingMenus={[]} />)
  expect((screen.getByLabelText('希望') as HTMLSelectElement).value).toBe('')
})

it('選択肢に初期選択がある場合は見本にも反映する', () => {
  const layout = emptyLayout()
  layout.sections[0].blocks = [{ id: 'question', kind: 'input', type: 'select', name: 'choice', label: '希望', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', defaultSelected: true }] } as never]
  render(<FormPhone layout={layout} pageIndex={0} accountName="見本" bookingMenus={[]} />)
  expect((screen.getByLabelText('希望') as HTMLSelectElement).value).toBe('B')
})
