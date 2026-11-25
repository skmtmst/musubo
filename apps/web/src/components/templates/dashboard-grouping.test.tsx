// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'
import { DashboardAsideSection, DashboardColumns, DashboardPage, DashboardRow, DashboardTop } from './dashboard-page'

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
afterEach(cleanup)

it('初回は案内を出して本文を待ち、表示済みの本文は読み直しで作り直さず、別の店舗では待ち直す', () => {
  const read = vi.fn()
  function Content() {
    useEffect(() => { read() }, [])
    const [count, setCount] = useState(0)
    return <button onClick={() => setCount(count + 1)}>本文 {count}</button>
  }
  const page = (scope: string, pending: boolean) => <DashboardPage title="ダッシュボード" notice={<p>取得済みの設定への入口</p>} initialContent={{ scope, pending }}><Content /></DashboardPage>
  const view = render(page('A', true))
  expect(screen.getByText('取得済みの設定への入口')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '本文 0' })).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
  expect(view.container.querySelector('[aria-busy="true"]')).toBeTruthy()
  view.rerender(page('A', false))
  fireEvent.click(screen.getByRole('button', { name: '本文 0' }))
  view.rerender(page('A', true))
  expect(screen.getByRole('button', { name: '本文 1' })).toBeTruthy()
  expect(read).toHaveBeenCalledTimes(1)
  view.rerender(page('B', true))
  expect(screen.queryByRole('button', { name: '本文 1' })).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
  view.rerender(page('B', false))
  expect(screen.getByRole('button', { name: '本文 0' })).toBeTruthy()
})

function page(grouping?: 'cards') {
  return render(<DashboardPage title="ダッシュボード" grouping={grouping}>
    <DashboardRow variant="trend" aside={<div><DashboardAsideSection>送信枠</DashboardAsideSection><DashboardAsideSection>運用アラート</DashboardAsideSection></div>}>推移</DashboardRow>
    <DashboardColumns layout="overview">{[<DashboardAsideSection key="a">今月の配信</DashboardAsideSection>, <p key="b">最近の成果</p>]}</DashboardColumns>
  </DashboardPage>).container
}

describe('段のまとまりの見せ方', () => {
  it('cards では段の中身・右の列の段・横並びのマスを共通のカードに1つずつ入れ、カードを入れ子にしない', () => {
    const root = page('cards')
    const cards = [...root.querySelectorAll('[data-design-part="card"]')].map((card) => card.textContent)
    expect(cards).toEqual(['推移', '送信枠', '運用アラート', '今月の配信', '最近の成果'])
    expect(root.querySelector('[data-design-part="card"] [data-design-part="card"]')).toBeNull()
    expect(root.querySelectorAll('[data-grouping="cards"]')).toHaveLength(2)
  })

  it('省くと今までどおり線で区切り、カードに入れない', () => {
    const root = page()
    expect(root.querySelector('[data-design-part="card"]')).toBeNull()
    expect(root.querySelector('[data-grouping]')).toBeNull()
  })
})

it('案内の有無にかかわらず、期間の操作を数の帯の直前に並べる', () => {
  const renderTop = (intro: ReactNode) => <DashboardTop intro={intro} controls={<div>期間の操作</div>}><div>数の帯</div></DashboardTop>
  const view = render(renderTop(<div>はじめにやること</div>))
  expect(view.container.textContent).toBe('はじめにやること期間の操作数の帯')
  view.rerender(renderTop(null))
  expect(view.container.textContent).toBe('期間の操作数の帯')
  expect(view.container.children).toHaveLength(2)
})
