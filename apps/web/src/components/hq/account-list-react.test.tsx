// @vitest-environment happy-dom
/*
 * 統括のアカウントを選ぶ一覧（/hq/open が使う）。表の列と、行の数・接続状態・操作の受け渡しを描いて見る。
 */
import React from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountWithStats } from '@/contexts/account-context'
import HqAccountList from './account-list'

const account = (values: Partial<AccountWithStats>): AccountWithStats => ({
  id: 'a1', channelId: '1', name: '銀座店', isActive: true, country: null, role: null, displayOrder: 0, ...values,
})
const accounts = [
  account({ id: 'a1', name: '銀座店', basicId: '@ginza', pictureUrl: 'https://line.example/ginza.png', connection: { status: 'ok' } as AccountWithStats['connection'], stats: { friendCount: 1234, messagesThisMonth: 56, activeScenarios: 0, staffCount: 3 } }),
  account({ id: 'a2', name: '梅田店', basicId: null, isActive: false, connection: { status: 'warn' } as AccountWithStats['connection'] }),
]

afterEach(cleanup)

const table = () => document.querySelector('table')!
const row = (name: string) => within(table()).getByText(name).closest('tr')!

describe('統括のアカウントを選ぶ一覧', () => {
  it('表は名前・友だち数・今月の配信数・接続状態・担当者数・状態・操作の列で並ぶ', () => {
    render(<HqAccountList accounts={accounts} onSelect={vi.fn()} />)
    const heads = [...table().querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(heads).toEqual(['アカウント', '友だち数', '今月の配信数', '接続状態', '担当者数', '状態', '操作'])
  })

  it('行に LINE の画像・数・接続状態・担当者数を出し、LINE ID が無ければ未取得と言う', () => {
    render(<HqAccountList accounts={accounts} onSelect={vi.fn()} />)
    const ginza = [...row('銀座店').querySelectorAll('td')].map((td) => td.textContent?.trim())
    expect(ginza.slice(1, 6)).toEqual(['1,234', '56', '正常', '3人', '有効'])
    expect(row('銀座店').textContent).toContain('@ginza')
    expect(row('銀座店').querySelector('img')?.getAttribute('src')).toBe('https://line.example/ginza.png')
    const umeda = [...row('梅田店').querySelectorAll('td')].map((td) => td.textContent?.trim())
    expect(umeda.slice(1, 6)).toEqual(['—', '—', '停止中', '—', '停止中'])
    expect(row('梅田店').textContent).toContain('LINE ID未取得')
  })

  it('未取得と本当に0の数を、PCとスマホで区別する', () => {
    const zero = account({ id: 'z', name: 'ゼロ店', stats: { friendCount: 0, messagesThisMonth: 0, activeScenarios: 0, staffCount: 0 } })
    render(<HqAccountList accounts={[accounts[1], zero]} onSelect={vi.fn()} />)
    expect([...row('梅田店').querySelectorAll('td')].map(td => td.textContent?.trim()).slice(1, 5)).toEqual(['—', '—', '停止中', '—'])
    expect([...row('ゼロ店').querySelectorAll('td')].map(td => td.textContent?.trim()).slice(1, 5)).toEqual(['0', '0', '未確認', '0人'])
    const cards = [...document.querySelectorAll('li')]
    expect([...cards[0].querySelectorAll('dd')].map(dd => dd.textContent)).toEqual(['—', '—', '—'])
    expect([...cards[1].querySelectorAll('dd')].map(dd => dd.textContent)).toEqual(['0', '0', '0人'])
  })

  it('「設定」と選ぶボタンは、その行のアカウントを渡す', () => {
    const onSelect = vi.fn()
    const onSettings = vi.fn()
    render(<HqAccountList accounts={accounts} onSelect={onSelect} onSettings={onSettings} selectLabel="このアカウントを選ぶ" />)
    fireEvent.click(within(row('梅田店')).getByRole('button', { name: '設定' }))
    expect(onSettings).toHaveBeenCalledWith(accounts[1])
    fireEvent.click(within(row('銀座店')).getByRole('button', { name: 'このアカウントを選ぶ' }))
    expect(onSelect).toHaveBeenCalledWith('a1')
  })

  it('設定を渡さない画面には「設定」を置かない', () => {
    render(<HqAccountList accounts={accounts} onSelect={vi.fn()} />)
    expect(within(table()).queryAllByRole('button', { name: '設定' })).toHaveLength(0)
  })
})
