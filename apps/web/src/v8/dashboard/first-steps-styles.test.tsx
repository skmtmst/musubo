// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FirstStepsCard, FirstStepsFeedback, summarizeFirstSteps } from './first-steps'
import { buildStepsFromApi, stepsForStyle, type StyleSetupProgress } from '@/v8/settings/getting-started/steps'
import { ACCOUNT_STYLES } from '@line-crm/shared'

afterEach(cleanup)
const base = () => buildStepsFromApi(['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map(key => ({ key, state: key === 'accounts' || key === 'featureSet' ? 'done' : 'todo', href: '/getting-started', reason: null })) as Parameters<typeof buildStepsFromApi>[0])
const restaurant: StyleSetupProgress = { style: 'restaurant', steps: { attributes: { complete: false }, hours: { complete: false }, friendAdd: { complete: true }, scenario: { complete: false }, followup: { complete: false } } }

it.each(ACCOUNT_STYLES)('%sも同じカードの段・数・直接リンクを使い、営業時間の段を含める', style => {
  const summary = summarizeFirstSteps(base(), style, style === 'restaurant' ? restaurant : undefined)
  render(<FirstStepsCard summary={summary} folded={false} onToggle={() => {}} />)
  const list = screen.getByRole('list')
  expect(within(list).getAllByRole('listitem')).toHaveLength(style === 'restaurant' ? 8 : 7)
  const progress = screen.getByRole('progressbar')
  expect(progress.getAttribute('aria-valuemax')).toBe(String(summary.total))
  expect(progress.getAttribute('aria-valuenow')).toBe(String(summary.done))
  expect(within(list).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(summary.steps.filter(step => !step.done && step.href).map(step => step.href))
  if (style === 'restaurant') {
    expect(screen.getByText('3 / 8 済み')).toBeTruthy()
    expect(screen.getByRole('link', { name: '営業時間を設定する（開く）' }).getAttribute('href')).toBe('/restaurant-test/google?tab=hours')
    expect(stepsForStyle(stepsForStyle(base(), style, restaurant), style, restaurant)).toEqual(stepsForStyle(base(), style, restaurant))
  }
})
it('Googleの営業時間が設定済みでも営業時間を開ける', () => {
  const completed = { ...restaurant, steps: { ...restaurant.steps, hours: { complete: true } } }
  render(<FirstStepsCard summary={summarizeFirstSteps(base(), 'restaurant', completed)} folded={false} onToggle={() => {}} />)
  expect(screen.getByRole('link', { name: '営業時間を設定する（開く）' }).getAttribute('href')).toBe('/restaurant-test/google?tab=hours')
})
it('全て済めば同じ頭の1行だけにし、未確認の段があれば済みにしない', () => {
  const summary = summarizeFirstSteps(base().map(step => ({ ...step, state: 'done' as const })))
  const view = render(<FirstStepsCard summary={summary} folded={false} onToggle={() => {}} />)
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.getByText('6 / 6 済み')).toBeTruthy()
  view.rerender(<FirstStepsCard summary={summarizeFirstSteps(base(), 'restaurant')} folded={false} onToggle={() => {}} />)
  expect(screen.getByRole('list')).toBeTruthy()
  expect(screen.queryByText('8 / 8 済み')).toBeNull()
})
it('閲覧のみでも段を見せ、編集のリンクを灰色の理由付き操作にする', () => {
  const toggle = vi.fn()
  render(<FirstStepsCard summary={summarizeFirstSteps(base(), 'restaurant', restaurant)} folded={false} onToggle={toggle} readOnly />)
  expect(screen.queryAllByRole('link')).toHaveLength(0)
  const buttons = screen.getAllByRole('button', { name: '開く', exact: true })
  expect(buttons.length).toBeGreaterThan(0)
  for (const button of buttons) { expect(button.getAttribute('aria-disabled')).toBe('true'); expect(button.getAttribute('aria-describedby')).toBeTruthy(); fireEvent.click(button) }
  expect(toggle).not.toHaveBeenCalled()
})
it('権限不足は通信障害と分け、再試行を出さない', () => {
 render(<FirstStepsFeedback error={{status:403}} onRetry={() => {}} />);
 expect(screen.getByText(/権限がありません/)).toBeTruthy();
 expect(screen.queryByRole('button')).toBeNull();
});
