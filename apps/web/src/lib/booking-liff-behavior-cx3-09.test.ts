// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { tapActionLiffUrl } from './tap-actions'
import { readUrlState } from '../../../liff/src/lib/salon-url-state'

afterEach(() => window.history.replaceState(null, '', '/'))

it('管理画面で作った予約先のメニューを LIFF が実際に読み取る', () => {
  const destination = new URL(tapActionLiffUrl('store', 'booking', 'menu_12-a'))
  window.history.replaceState(null, '', `/${destination.search}`)
  expect(readUrlState()).toMatchObject({ menuId: 'menu_12-a', peekMode: false })
})

it('下見と通常表示を区別し、表示先とメニューを同時に保持する', () => {
  window.history.replaceState(null, '', '/?view=menu&mode=peek&menu_id=menu-2')
  expect(readUrlState()).toEqual({ view: 'menu', peekMode: true, menuId: 'menu-2' })
  window.history.replaceState(null, '', '/?view=menu&mode=other&menu_id=menu-2')
  expect(readUrlState()).toEqual({ view: 'menu', peekMode: false, menuId: 'menu-2' })
})
