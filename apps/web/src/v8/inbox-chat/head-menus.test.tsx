
// @vitest-environment happy-dom
/*
 * ★V8 会話の頭（ XqSvX・段2「5. 会話の頭のメニュー」）。
 * - 担当・対応状況は1つだけ選ぶ。四角のチェックボックスは出さない（オーナー指摘）
 * - 共通の選ぶ欄（shared/select）を使う。選んでいる行は aria-selected
 * - メールの会話でも同じ頭：☆と探すは渡したときだけ出る
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConversationHead from './conversation-head'
import { HeadStatusMenu } from '@/components/shared/inbox-head-menus'

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; vi.unstubAllGlobals() })

const operators = [{ id: 'op-k', name: 'Kenta' }, { id: 'op-m', name: 'Masato' }]

function mount(extra: Partial<React.ComponentProps<typeof ConversationHead>> = {}) {
  const onOperator = vi.fn()
  const onStatus = vi.fn()
  render(
    <ConversationHead
      name="見本 25"
      sub="メール・発送について"
      operator={{ value: 'op-k', operators, onChange: onOperator }}
      status={{ value: 'unread', onChange: onStatus }}
      {...extra}
    />,
  )
  return { onOperator, onStatus }
}

describe('会話の頭のメニュー', () => {
  test('V8で状態を変えると札と点の色が同時に変わり、保存失敗で戻した値も反映する', () => {
    document.documentElement.dataset.theme = 'v8'
    const onChange = vi.fn()
    const { rerender } = render(<HeadStatusMenu value="unread" onChange={onChange} />)
    const button = screen.getByRole('button', { name: '対応状況を変える' })
    expect(button.dataset.tone).toBe('danger')
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('option', { name: '保留' }).querySelector('button')!)
    expect(onChange).toHaveBeenCalledWith('on_hold')
    for (const [value, tone] of [['on_hold', 'neutral'], ['in_progress', 'warning'], ['resolved', 'success'], ['unread', 'danger']] as const) {
      rerender(<HeadStatusMenu value={value} onChange={onChange} />)
      expect(button.dataset.tone).toBe(tone)
      expect(button.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(tone)
    }
  })

  test('対応状況は1つだけ選ぶ一覧。チェックボックスは出さず、選ぶと変わる', () => {
    const { onStatus } = mount()
    fireEvent.click(screen.getByRole('button', { name: '対応状況を変える' }))
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['未対応', '対応中', '保留', '対応済み'])
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.click(options[2].querySelector('button')!)
    expect(onStatus).toHaveBeenCalledWith('on_hold')
  })

  test('担当は1つだけ選ぶ一覧で、選ぶと変わる。未割り当ても選べる', async () => {
    const { onOperator } = mount()
    expect(screen.getByRole('button', { name: '担当者を変える' }).parentElement?.textContent).toContain('Kenta')
    fireEvent.click(screen.getByRole('button', { name: '担当者を変える' }))
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const options = screen.getAllByRole('radio')
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['Kenta', 'Masato', '未割り当て'])
    expect((options[0] as HTMLInputElement).checked).toBe(true)
    fireEvent.click(options[1])
    fireEvent.click(screen.getByRole('button', { name: '選ぶ' }))
    expect(onOperator).toHaveBeenCalledWith('op-m')
  })

  test('メールの会話：名前の下に件名。☆と探すは渡したときだけ', () => {
    mount()
    expect(screen.getByText('メール・発送について')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '注目にする' })).toBeNull()
    expect(screen.queryByRole('button', { name: '会話の中を探す（⌘F）' })).toBeNull()
    cleanup()
    const onToggle = vi.fn()
    mount({ attention: { on: false, saving: false, onToggle }, search: { open: false, onToggle: () => undefined } })
    fireEvent.click(screen.getByRole('button', { name: '注目にする' }))
    expect(onToggle).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '会話の中を探す（⌘F）' })).toBeTruthy()
  })

  test('閲覧のみの注目は焦点と理由を残し、押しても変えない', () => {
    const onToggle = vi.fn()
    const reason = '閲覧のみのため変更できません。オーナーか管理者に頼んでください。'
    mount({ attention: { on: true, saving: false, onToggle, lockedReason: reason } })
    const button = screen.getByRole('button', { name: '注目から外す' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(reason)
    fireEvent.click(button)
    expect(onToggle).not.toHaveBeenCalled()
  })
})

test('長い名前と担当は省略しても全文を確認できる', () => {
  const longName = '山田 とても長いお客さまのお名前'
  const longOperator = '鈴木 とても長い担当者のお名前'
  mount({ name: longName, operator: { value: 'long', operators: [{ id: 'long', name: longOperator }], onChange: vi.fn() } })
  expect(screen.getByRole('button', { name: longName }).getAttribute('title')).toBe(longName)
  expect(screen.getByRole('button', { name: '担当者を変える' }).parentElement?.querySelector('[data-choice-value]')?.getAttribute('title')).toContain(longOperator)
})
