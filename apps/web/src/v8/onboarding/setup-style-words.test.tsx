// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { questionsFor, summarizeSetup, type StarterItemState, type StyleState } from './model'
import { SetupTasks } from './setup-card'

afterEach(cleanup)
const pending: StarterItemState[] = [
  { target_id: 'notice', kind: 'automation', is_sample: 1, status: 'draft', draftRevision: 'draft' },
  { target_id: 'menu', kind: 'rich_menu', is_sample: 1, status: 'draft', draftRevision: null },
]

it.each([
  ['restaurant', '予約メニュー', 'お店の', '席の予約設定'],
  ['salon', '施術メニュー', 'サロンの', 'メニュー・料金'],
  ['consult', '面談メニュー', '相談窓口の', '面談の予約設定'],
  ['lesson', '予約メニュー', '教室の', 'クラス・スケジュール'],
  ['ec', 'メニュー', 'ショップの', '商品・お問い合わせ'],
  ['standard', 'メニュー', '案内に使う', 'お知らせ・お申し込み'],
] as const)('%sの選んだ機能の設定は業種の言葉で表示し、確認の操作を保つ', (style, bookingMenu, images, initialMenu) => {
  const state: StyleState = {
    style, styleSelected: true, version: 1,
    answers: { ...Object.fromEntries(questionsFor(style).map(q => [q.key, { mode: 'later' as const }])), image: { mode: 'configured', value: 'keep' } },
  }
  const open = vi.fn()
  const summary = summarizeSetup(state, [], pending)
  const view = render(<SetupTasks heading summary={summary} onOpenStep={open} />)
  expect(screen.getByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
  expect(screen.getByText('入ったお知らせを動かす')).toBeTruthy()
  expect(screen.queryByText(/入った.*メニュー.*を動かす/)).toBeNull()
  expect(screen.getByText(`${images}写真とロゴを入れる`)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '中身を見る' }))
  expect(open).toHaveBeenCalledWith('summary')

  const withMenu = summarizeSetup(state, [], [...pending, { target_id: 'booking', kind: 'booking_menu', is_sample: 1, status: 'inactive', draftRevision: null }])
  view.rerender(<SetupTasks heading summary={withMenu} onOpenStep={open} />)
  expect(screen.getByText(`入った${bookingMenu}・お知らせを動かす`)).toBeTruthy()

  const onlyMenu = summarizeSetup(state, [], [{ target_id: 'booking', kind: 'booking_menu', is_sample: 1, status: 'inactive', draftRevision: null }, { ...pending[0]!, status: 'active' }])
  view.rerender(<SetupTasks heading summary={onlyMenu} onOpenStep={open} />)
  expect(screen.getByText(`入った${bookingMenu}を動かす`)).toBeTruthy()

  const simple = summarizeSetup({ ...state, answers: { ...state.answers, image: { mode: 'configured', value: 'simple' } } }, [], pending)
  view.rerender(<SetupTasks heading summary={simple} onOpenStep={open} />)
  expect(screen.getByText(new RegExp(initialMenu))).toBeTruthy()
  expect(screen.getByRole('link', { name: '確かめる' }).getAttribute('href')).toBe('/getting-started/rich-menu')
  if (style === 'ec' || style === 'standard') expect(view.container.textContent).not.toMatch(/予約|来店|施術|面談|クラス/)

  const active = summarizeSetup(state, [], [{ ...pending[0]!, status: 'active' }])
  view.rerender(<SetupTasks heading summary={active} onOpenStep={open} />)
  expect(screen.queryByRole('button', { name: '中身を見る' })).toBeNull()
  expect(active.done).toBe(summary.done)
})

it('知らない状態の操作不可の項目を受けても、設定画面は他の項目を表示し、誤って有効化させない', () => {
  const state: StyleState = { style: 'salon', styleSelected: true, version: 1, answers: {} }
  const items: StarterItemState[] = [
    { target_id: 'missing', kind: 'booking_menu', is_sample: 1, status: 'future_unknown', draftRevision: null, activationAllowed: false },
    { target_id: 'notice', kind: 'automation', is_sample: 1, status: 'draft', draftRevision: null },
  ]
  render(<SetupTasks heading summary={summarizeSetup(state, [], items)} onOpenStep={vi.fn()} />)
  expect(screen.getByText('入ったお知らせを動かす')).toBeTruthy()
  expect(screen.queryByText(/施術メニュー.*を動かす/)).toBeNull()
})
