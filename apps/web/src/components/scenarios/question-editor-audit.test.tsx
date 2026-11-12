// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const scope = vi.hoisted(() => ({ account: 'a', tags: vi.fn(), fields: vi.fn(), scenarios: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: scope.account }) }))
vi.mock('./scenario-reference-data', () => ({ scenarioReferenceData: { tags: scope.tags, friendFields: scope.fields, scenarios: scope.scenarios } }))
vi.mock('@/components/shared/select', () => ({ default: ({ value, options, onChange }: {value: string; onChange: (value: string) => void; options: Array<{value: string; label: string}>; 'aria-label'?: string}) => <select value={value} onChange={e => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> }))
import QuestionEditor from './question-editor'
afterEach(cleanup)
const question = { tapMode: 'single' as const, title: '質問', text: '選ぶ', choices: ['A','B'].map(key => ({ key, label: key, behavior: 'scenario' as const, scenario: { op: 'start' as const, scenarioId: 's', restart: 'from_start' as const } })) }
it('一つだけ編集する選択肢には、全選択肢を比べる列を重ねない', async () => {
  for (const fn of [scope.tags, scope.fields, scope.scenarios]) fn.mockResolvedValue({ success: true, data: [] })
  const view = render(<QuestionEditor value={question} onChange={() => {}} choiceColumns />)
  await act(async () => {})
  const comparison = view.container.querySelector('.xl\\:grid-cols-2')!
  expect(comparison).not.toBeNull()
  expect(view.container.querySelectorAll('input[type="radio"]').length).toBe(4)
  view.rerender(<QuestionEditor value={question} onChange={() => {}} choiceColumns choiceOnly={1} />)
  await act(async () => {})
  expect(view.container.querySelector('.xl\\:grid-cols-2')).toBeNull()
  expect(view.container.querySelectorAll('input[type="radio"]').length).toBe(2)
  expect(view.container.querySelectorAll('details').length).toBe(1)
})
it('WEB265: 選択肢ごとの再開ラジオを独立したグループにする', async () => {
  for (const fn of [scope.tags, scope.fields, scope.scenarios]) fn.mockResolvedValue({ success: true, data: [] })
  const view = render(<QuestionEditor value={question} onChange={() => {}} choiceColumns />)
  await act(async () => {})
  const groups = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(el => el.name)
  expect(groups.length).toBe(4)
  expect(new Set(groups).size).toBe(2)
})

it('WEB261/262: 持ち主の候補を使い、切替前の遅い応答を捨てる', async () => {
  let resolveOld!: (value: unknown) => void
  scope.tags.mockImplementation((id: string) => id === 'owner-a' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve({ success: true, data: [{ id: 'b', name: '新しいタグ' }] }))
  scope.fields.mockResolvedValue({ success: true, data: [] })
  scope.scenarios.mockResolvedValue({ success: true, data: [] })
  const view = render(<QuestionEditor accountId="owner-a" value={question} onChange={() => {}} choiceColumns />)
  await act(async () => {})
  expect(scope.tags).toHaveBeenLastCalledWith('owner-a')
  view.rerender(<QuestionEditor accountId="owner-b" value={question} onChange={() => {}} choiceColumns />)
  await act(async () => {})
  await act(async () => resolveOld({ success: true, data: [{ id: 'old', name: '古いタグ' }] }))
  // タグの候補は選ぶ窓の中に並ぶ。窓を開いて、切替後の持ち主の候補だけがあることを見る。
  fireEvent.click(screen.getAllByRole('button', { name: '行うことを足す' })[0])
  fireEvent.click(screen.getByRole('menuitem', { name: /タグを付ける/ }))
  const dialog = (await screen.findAllByRole('dialog')).at(-1)!
  const names = within(dialog).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label') ?? box.textContent ?? '')
  expect(names.some((name) => name.includes('古いタグ'))).toBe(false)
  expect(names.some((name) => name.includes('新しいタグ'))).toBe(true)
})


it('共通の選択肢のボタン名も20文字の入力上限を持ち、読み込んだ長い値は切り捨てない', async () => {
  for (const fn of [scope.tags, scope.fields, scope.scenarios]) fn.mockResolvedValue({ success: true, data: [] })
  const long = 'あ'.repeat(25)
  const view = render(<QuestionEditor value={{ ...question, choices: [{ ...question.choices[0], label: long }] }} onChange={() => {}} choiceColumns />)
  await act(async () => {})
  const label = view.container.querySelector('input[id$="-choice-0-label"]') as HTMLInputElement
  expect(label.maxLength).toBe(20)
  expect(label.value).toBe(long)
})

it('長い選択肢の見出しは全文を確認できる', async () => {
  for (const fn of [scope.tags, scope.fields, scope.scenarios]) fn.mockResolvedValue({ success: true, data: [] })
  const label = 'あ'.repeat(25)
  render(<QuestionEditor value={{ ...question, choices: [{ ...question.choices[0], label }] }} onChange={() => {}} />)
  const heading = screen.getByRole('button', { name: `選択肢1 ${label}` })
  expect(within(heading).getByText(label).getAttribute('title')).toBe(label)
})

it('閉じた選択肢でも超過値の欄を開いて理由を出し、訂正すると消す', async () => {
  for (const fn of [scope.tags, scope.fields, scope.scenarios]) fn.mockResolvedValue({ success: true, data: [] })
  const long = { ...question, choices: [question.choices[0], { ...question.choices[1], label: 'あ'.repeat(25) }] }
  const view = render(<QuestionEditor value={long} onChange={() => {}} />)
  await act(async () => {})
  const input = view.container.querySelector('input[id$="-choice-1-label"]') as HTMLInputElement
  expect(input).toBeTruthy()
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('ボタンの文字は20文字以内で入力してください。')
  expect(input.value).toBe('あ'.repeat(25))
  fireEvent.change(input, { target: { value: 'あ'.repeat(20) } })
  view.rerender(<QuestionEditor value={{ ...long, choices: [long.choices[0], { ...long.choices[1], label: 'あ'.repeat(20) }] }} onChange={() => {}} />)
  await act(async () => {})
  expect(screen.queryByText('ボタンの文字は20文字以内で入力してください。')).toBeNull()
  expect((view.container.querySelector('input[id$="-choice-1-label"]') as HTMLInputElement)?.value).toBe('あ'.repeat(20))
})
