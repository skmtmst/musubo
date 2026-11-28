// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { StyleRow } from './model'
import { TodayList } from './today-list'

afterEach(cleanup)

const noop = () => {}

describe('TodayList の空き表示と行き先ボタンの守り', () => {
  it('空き枠が未取得の行には「空きあり」を付けず、値のある行だけ読み上げラベルを付ける', () => {
    const rows: StyleRow[] = [
      { id: 'c-unknown', time: '10:00', name: '未取得クラス' },
      { id: 'c-open', time: '11:00', name: '空きありクラス', vacancy: '○' },
      { id: 'c-few', time: '12:00', name: '残りわずかクラス', vacancy: '△' },
      { id: 'c-full', time: '13:00', name: '満席クラス', vacancy: '×' },
    ]
    render(
      <TodayList
        style="lesson"
        rows={rows}
        note=""
        canWrite={false}
        busyId=""
        menuFor={() => []}
        onVisit={noop}
        onUndo={noop}
      />,
    )

    const tableRows = screen.getAllByRole('row')
    const unknownVacancyCell = within(tableRows[1]).getAllByRole('cell')[4]
    expect(unknownVacancyCell.textContent).toBe('—')
    expect(within(unknownVacancyCell).queryByLabelText('空きあり')).toBeNull()
    expect(unknownVacancyCell.querySelector('[aria-label]')).toBeNull()

    expect(within(within(tableRows[2]).getAllByRole('cell')[4]).getByLabelText('空きあり')).toBeTruthy()
    expect(within(within(tableRows[3]).getAllByRole('cell')[4]).getByLabelText('残りわずか')).toBeTruthy()
    expect(within(within(tableRows[4]).getAllByRole('cell')[4]).getByLabelText('空きなし')).toBeTruthy()
  })

  it('行き先の無い Meet・場所ボタンは出さず、URL がある行だけ外部リンクとして出す', () => {
    const rows: StyleRow[] = [
      { id: 'm-none', time: '10:00', name: 'リンクなし面談', action: 'meet' },
      { id: 'm-blank', time: '11:00', name: '空白リンク面談', action: 'meet', actionHref: '   ' },
      { id: 'p-none', time: '12:00', name: '場所なし面談', action: 'place', actionHref: '' },
      { id: 'm-ok', time: '13:00', name: 'URLあり面談', action: 'meet', actionHref: 'https://meet.google.com/abc-defg-hij' },
      { id: 'p-ok', time: '14:00', name: '場所あり面談', action: 'place', actionHref: 'https://maps.google.com/?q=Tokyo' },
    ]
    render(
      <TodayList
        style="consult"
        rows={rows}
        note=""
        canWrite
        busyId=""
        menuFor={() => []}
        onVisit={noop}
        onUndo={noop}
      />,
    )

    const tableRows = screen.getAllByRole('row')
    for (const rowIndex of [1, 2, 3]) {
      const actionCell = within(tableRows[rowIndex]).getAllByRole('cell')[5]
      expect(within(actionCell).queryByRole('button')).toBeNull()
      expect(within(actionCell).queryByRole('link')).toBeNull()
      expect(actionCell.textContent).toBe('')
    }

    const meetLink = within(within(tableRows[4]).getAllByRole('cell')[5]).getByRole('link', { name: 'Meet に入る' })
    expect(meetLink.getAttribute('href')).toBe('https://meet.google.com/abc-defg-hij')
    expect(meetLink.getAttribute('target')).toBe('_blank')

    const placeLink = within(within(tableRows[5]).getAllByRole('cell')[5]).getByRole('link', { name: '場所を開く' })
    expect(placeLink.getAttribute('href')).toBe('https://maps.google.com/?q=Tokyo')
    expect(placeLink.getAttribute('target')).toBe('_blank')
  })
})
