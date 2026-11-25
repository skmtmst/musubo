// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Zap } from 'lucide-react'
import TapActionField from './tap-action-field'
import { emptyTapAction, type TapActionValue } from '@/lib/tap-actions'

afterEach(cleanup)

test('格子指定は印付きの全種類を直接選べ、既存の値変更と閲覧表示を保つ', () => {
  const change = vi.fn()
  const props = { name: '面 A', value: emptyTapAction('uri'), onChange: change, hasLiff: true, kindPresentation: 'grid' as const }
  const { rerender } = render(<TapActionField {...props} extraKinds={[{ value: 'action', label: '動きを実行する', icon: Zap }]} />)
  const group = screen.getByRole('group', { name: '面 Aを押したら' })
  expect(within(group).getAllByRole('radio')).toHaveLength(7)
  expect((within(group).getByRole('radio', { name: 'URLを開く' }) as HTMLInputElement).checked).toBe(true)
  expect(within(group).getByRole('radio', { name: '予約' }).closest('label')?.querySelector('svg')).toBeTruthy()
  fireEvent.click(within(group).getByRole('radio', { name: '予約' }))
  expect(change).toHaveBeenLastCalledWith({ kind: 'booking', refId: '' })
  rerender(<TapActionField {...props} readOnly />)
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.getByLabelText('面 Aを押したら：URLを開く')).toBeTruthy()
})

function openKinds() {
  fireEvent.click(screen.getByRole('button', { name: 'ボタン1を押したら' }))
  return screen.getByRole('listbox')
}

test('開いた一覧は6つ（名前＋1行の説明）で、画面が足した種類は後ろに並ぶ', () => {
  render(<TapActionField name="ボタン1" value={emptyTapAction()} onChange={() => {}} hasLiff extraKinds={[{ value: 'action', label: '動きを実行する', icon: Zap }]} />)
  const options = within(openKinds()).getAllByRole('option')
  expect(options.map((option) => option.textContent)).toEqual([
    'URLを開くホームページや外のページを開く',
    'テキストを送る決めた言葉をお客さまから送ったことにする',
    '予約予約ページを開く（メニューを決めて開くこともできる）',
    '回答フォーム作ってある回答フォームを開く',
    '予約履歴お客さまの予約の一覧を開く（変更・取り消し）',
    '来店スタンプお客さまのスタンプカードを開く',
    '動きを実行する',
  ])
})

test('種類を変えると選んだものを空にして渡す', () => {
  const change = vi.fn()
  render(<TapActionField name="ボタン1" value={{ kind: 'form', uri: '', text: '', refId: 'f1' }} onChange={change} hasLiff />)
  fireEvent.click(within(openKinds()).getByText('予約'))
  expect(change).toHaveBeenCalledWith({ kind: 'booking', refId: '' })
})

test('LIFF の無い店で LIFF の要る動きを選ぶと、中身の欄に案内と［設定を開く］', () => {
  const { rerender } = render(<TapActionField name="ボタン1" value={emptyTapAction('booking_history')} onChange={() => {}} hasLiff={false} liffSettingsHref="/accounts/detail?id=a1" />)
  expect(screen.getByText('この動きは LIFF の設定が要ります')).toBeTruthy()
  expect(screen.getByRole('link', { name: '設定を開く' }).getAttribute('href')).toBe('/accounts/detail?id=a1')
  // 6つとも選べる（LIFF が無くても隠さない）。
  expect(within(openKinds()).getAllByRole('option')).toHaveLength(6)
  // 統括は配るときに各店の LIFF に置き換えるので出さない。
  rerender(<TapActionField name="ボタン1" value={emptyTapAction('booking_history')} onChange={() => {}} hasLiff={false} scope="hq" />)
  expect(screen.queryByText('この動きは LIFF の設定が要ります')).toBeNull()
  expect(screen.getByText(/押した人の予約の一覧/)).toBeTruthy()
})

test('作ってあるものは窓で仮に選び、［選ぶ］でだけ値を変える', () => {
  const change = vi.fn()
  const value: TapActionValue = { kind: 'form', uri: '', text: '', refId: '' }
  render(<TapActionField name="ボタン1" value={value} onChange={change} hasLiff sources={{ form: [{ id: 'f1', name: 'アンケート' }, { id: 'f2', name: '申し込み' }] }} />)
  expect(screen.getByText('（回答フォームを選んでください）')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'ボタン1の回答フォームを選択する' }))
  const dialog = screen.getByRole('dialog')
  // 回答フォームは必ず選ぶので「選ばない」の行は無い。
  expect(within(dialog).queryByText(/選んでください/)).toBeNull()
  // 共通の選ぶ窓（EntityPicker・dJZ7Q）で選ぶ。
  fireEvent.click(within(dialog).getByRole('radio', { name: '申し込み' }))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
  expect(change).toHaveBeenCalledWith({ refId: 'f2' })
})

test('予約メニューは任意：選んだら名前と［変える］、窓には「決めない」の行がある', () => {
  const change = vi.fn()
  render(<TapActionField name="面 A" value={{ kind: 'booking', uri: '', text: '', refId: 'm1' }} onChange={change} hasLiff sources={{ booking: [{ id: 'm1', name: 'カット＋カラー' }] }} />)
  expect(screen.getByText('カット＋カラー')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '面 Aの予約メニューを変更する' }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: 'メニューを決めずに開く（予約ページの最初）' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
  expect(change).toHaveBeenCalledWith({ refId: '' })
})

test('閲覧のみは選ぶ・変えるボタンを置かず、値を文字で見せる', () => {
  render(<TapActionField name="ボタン1" value={{ kind: 'visit_stamp', uri: '', text: '', refId: 'c1' }} onChange={() => {}} hasLiff readOnly sources={{ visit_stamp: [{ id: 'c1', name: '通常スタンプカード', note: '10個で1杯サービス' }] }} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('来店スタンプ')).toBeTruthy()
  expect(screen.getByText('通常スタンプカード')).toBeTruthy()
  expect(screen.getByText('10個で1杯サービス')).toBeTruthy()
})

test('URL・テキストは入力欄で、打った値を渡す', () => {
  const change = vi.fn()
  const { rerender } = render(<TapActionField name="ボタン1" value={emptyTapAction('uri')} onChange={change} hasLiff />)
  fireEvent.change(screen.getByRole('textbox', { name: 'ボタン1のURL' }), { target: { value: 'https://a.example' } })
  expect(change).toHaveBeenLastCalledWith({ uri: 'https://a.example' })
  rerender(<TapActionField name="ボタン1" value={{ kind: 'message', uri: '', text: 'あいう', refId: '' }} onChange={change} hasLiff textMax={2} />)
  expect(screen.getByRole('textbox', { name: 'ボタン1の送る文' }).getAttribute('aria-invalid')).toBe('true')
})
