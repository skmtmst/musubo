// @vitest-environment happy-dom
/*
 * リッチメニューの面の「押したら」（共通の欄 TapActionField・YPzmo・）。
 * 6つは intent に戻して今の形で保存し、予約・予約履歴・来店スタンプは url の intent に LIFF の URL を入れる。
 * リッチメニューだけの種類（テンプレートを送る・電話・切り替えなど）は残す。
 */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AreaProperties, intentLabelOf } from './area-properties'
import { isAreaActionConfigured } from './action-drafts'
import type { Area } from './area-types'
import { HQ_RICH_MENU_INTENTS } from '@/lib/hq-rich-menu-create'

afterEach(cleanup)

const BASE: Area = { id: 'a', boundsX: 0, boundsY: 0, boundsWidth: 10, boundsHeight: 10, actionType: 'message', actionData: { text: '' }, intent: 'text' }
const seen: Area[] = []

function Harness({ liffId = 'L-1', allowedIntents }: { liffId?: string | null; allowedIntents?: Parameters<typeof AreaProperties>[0]['allowedIntents'] }) {
  const [area, setArea] = useState<Area>(BASE)
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
    expect(names).toContain('メニューを切り替える')
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
