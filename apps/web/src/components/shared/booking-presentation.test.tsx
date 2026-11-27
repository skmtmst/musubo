// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReservationBoardEntry } from '@line-crm/shared'
import ReservationBoard from './reservation-board'
import ReservationMonth from './reservation-month'
import { BookingBlock } from './booking-controls'
import { BookingLegend, BookingVisibleLegend, BookingNowLine, ReservationSource, BookingSourceLegend, BookingCardContent, BookingRest } from './booking-presentation'

const base: ReservationBoardEntry = { id: 'r', kind: 'seats', version: 1, scopeId: 's', startsAt: '2026-10-23T09:00:00Z', endsAt: '2026-10-23T10:00:00Z', status: 'confirmed', customerName: '予約のお客さま', guestCount: 2, resourceIds: ['t'], resourceLabel: '卓', source: 'line', courseName: null, note: null, dining: null, holdExpiresAt: null }
const resources = [{ id: 't', label: '卓', active: true, capacity: 2 }]
afterEach(() => { cleanup(); vi.useRealTimers() })

it.each([
  ['確定LINE', { source: 'line' }, 'confirmed'],
  ['確定電話', { source: 'phone' }, 'confirmed'],
  ['確定媒体', { source: 'tabelog' }, 'confirmed'],
  ['来店中', { status: 'seated' }, 'active'],
  ['来店済み退店前', { status: 'visited' }, 'active'],
  ['退店済み', { status: 'visited', departedAt: base.endsAt }, 'completed'],
  ['終了', { status: 'completed', kind: 'people' }, 'completed'],
  ['承認待ち', { status: 'requested' }, 'pending'],
  ['期限付きの仮押さえ', { status: 'pending', holdExpiresAt: base.startsAt }, 'hold'],
  ['仮押さえ', { holdExpiresAt: base.startsAt }, 'hold'],
  ['無断', { status: 'no_show' }, 'no_show'],
  ['遅れ', { status: 'late' }, 'warning'],
] as const)('%sは経路によらず状態の札を使い、読む操作を保つ', (_label, changes, expected) => {
  const entry = { ...base, ...changes }, open = vi.fn()
  render(<ReservationBoard entries={[entry]} resources={resources} dates={['2026-10-23']} onOpen={open} />)
  const button = screen.getByRole('button', { name: /予約のお客さま/ })
  expect(button.getAttribute('data-booking-state')).toBe(expected)
  expect(button.querySelector('strong')?.textContent).toBe(base.customerName)
  expect(button.textContent).toContain('18:00〜19:00')
  fireEvent.click(button)
  expect(open).toHaveBeenCalledWith(base.id)
  expect(screen.queryByRole('button', { name: /に予約を入れる/ })).toBeNull()
})

it('電話予約の説明に予約元を含める', () => {
  render(<ReservationBoard entries={[{ ...base, source: 'phone' }]} resources={resources} dates={['2026-10-23']} onOpen={vi.fn()} />)
  expect(screen.getByRole('button', { name: /予約のお客さま/ }).getAttribute('aria-description')).toContain('電話')
})

it('月の札にも同じ来店状態を渡し、詳細を開く', () => {
  const open = vi.fn()
  render(<ReservationMonth month="2026-10" entries={[{ ...base, status: 'seated' }]} onOpen={open} />)
  const button = screen.getByRole('button', { name: /予約のお客さま/ })
  expect(button.getAttribute('data-booking-state')).toBe('active')
  fireEvent.click(button)
  expect(open).toHaveBeenCalledWith(base.id)
})

it('凡例は同じ状態の面を使い、塗りと枠に文字の説明を付ける', () => {
  render(<BookingLegend />)
  const list = screen.getByRole('list', { name: '予約の状態' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(9)
  expect(list.querySelector('[data-booking-state="active"]')?.getAttribute('aria-hidden')).toBe('true')
  expect(list.textContent).toContain('要対応（承認待ち）')
  expect(list.textContent).toContain('仮押さえ')
  expect(list.textContent).toContain('無断キャンセル')
  expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(expect.arrayContaining(['要対応（承認待ち）', '重なり・受付数超過']))
})

it('凡例に状態を渡すと、その状態だけを決まった並びで出す', () => {
  render(<BookingLegend states={['pending', 'active', 'confirmed']} label="今日の予約の状態" />)
  const list = screen.getByRole('list', { name: '今日の予約の状態' })
  expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(['確定', '来店中・進行中', '要対応（承認待ち）'])
})

it('見えている予約状態だけを出し、全状態は「？」から開く', () => {
  render(<BookingVisibleLegend states={['pending', 'active']} />)
  const list = screen.getByRole('list', { name: '予約の状態' })
  expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(['来店中・進行中', '要対応（承認待ち）'])
  expect(screen.getByRole('button', { name: '予約の印の見方' })).toBeTruthy()
  expect(screen.queryByRole('list', { name: '予約の印の見方' })).toBeNull()
})

it.each(['line', 'liff', 'manual', 'walk_in', 'counter', 'tabelog'])('予約の箱は%sの経路を省き、電話だけ灰の札にする', source => {
  const { rerender, container } = render(<BookingCardContent name="マロン" time="10:00〜11:00" menu="カット" source={source} />)
  expect(container.querySelector('[data-source]')).toBeNull()
  expect(container.textContent).toBe('マロン10:00〜11:00カット')
  rerender(<BookingCardContent name="マロン" time="10:00〜11:00" menu="カット" source="phone" />)
  expect(container.textContent).toContain('電話')
  expect(container.querySelector('[data-source]')).toBeNull()
})

it('詳細と一覧では手入力の予約を電話と青い丸で示し、ウォークインの経路名を保持する', () => {
  const { rerender, container } = render(<ReservationSource value="manual" />)
  expect(container.textContent).toBe('電話')
  expect(container.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('background-color: var(--color-status-info)')
  rerender(<ReservationSource value="phone" />)
  expect(container.textContent).toBe('電話')
  expect(container.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('background-color: var(--color-status-info)')
  rerender(<ReservationSource value="manual" note="ウォークイン（予約なしの来店）" />)
  expect(container.textContent).toBe('ウォークイン')
})

it('種類は名前の前の装飾の丸だけに色を持ち、経路名を文字で残す', () => {
  const { container } = render(<ReservationSource value="line" />)
  const source = container.querySelector('[data-source="line"]')!
  expect(source.textContent).toBe('LINE')
  expect(source.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('background-color: var(--color-accent-deep)')
  expect(source.hasAttribute('style')).toBe(false)
  expect(source.querySelector('[role="img"]')).toBeNull()
})

it('上限を超えた札は要対応とし、従来の媒体の指定でも確定を塗らない', () => {
  render(<><BookingBlock tone="over">受付数超過</BookingBlock><BookingBlock tone="media">媒体予約</BookingBlock></>)
  expect(screen.getByRole('button', { name: '受付数超過' }).getAttribute('data-booking-state')).toBe('attention')
  expect(screen.getByRole('button', { name: '媒体予約' }).getAttribute('data-booking-state')).toBe('confirmed')
})

it('今の時刻は札と細い線の共通表示で伝える', () => {
  render(<BookingNowLine time="18:24" />)
  const line = screen.getByLabelText('今 18:24')
  expect(line.getAttribute('data-direction')).toBe('vertical')
  expect(line.textContent).toBe('18:24')
})

it('今日の表だけに現在時刻を示し、別の日には残さない', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T09:24:00Z'))
  const props = { entries: [base], resources, onOpen: vi.fn() }
  const view = render(<ReservationBoard {...props} dates={['2026-10-23']} />)
  expect(screen.getByLabelText('今 18:24')).toBeTruthy()
  view.rerender(<ReservationBoard {...props} dates={['2026-10-24']} />)
  expect(screen.queryByLabelText('今 18:24')).toBeNull()
})

it('同じ卓の重なりは要対応、次の実予約までの空きだけを分で示す', () => {
  const next = { ...base, id: 'next', customerName: '次のお客さま', startsAt: '2026-10-23T10:24:00Z', endsAt: '2026-10-23T11:00:00Z' }
  const props = { resources, dates: ['2026-10-23'], onOpen: vi.fn() }
  const view = render(<ReservationBoard {...props} entries={[base, next]} />)
  expect(screen.getByLabelText('次の予約まで空き24分').textContent).toBe('24分')
  view.rerender(<ReservationBoard {...props} entries={[base, { ...next, startsAt: '2026-10-23T09:30:00Z' }]} />)
  expect(screen.queryByLabelText('次の予約まで空き24分')).toBeNull()
  expect(screen.getByRole('button', { name: /次のお客さま/ }).getAttribute('data-booking-state')).toBe('attention')
  view.rerender(<ReservationBoard {...props} entries={[{ ...base, status: 'no_show' }, next]} />)
  expect(screen.getByRole('button', { name: /予約のお客さま/ }).getAttribute('data-booking-state')).toBe('no_show')
  expect(screen.getByRole('button', { name: /次のお客さま/ }).getAttribute('data-booking-state')).toBe('confirmed')
  expect(screen.queryByLabelText('次の予約まで空き24分')).toBeNull()
})

it.each(['confirmed', 'pending', 'active', 'hold'] as const)('予約内容は2段を共通で表示し、%sの状態を保つ', state => {
  const { container } = render(<BookingBlock state={state}><BookingCardContent name="マロン さん" time="10:00〜11:00" menu="カット" state={state} source="phone" /></BookingBlock>)
  const card = container.querySelector('button')!
  expect(card.firstElementChild?.textContent).toBe('マロン さん10:00〜11:00')
  expect(card.children[1].textContent).toContain('カット')
  expect(card.textContent).toContain('電話')
  expect(card.querySelector('[data-source]')).toBeNull()
  expect(card.querySelectorAll('[data-booking-state]').length).toBe(state === 'confirmed' ? 0 : 1)
})

it('予約元の凡例は操作列の外で一覧軸にも残す', () => {
  const { container } = render(<ReservationBoard axis="list" entries={[base]} resources={resources} toolbar={<button>日付を選ぶ</button>} trailingToolbar={<button>予約元を絞る</button>} legend={<BookingSourceLegend sources={['line', 'phone']} />} onOpen={() => {}} />)
  const controlRow = container.querySelector('[data-control-row]')!
  const sourceLegend = screen.getByRole('list', { name: '予約元' })
  expect(controlRow).toBeTruthy()
  expect(controlRow.contains(sourceLegend)).toBe(false)
  expect(sourceLegend.textContent).toContain('LINE')
  expect(sourceLegend.textContent).toContain('電話')
})

it('月の表の凡例へ、表示していない月の状態を混ぜない', () => {
  render(<ReservationBoard axis="month" dates={['2026-10-01']} entries={[base, { ...base, id: 'other-month', status: 'requested', startsAt: '2026-11-01T09:00:00Z', endsAt: '2026-11-01T10:00:00Z' }]} resources={resources} onOpen={() => {}} />)
  const legend = screen.getByRole('list', { name: '予約の状態' })
  expect(within(legend).getAllByRole('listitem').map(item => item.textContent)).toEqual(['確定'])
})

it('休みは操作にせず、時刻と受付停止の全文をマウスと読み上げへ残す', () => {
  const full = '10:00〜11:00 休み 予約は止めています'
  render(<BookingRest title={full}>休み</BookingRest>)
  const rest = screen.getByTitle(full)
  expect(rest.textContent).toContain(full)
  expect(rest.querySelector('[aria-hidden="true"]')?.textContent).toBe('休み')
  expect(screen.queryByRole('button')).toBeNull()
})

it('狭い予約箱でも注意の印から全文を確認でき、焦点では状態と注意を読み上げる', () => {
  const open = vi.fn()
  render(<ReservationBoard entries={[{ ...base, status: 'requested', source: 'phone', currentAllergy: 'そば・小麦' }]} resources={resources} dates={['2026-10-23']} onOpen={open} />)
  const card = screen.getByRole('button', { name: /予約のお客さま/ })
  const warning = within(card).getByTitle('⚠ そば・小麦')
  expect(warning.textContent).toBe('⚠ そば・小麦')
  expect(card.getAttribute('aria-description')).toContain('要対応（承認待ち）')
  expect(card.getAttribute('aria-description')).toContain('注意：そば・小麦')
  expect(within(card).getByTitle('要対応（承認待ち）').textContent).toBe('要対応')
  expect(within(card).getByTitle('2名')).toBeTruthy()
  fireEvent.click(warning)
  expect(open).toHaveBeenCalledWith('r')
})


it.each(['seats', 'people'] as const)('重なっても%sの実状態と注意を保ち、詳細操作を変えない', kind => {
  const first = { ...base, kind, customerName: '来店中の予約', status: 'seated' }
  const second = { ...base, kind, id: 'pending-overlap', customerName: '承認待ちの予約', status: 'requested', startsAt: '2026-10-23T09:30:00Z', endsAt: '2026-10-23T10:30:00Z', source: 'phone', currentAllergy: 'そば・小麦' }
  const open = vi.fn()
  render(<ReservationBoard kind={kind} entries={[first, second]} resources={[{ ...resources[0], capacity: 1 }]} dates={['2026-10-23']} onOpen={open} />)
  const card = screen.getByRole('button', { name: /承認待ちの予約/ })
  expect(card.getAttribute('data-booking-state')).toBe('attention')
  expect(within(card).getByTitle('要対応（承認待ち）').textContent).toBe('要対応')
  expect(within(card).getByTitle('重なり・受付数超過').textContent).toBe('重なり')
  expect(card.getAttribute('aria-description')).toContain('要対応（承認待ち）')
  expect(card.getAttribute('aria-description')).toContain('重なり・受付数超過')
  expect(card.getAttribute('aria-description')).toContain('注意：そば・小麦')
  expect(card.getAttribute('aria-description')?.match(/電話/g)).toHaveLength(1)
  fireEvent.click(card)
  expect(open).toHaveBeenCalledWith(second.id)
})

it('縦の担当盤でも重なりの説明に承認待ちを残す', () => {
  const first = { ...base, kind: 'people' as const, customerName: '先の予約' }
  const second = { ...first, id: 'pending', customerName: '承認待ちの予約', status: 'requested', startsAt: '2026-10-23T09:30:00Z', endsAt: '2026-10-23T10:30:00Z', source: 'phone' }
  render(<ReservationBoard kind="people" timeDirection="vertical" entries={[first, second]} resources={[{ ...resources[0], capacity: 1 }]} dates={['2026-10-23']} onOpen={() => {}} />)
  const card = screen.getByRole('button', { name: /承認待ちの予約/ })
  expect(card.getAttribute('data-booking-state')).toBe('attention')
  expect(within(card).getByTitle('要対応（承認待ち）')).toBeTruthy()
  expect(within(card).getByTitle('重なり・受付数超過')).toBeTruthy()
  expect(card.getAttribute('aria-description')).toContain('要対応（承認待ち）')
  expect(card.getAttribute('aria-description')).toContain('重なり・受付数超過')
})
