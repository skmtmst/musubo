// @vitest-environment happy-dom
/*
 * リッチメニューの面の「押したら」（共通の欄 TapActionField・YPzmo・）。
 * 6つは intent に戻して今の形で保存し、予約・予約履歴・来店スタンプは url の intent に LIFF の URL を入れる。
 * リッチメニューだけの種類（テンプレートを送る・電話・切り替えなど）は残す。
 */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AreaProperties, intentLabelOf } from './area-properties'
import { isAreaActionConfigured } from './action-drafts'
import type { Area } from './area-types'
import { RESTAURANT_MENU_DRAFT_URL } from './restaurant-menu-action'
import { HQ_RICH_MENU_INTENTS } from '@/lib/hq-rich-menu-create'

const net = vi.hoisted(() => ({
  account: null as { selectedAccountId: string } | null,
  style: 'restaurant',
  listStores: vi.fn(),
  reservationLink: vi.fn(),
}))
vi.mock('@/contexts/account-context', () => ({ useOptionalAccount: () => net.account }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: net.style } }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { listStores: net.listStores, reservationLink: net.reservationLink } }))

afterEach(() => {
  cleanup()
  net.account = null
  net.style = 'restaurant'
  net.listStores.mockReset()
  net.reservationLink.mockReset()
})

const BASE: Area = { id: 'a', boundsX: 0, boundsY: 0, boundsWidth: 10, boundsHeight: 10, actionType: 'message', actionData: { text: '' }, intent: 'text' }
const seen: Area[] = []

function Harness({ liffId = 'L-1', allowedIntents, initialArea = BASE }: {
  liffId?: string | null
  allowedIntents?: Parameters<typeof AreaProperties>[0]['allowedIntents']
  initialArea?: Area
}) {
  const [area, setArea] = useState<Area>(initialArea)
  seen.push(area)
  return (
    <AreaProperties
      area={area} pages={[]} tags={[]} templates={[]} forms={[{ id: 'f1', name: 'アンケート' }]} trackedLinks={[]} taps={null}
      onUpdate={(patch) => setArea((prev) => ({ ...prev, ...patch }))}
      showManagementDetails={false} liffId={liffId} allowedIntents={allowedIntents}
    />
  )
}
const last = () => seen[seen.length - 1]
const pick = (label: string) => {
  fireEvent.click(within(screen.getByRole('group', { name: '押したときの動き' })).getByRole('radio', { name: label }))
}

describe('リッチメニューの押したら', () => {
  it('6つの後ろにリッチメニューだけの種類が並ぶ', () => {
    render(<Harness />)
    const names = within(screen.getByRole('group', { name: '押したときの動き' })).getAllByRole('radio').map((option) => option.getAttribute('aria-label'))
    expect(names.slice(0, 6)).toEqual(['URLを開く', 'テキストを送る', '予約', '回答フォーム', '予約履歴', '来店スタンプ'])
    expect(names).toContain('テンプレートを送る')
    expect(names).toContain('電話をかける')
    expect(names).toContain('リッチメニューを切り替える')
  })

  it('予約を選ぶと url の intent に LIFF の URL を入れ、一覧の名前は「予約」', () => {
    render(<Harness />)
    pick('予約履歴')
    expect(last()).toMatchObject({ intent: 'url', actionType: 'uri', actionData: { uri: 'https://liff.line.me/L-1/?page=salon-book&view=history' } })
    expect(intentLabelOf(last())).toBe('予約履歴')
    expect(isAreaActionConfigured(last())).toBe(true)
  })

  it('回答フォームは今の形（form の intent・formId）で持つ', () => {
    render(<Harness />)
    pick('回答フォーム')
    expect(last()).toMatchObject({ intent: 'form', actionType: 'uri' })
    fireEvent.click(screen.getByRole('button', { name: 'このボタンの回答フォームを選択する' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: 'アンケート' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '選択する' }))
    expect(last()).toMatchObject({ intent: 'form', formId: 'f1' })
  })

  it('LIFF の無い店：選べるが案内を出し、仮の URL のままでは設定済みにしない', () => {
    render(<Harness liffId={null} />)
    pick('来店スタンプ')
    expect(screen.getByText('この動きは LIFF の設定が要ります')).toBeTruthy()
    expect(String((last().actionData as { uri: string }).uri)).toContain('{{liff_id}}')
    expect(isAreaActionConfigured(last())).toBe(false)
  })

  it('統括のひな形は予約・予約履歴・来店スタンプも選べる（組1の保存・配布が配った先の LIFF に付け替える）', () => {
    render(<Harness allowedIntents={[...HQ_RICH_MENU_INTENTS]} />)
    const text = screen.getByRole('group', { name: '押したときの動き' }).textContent ?? ''
    expect(text).toContain('URLを開く')
    expect(text).toContain('回答フォーム')
    expect(text).toContain('予約履歴')
    expect(text).toContain('来店スタンプ')
  })
})


const venue = (id: string, name: string, token: string | null) => ({
  id, name, line_account_id: 'a1', status: 'active', reservation_token: token,
})
const menu = (uri: string): Area => ({ ...BASE, actionType: 'uri', intent: 'url', actionData: { uri } })
const menuUrl = (token: string) => `https://liff.line.me/L-1/?page=restaurant-menu&token=${token}`

describe('飲食店の料理メニューの行き先', () => {
  it('利用できる店舗が1件なら既存のトークンを使い、別アカウントと閉店した店舗は候補に含めない', async () => {
    net.account = { selectedAccountId: 'a1' }
    net.listStores.mockResolvedValue({ data: { stores: [
      venue('s1', '東京店', 'one'),
      { ...venue('s2', '別アカウント', 'two'), line_account_id: 'a2' },
      { ...venue('s3', '閉店', 'three'), status: 'archived' },
    ] } })
    render(<Harness />)
    const names = within(screen.getByRole('group', { name: '押したときの動き' })).getAllByRole('radio').map(option => option.getAttribute('aria-label'))
    expect(names.slice(2, 6)).toEqual(['予約', '料理メニューを開く', '予約履歴', '来店スタンプ'])
    pick('料理メニューを開く')
    await screen.findByRole('button', { name: '料理メニューのURLをコピーする' })
    expect(screen.getByText('東京店')).toBeTruthy()
    expect(screen.queryByText('押されたときに、あわせて行うこと')).toBeNull()
    expect(last().actionData).toEqual({ uri: menuUrl('one') })
    expect(net.reservationLink).not.toHaveBeenCalled()
  })

  it('複数店舗では明示するまで未設定のまま、既存の料理メニューは開き直すと店舗を復元する', async () => {
    net.account = { selectedAccountId: 'a1' }
    net.listStores.mockResolvedValue({ data: { stores: [
      venue('s1', '東京店', 'one'), venue('s2', '京都店', 'two'),
    ] } })
    const mounted = render(<Harness />)
    pick('料理メニューを開く')
    fireEvent.click(await screen.findByRole('button', { name: '対象店舗' }))
    expect(isAreaActionConfigured(last())).toBe(false)
    fireEvent.click(within(screen.getByRole('option', { name: '京都店' })).getByRole('button'))
    await waitFor(() => expect(last().actionData).toEqual({ uri: menuUrl('two') }))
    mounted.unmount()
    render(<Harness initialArea={menu(menuUrl('two'))} />)
    expect(await screen.findByRole('button', { name: '料理メニューのURLをコピーする' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '対象店舗' }).textContent).toContain('京都店')
    expect(net.reservationLink).not.toHaveBeenCalled()
  })

  it('読むだけでは予約リンクを作らず、設定操作から同じ店のトークンを用意する', async () => {
    net.account = { selectedAccountId: 'a1' }
    net.listStores.mockResolvedValue({ data: { stores: [venue('s1', '東京店', null)] } })
    net.reservationLink.mockResolvedValue({ data: { url: 'https://liff.line.me/L-1?page=restaurant&token=one' } })
    render(<Harness initialArea={menu(RESTAURANT_MENU_DRAFT_URL)} />)
    const configure = await screen.findByRole('button', { name: 'URLを設定する' })
    expect(net.reservationLink).not.toHaveBeenCalled()
    fireEvent.click(configure)
    await screen.findByRole('button', { name: '料理メニューのURLをコピーする' })
    expect(net.reservationLink).toHaveBeenCalledExactlyOnceWith('a1', 's1')
    expect(last().actionData).toEqual({ uri: menuUrl('one') })
  })
})
