// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import PagePending, { PagePendingLayout } from './page-pending'
import AuthPendingShell from '@/components/auth-pending-shell'

afterEach(cleanup)
it('取得前の安全な題を、読み込みの失敗と再試行でも保つ', () => {
  const retry = () => {}
  const view = render(<PagePending stage="route" title="友だちを開いています" />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('友だちを開いています')
  view.rerender(<PagePending stage="route" title="友だちを開いています" failed onRetry={retry} />)
  expect(screen.getAllByRole('heading', { level: 1 }).map(node => node.textContent)).toEqual(['友だちを開いています'])
  expect(screen.getByRole('button', { name: /もう一度|読み直す/ })).toBeTruthy()
})
it('店舗ダッシュボードは題付きのダッシュボード型で待つ', () => {
  const view = render(<PagePending variant="dashboard" stage="route" title="ダッシュボード" />)
  expect(view.container.querySelector('[data-page-template="dashboard"]')).toBeTruthy()
  expect(screen.getAllByRole('heading', { level: 1 }).map(node => node.textContent)).toEqual(['ダッシュボード'])
})
it('認証中は画面名を出さず、認証後の共通ゲートでは移動先の題だけを出す', () => {
  const view = render(<PagePendingLayout variant="detail" title="友だち"><AuthPendingShell /></PagePendingLayout>)
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  expect(screen.getByRole('status', { name: '利用状況を確認しています' })).toBeTruthy()
  view.rerender(<PagePendingLayout variant="detail" title="通知"><PagePending stage="identity" /></PagePendingLayout>)
  expect(screen.getAllByRole('heading', { level: 1 }).map(node => node.textContent)).toEqual(['通知'])
  view.rerender(<PagePendingLayout variant="detail"><PagePending stage="identity" /></PagePendingLayout>)
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
})
