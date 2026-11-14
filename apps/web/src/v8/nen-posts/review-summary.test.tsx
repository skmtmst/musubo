// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { PhotoReviewHelp, PublicationRules } from './review-summary'
afterEach(cleanup)
test('掲載条件を項目ごとに読め、順序変更は編集者だけが使える', () => {
  const onOrder = vi.fn()
  const { rerender } = render(<PublicationRules canEdit busy={false} onOrder={onOrder} />)
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: '並び順を変える' })); expect(onOrder).toHaveBeenCalledTimes(1)
  rerender(<PublicationRules canEdit busy onOrder={onOrder} />)
  fireEvent.click(screen.getByRole('button', { name: '処理中…' })); expect(onOrder).toHaveBeenCalledTimes(1)
  rerender(<PublicationRules canEdit={false} busy={false} onOrder={onOrder} />)
  const locked = screen.getByRole('button', { name: '並び順を変える' }); expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(locked)).toBe(true)
  fireEvent.click(locked); expect(onOrder).toHaveBeenCalledTimes(1); expect(screen.getAllByRole('listitem')).toHaveLength(5)
})
test('数の定義と範囲はページの共通説明で引き続き読める', () => {
  render(<PhotoReviewHelp pending="未審査の写真・待ち日数は未取得" adopted="読み込んだ写真だけ" rejected="理由の内訳も読み込んだ写真だけ" />)
  expect(screen.getByText('未審査の写真・待ち日数は未取得')).toBeTruthy()
  expect(screen.getByText('読み込んだ写真だけ')).toBeTruthy()
  expect(screen.getByText('理由の内訳も読み込んだ写真だけ')).toBeTruthy()
  expect(screen.getByText('いま載っている写真の枚数です。')).toBeTruthy()
})
