// @vitest-environment happy-dom
/*
 * 質問の部品の「押されたら」の詳しい設定（タグ・友だち情報欄）を、本物の部品で確かめる。
 *
 *   - タグは全件を並べず、閉じた選ぶ欄と選んだ札だけを出す。全件は選ぶ窓の中にだけ並び、いくつでも選べる。
 *   - 友だち情報欄は、欄を選ぶ口と書き込む値の欄を別々に置く。
 *   - 選択肢を並べて見る形では、どの選択肢にも詳しい設定がある。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const scope = vi.hoisted(() => ({ tags: vi.fn(), fields: vi.fn(), scenarios: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('./scenario-reference-data', () => ({ scenarioReferenceData: { tags: scope.tags, friendFields: scope.fields, scenarios: scope.scenarios } }))

import QuestionEditor, { type ScenarioQuestion } from './question-editor'

afterEach(cleanup)

const TAGS = [{ id: 'tag-vip', name: '常連さま' }, { id: 'tag-new', name: 'はじめての方' }]
const FIELDS = [{ id: 'field-rank', name: '会員ランク' }]

function question(): ScenarioQuestion {
  return {
    tapMode: 'single',
    text: '来月も続けますか？',
    choices: [
      { key: 'yes', label: '続ける', behavior: 'none', addTagIds: ['tag-vip'], field: { fieldId: 'field-rank', value: 'ゴールド' } },
      { key: 'no', label: 'やめる', behavior: 'none' },
    ],
  } as ScenarioQuestion
}

async function renderEditor(props: Partial<React.ComponentProps<typeof QuestionEditor>> = {}) {
  scope.tags.mockResolvedValue({ success: true, data: TAGS })
  scope.fields.mockResolvedValue({ success: true, data: FIELDS })
  scope.scenarios.mockResolvedValue({ success: true, data: [] })
  const onChange = vi.fn()
  const view = render(<QuestionEditor value={question()} onChange={onChange} choiceOnly={0} {...props} />)
  await act(async () => {})
  await act(async () => {})
  return { ...view, onChange }
}

it('タグは選んだ札だけを出し、全件は選ぶ窓の中にだけ並んで、いくつでも選べる', async () => {
  const { container, onChange } = await renderEditor()
  expect(container.textContent).toContain('常連さま')
  expect(container.textContent).not.toContain('はじめての方')
  expect(container.querySelector('select')).toBeNull()

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '常連さま' })) })
  expect(screen.getByRole('button', { name: '常連さまを外す' })).toBeTruthy()
  expect(container.textContent).not.toContain('はじめての方')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'タグ：変更する' })) })
  const dialog = screen.getByRole('dialog', { name: 'タグを選ぶ' })
  expect(within(dialog).getByRole('checkbox', { name: /常連さま/ })).toBeTruthy()
  await act(async () => { fireEvent.click(within(dialog).getByRole('checkbox', { name: /はじめての方/ })) })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /決める|選択する|決定/ })) })
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
    choices: [expect.objectContaining({ addTagIds: ['tag-vip', 'tag-new'] }), expect.anything()],
  }))
})

it('友だち情報欄は、欄を選ぶ口と書き込む値の欄を分けて置き、値を直すと保存値に入る', async () => {
  const { onChange } = await renderEditor()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '会員ランク' })) })
  expect(screen.getByRole('button', { name: '友だち情報欄：変更する' })).toBeTruthy()
  const value = screen.getByRole('textbox', { name: '友だち情報欄に書き込む値' }) as HTMLInputElement
  expect(value.value).toBe('ゴールド')
  await act(async () => { fireEvent.change(value, { target: { value: 'プラチナ' } }) })
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
    choices: [expect.objectContaining({ field: { fieldId: 'field-rank', value: 'プラチナ' } }), expect.anything()],
  }))
})

it('選択肢を並べて見る形では、どの選択肢にも「タグ・記録などの詳しい設定」がある', async () => {
  await renderEditor({ choiceOnly: undefined, choiceColumns: true })
  expect(screen.getAllByText('タグ・記録などの詳しい設定')).toHaveLength(2)
})

it('ID69: 実行されない設定の消す操作は押せる形（text）', async () => {
  const value = question()
  value.choices = [{ key: 'a', label: 'サイトを開く', behavior: 'url', url: 'https://example.com/x', removeTagIds: ['tag-vip'] }] as ScenarioQuestion['choices']
  await renderEditor({ value })
  /* 直す前の素のbuttonだと data-variant が無く落ちる。 */
  expect(screen.getByRole('button', { name: '実行されない設定を消す' }).getAttribute('data-variant')).toBe('text')
})
