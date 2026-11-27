// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CarouselButtons from './carousel-buttons'

afterEach(cleanup)
function draw(action: Record<string, unknown>) {
  const onChange = vi.fn()
  const fields = { bind: () => ({}), invalid: () => false, error: () => undefined }
  const choice = { label: 'ボタン', kind: 'action', uri: '', text: '', formId: null, actions: [action] }
  render(<CarouselButtons actions={[choice] as never} selectedIndex={0} fields={fields as never} hqHost={false} host={false} folderAccountId={null} liffId={null} sources={{} as never} actionOptions={{ tags: [{ id: 't1', name: '案内' }], fields: [], marks: [], scenarios: [], vars: [] } as never} onChange={onChange} kindOptions={() => ['action']} extraKinds={[]} />)
  return onChange
}
it('未知のタグ操作を付与と誤表示しない', () => {
  const onChange = draw({ key: 'k', actionType: 'tag', config: { op: 'future', tagIds: ['t1'] }, onFailure: 'continue' })
  expect(screen.getByText('タグの操作を確認できません')).toBeTruthy()
  expect(screen.queryByText('タグ「案内」を付ける')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'カード1のボタン1の文字' }), { target: { value: '次へ' } })
  expect(onChange).toHaveBeenCalled()
})
it('未知の動きは確認できないと表示する', () => {
  const onChange = draw({ key: 'k', actionType: 'future-action', config: {}, onFailure: 'continue' })
  expect(screen.getByText('動きを確認できません')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'カード1のボタン1の文字' }), { target: { value: '次へ' } })
  expect(onChange).toHaveBeenCalled()
})
