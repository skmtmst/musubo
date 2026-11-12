// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Field, TextInput } from './form-controls'
afterEach(cleanup)
it('決まり4：任意が二重にならず、上限のある入力は自動で文字数と読み上げ説明を出す', () => {
  render(<Field label="メモ（任意）"><TextInput defaultValue="あいう" maxLength={20} /></Field>)
  expect(screen.getAllByText('任意')).toHaveLength(1)
  expect(screen.queryByText('メモ（任意）')).toBeNull()
  expect(screen.queryByText('3/20文字')).toBeNull()
  const input = screen.getByRole('textbox', { name: 'メモ' })
  fireEvent.focus(input)
  expect(screen.getByText('3/20文字')).toBeTruthy()
  expect(input.getAttribute('aria-describedby')).toContain(screen.getByText('3/20文字').id)
  fireEvent.input(input, { target: { value: 'あいうえお' } })
  expect(screen.getByText('5/20文字')).toBeTruthy()
})
it('必須は札を1つ・任意は出さず、指定された上限と超過を守る', () => {
  const { container } = render(<Field label="名前（必須）" count={{ value: 21, max: 20 }}><TextInput /></Field>)
  expect(screen.getAllByText('必須')).toHaveLength(1)
  expect(screen.queryByText('任意')).toBeNull()
  expect(container.querySelector('[data-field-count="over"]')?.textContent).toBe('21/20文字')
  expect(screen.getByRole('textbox').getAttribute('aria-required')).toBe('true')
})

it('複数の選択肢は欄のラベルで上書きせず、それぞれの名前で操作できる', () => {
  render(<Field label="既定値"><label><input type="checkbox" />A</label><label><input type="checkbox" />B</label></Field>)
  expect(screen.getByRole('checkbox', { name: 'A' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'B' })).toBeTruthy()
})

it('名前の文字数は入力中または上限が近い時だけ残し、郵便・電話は焦点中も出さない', () => {
  const view=render(<Field label="名前"><TextInput defaultValue="abc" maxLength={20}/></Field>)
  const input=screen.getByRole('textbox',{name:'名前'})
  expect(view.container.querySelector('[data-field-count]')).toBeNull()
  fireEvent.focus(input)
  expect(screen.getByText('3/20文字')).toBeTruthy()
  fireEvent.blur(input)
  expect(view.container.querySelector('[data-field-count]')).toBeNull()
  fireEvent.input(input,{target:{value:'a'.repeat(18)}})
  expect(screen.getByText('18/20文字')).toBeTruthy()
  view.rerender(<Field label="郵便番号"><TextInput defaultValue="1234567" maxLength={7}/></Field>)
  fireEvent.focus(screen.getByRole('textbox',{name:'郵便番号'}))
  expect(view.container.querySelector('[data-field-count]')).toBeNull()
  view.rerender(<Field label="連絡先"><TextInput type="tel" defaultValue="09000005678" maxLength={11}/></Field>)
  fireEvent.focus(screen.getByRole('textbox',{name:'連絡先'}))
  expect(view.container.querySelector('[data-field-count]')).toBeNull()
})
