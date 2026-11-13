// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(), reservationsDay: vi.fn(), updateReservation: vi.fn(), createReservation: vi.fn(), holdReservation: vi.fn(),
  importReservation: vi.fn(), openingHours: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn(),
}))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const held = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))

vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.title === '無断にしますか？' && props.onConfirm) held.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})

vi.mock('@/lib/api/helpers/reservation-board',async importOriginal=>{const original=await importOriginal<typeof import('@/lib/api/helpers/reservation-board')>();return {...original,reservationBoardApi:{...original.reservationBoardApi,floors:vi.fn().mockResolvedValue({success:true,data:[]})}}})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, prefetch() {} }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))

import ReservationsPage from '../restaurant/reservations/reservations'
import ReservationDetailDialog from './detail-dialog'
import { at, reservation, snapshotOf } from '../restaurant/booking-kit/test-data'


/* 鈴木（Hot Pepper・T4・秋の鹿肉コース・電話あり）と、押さえ（T1）。 */
const reservationsToday = () => [
  reservation('r1', { customer_name: '見本 182', source: 'hotpepper', guest_count: 4, customer_phone: '090-0000-5678', starts_at: at(0, 19), ends_at: at(0, 21), table_id: 't4', course_id: 'm1', course_name: '秋の鹿肉コース' }),
  reservation('r2', { customer_name: '押さえ', source: 'phone', status: 'pending', hold_expires_at: at(0, 23), note: '電話のお客さま用', guest_count: 2, starts_at: at(0, 20), ends_at: at(0, 21, 30), table_id: 't1' }),
]
let today: ReturnType<typeof reservationsToday>

beforeEach(() => {
  held.confirm = null
  // 台帳の「今日」と「次の予約」、来店日の年比較を固定する。待ち合わせのタイマーは実時間のまま。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  today = reservationsToday()
  role.value = 'owner'
  fixture.snapshot.mockResolvedValue({ success: true, data: snapshotOf({ reservations: today, reservationTotal: 2 }) })
  fixture.reservationsDay.mockResolvedValue({ data: { date: '', reservations: today } })
  fixture.openingHours.mockResolvedValue({ data: { storeId: 'store-1', hours: null, version: 1, updatedBy: null, updatedAt: null } })
  fixture.updateReservation.mockResolvedValue({ success: true })
  fixture.customerSearch.mockResolvedValue({ data: [] })
  // 日付表示は日本時間。端末がUTCでも8/14となるよう、見本にも時差を明示する。
  fixture.customerHistory.mockResolvedValue({ data: { visitCount: 3, visits: [{ id: 'v1', starts_at: '2026-08-14T19:00:00+09:00', guest_count: 4, allergy_note: null, table_label: null, course_name: null }] } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

const openDetail = async () => {
  render(<ReservationsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^見本 182 4名/ }))
  return screen.findByRole('dialog', { name: '見本 182さん・4名' })
}

describe('AjZhH 予約台帳 予約の詳細', () => {
  it.each([[null, 'なし', false], ['なし', 'なし', false], ['えび', 'えび', true]] as const)('予約詳細のアレルギー %s と連絡先を区別する', (allergy, label, warning) => {
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog reservation={{ ...today[0], allergy_note: allergy }} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: '見本 182さん・4名' })
    const allergyLine = within(dialog).getByText(`アレルギー：${label}`)
    expect(allergyLine.className.includes('allergy')).toBe(warning)
    expect(dialog.textContent).toContain('電話：090-****-5678')
    expect(within(dialog).getByText('お客さまの食事情報')).not.toBeNull()
  })

  it('埋込の操作は下のメニュー1つにまとめ、予約元を名前と別の段で読む', async () => {
    const attendance = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog inline reservation={today[0]} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={attendance} />)
    const panel = await screen.findByRole('region', { name: '予約の詳細' })
    expect(panel.querySelector('header [data-row-menu]')).toBeNull()
    expect(panel.querySelectorAll('footer [data-row-menu]').length).toBe(1)
    const customer = within(panel).getByText('お客さま').parentElement!
    expect(customer.textContent).toContain('見本 182 さま')
    expect(customer.querySelector('[data-source]')).toBeNull()
    expect(within(panel).getByText('予約元').parentElement?.textContent).toContain('ホットペッパー')
    fireEvent.click(within(panel).getByRole('button', { name: '来店にする' }))
    expect(attendance).toHaveBeenCalledWith('r1', 'visited')
  })
  it('埋込の来店結果は操作の直前で知らせる', async () => {
    const attendance = vi.fn().mockResolvedValue({ savedButUnread: true })
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog inline reservation={today[0]} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={attendance} onReload={() => {}} />)
    const panel = await screen.findByRole('region', { name: '予約の詳細' })
    fireEvent.click(within(panel).getByRole('button', { name: '来店にする' }))
    const alert = await within(panel).findByRole('alert')
    const footer = panel.querySelector('footer')!
    expect(alert.textContent).toContain('保存しましたが、最新の予約を読み込めませんでした')
    expect(alert.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.compareDocumentPosition(within(panel).getByText('来店')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })
  it('来店の保存後に再読込できなければ窓内に案内し、再操作を止める', async () => {
    const attendance = vi.fn().mockResolvedValue({ savedButUnread: true })
    const reload = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    const props = { reservation: today[0], accountId: 'account-1', tables: data.tables, courses: data.menuItems, busy: false, canWrite: true, onClose: () => {}, onCancel: () => {}, onRestore: () => {}, onEdit: () => {}, onAttendance: attendance, onReload: reload }
    const view = render(<ReservationDetailDialog {...props} />)
    const dialog = screen.getByRole('dialog', { name: '見本 182さん・4名' })
    fireEvent.click(within(dialog).getByRole('button', { name: '来店にする' }))
    expect(await within(dialog).findByText('保存しましたが、最新の予約を読み込めませんでした。読み直してから続けてください。')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: '来店にする' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '読み直す' }))
    expect(reload).toHaveBeenCalledOnce()
    view.rerender(<ReservationDetailDialog {...props} reservation={{ ...today[0], customer_version: (today[0].customer_version ?? 1) + 1 }} />)
    expect(within(dialog).queryByText('保存しましたが、最新の予約を読み込めませんでした。読み直してから続けてください。')).toBeNull()
  })
  it('予約の箱で開き、日時と卓・コースと予約元・アレルギー・これまでの来店が出る', async () => {
    const dialog = await openDetail()
    const text = () => dialog.textContent ?? ''
    expect(text()).toMatch(/19:00〜21:00・T4（4 人卓）/)
    expect(text()).toContain('秋の鹿肉コース ¥8,800・Hot Pepper から')
    expect(text()).toContain('アレルギー：なし')
    await waitFor(() => expect(text()).toContain('これまでの来店 3 回・前回 08/14'))
    expect(fixture.customerHistory).toHaveBeenCalledWith('account-1', 'store-1', { phone: '090-0000-5678', lineUid: undefined })
    expect(within(dialog).getByRole('button', { name: '内容を変える' })).not.toBeNull()
  })

  it('「次の予約」の「詳細を見る」でも開く', async () => {
    render(<ReservationsPage />)
    await screen.findByRole('button', { name: /^見本 182 4名/ })
    fireEvent.click(screen.getByRole('button', { name: '詳細を見る' }))
    expect(await screen.findByRole('dialog', { name: '見本 182さん・4名' })).not.toBeNull()
  })

  it('取り消すは確かめの窓を通してから今の口へ取消を送る', async () => {
    const dialog = await openDetail()
    fireEvent.click(within(dialog).getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '取り消す' }))
    expect(fixture.updateReservation).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: 'この予約を取り消しますか？' })
    fireEvent.click(within(confirm).getByRole('button', { name: '取り消す' }))
    await waitFor(() => expect(fixture.updateReservation).toHaveBeenCalledWith('account-1', 'r1', { status: 'cancelled', expectedVersion: 1 }))
  })

  it('内容を変えるで今の変更の窓へ移る', async () => {
    const dialog = await openDetail()
    fireEvent.click(within(dialog).getByRole('button', { name: '内容を変える' }))
    expect(await screen.findByRole('dialog', { name: '見本 182さんの予約を変更' })).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: '見本 182さん・4名' })).toBeNull()
  })

  it('押さえの箱は詳細ではなく押さえの窓を開く', async () => {
    render(<ReservationsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^押さえ / }))
    expect(await screen.findByRole('button', { name: '押さえを解除' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '内容を変える' })).toBeNull()
  })

  it('閲覧のみは詳細の変更操作を理由付きで押せない', async () => {
    role.value = 'viewer'
    const dialog = await openDetail()
    expect(within(dialog).getAllByRole('button', { name: '閉じる' }).length).toBe(1)
    fireEvent.click(within(dialog).getByRole('button', { name: '見本 182のその他操作' }))
    expect(screen.getByRole('menuitem', { name: '取り消す' }).getAttribute('aria-disabled')).toBe('true')
    expect(within(dialog).getByRole('button', { name: '内容を変える' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('button', { name: '卓を変える' })).toBeNull()
    expect(screen.queryByRole('button', { name: /電話の予約を入れる/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /に予約を入れる$/ })).toBeNull()
  })

  it.each([false, true])('閲覧のみの詳細は来店・無断を理由付きで押せない（埋込=%s）', async (inline) => {
    role.value = 'viewer'
    const attendance = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog inline={inline} reservation={today[0]} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite={false} onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={attendance} />)
    const area = inline ? screen.getByRole('region', { name: '予約の詳細' }) : screen.getByRole('dialog', { name: '見本 182さん・4名' })
    for (const name of (inline ? ['来店にする', '無断にする'] : ['来店にする'])) {
      const button = within(area).getByRole('button', { name })
      expect(button.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(button)
    }
    expect(attendance).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('閲覧のみのため変更できません')
  })

  it('承認待ちは無断にできず、承認が必要な理由を出す', () => {
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog reservation={{...today[0], status: 'pending'}} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '見本 182のその他操作' }))
    const button = screen.getByRole('menuitem', { name: '無断にする' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.textContent).toContain('承認してから')
  })

  it('来店は直接、無断はメニューから確認後に送る', async () => {
    const attendance = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog reservation={today[0]} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={attendance} />)
    const dialog = await screen.findByRole('dialog', { name: '見本 182さん・4名' })
    fireEvent.click(within(dialog).getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '無断にする' }))
    expect(attendance).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('alertdialog', { name: '無断にしますか？' })
    expect(confirm.textContent).toContain('見本 182さん')
    expect(confirm.textContent).toContain('19:00')
    expect(confirm.textContent).toContain('LINEアカウント')
    expect(confirm.textContent).toContain('渋谷店')
    expect(confirm.textContent).toContain('環境')
    expect(confirm.textContent).toContain('送信済みの連絡は取り消せません')
    expect(within(confirm).getByRole('button', { name: '無断にする' }).getAttribute('data-variant')).toBe('danger')
    fireEvent.click(within(confirm).getByRole('button', { name: 'キャンセル' }))
    expect(attendance).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '無断にする' }))
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: '無断にしますか？' })).getByRole('button', { name: '無断にする' }))
    expect(attendance).toHaveBeenCalledWith('r1', 'no_show')
    await Promise.resolve()
    fireEvent.click(within(dialog).getByRole('button', { name: '来店にする' }))
    expect(attendance).toHaveBeenCalledWith('r1', 'visited')
  })
  it('無断の確認を開いた後にアカウントが往復しても古い確認は復活しない', async () => {
    const attendance = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    const props = { reservation: today[0], tables: data.tables, courses: data.menuItems, busy: false, canWrite: true, onClose: () => {}, onCancel: () => {}, onRestore: () => {}, onEdit: () => {}, onAttendance: attendance }
    const view = render(<ReservationDetailDialog {...props} accountId="account-1" />)
    fireEvent.click(screen.getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '無断にする' }))
    expect(screen.getByRole('alertdialog', { name: '無断にしますか？' })).toBeTruthy()
    const oldConfirm = held.confirm!
    view.rerender(<ReservationDetailDialog {...props} accountId="account-2" />)
    expect(screen.queryByRole('alertdialog', { name: '無断にしますか？' })).toBeNull()
    view.rerender(<ReservationDetailDialog {...props} accountId="account-1" />)
    expect(screen.queryByRole('alertdialog', { name: '無断にしますか？' })).toBeNull()
    oldConfirm()
    expect(attendance).not.toHaveBeenCalled()
  })
  it('閉じた後の別の確認には前の確定を使えない', async () => {
    const attendance = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog reservation={today[0]} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={attendance} />)
    fireEvent.click(screen.getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '無断にする' }))
    const oldConfirm = held.confirm!
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '無断にしますか？' })).getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(screen.getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '無断にする' }))
    oldConfirm()
    expect(attendance).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog', { name: '無断にしますか？' })).toBeTruthy()
  })
  it('確認中の権限や予約状態が変わった後は元に戻っても古い確認を使えない', () => {
    const attendance = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    const props = { reservation: today[0], accountId: 'account-1', tables: data.tables, courses: data.menuItems, busy: false, canWrite: true, onClose: () => {}, onCancel: () => {}, onRestore: () => {}, onEdit: () => {}, onAttendance: attendance }
    const view = render(<ReservationDetailDialog {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '無断にする' }))
    const oldConfirm = held.confirm!
    view.rerender(<ReservationDetailDialog {...props} canWrite={false} />)
    view.rerender(<ReservationDetailDialog {...props} />)
    oldConfirm()
    expect(screen.queryByRole('alertdialog', { name: '無断にしますか？' })).toBeNull()
    expect(attendance).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '見本 182のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '無断にする' }))
    const oldStatusConfirm = held.confirm!
    view.rerender(<ReservationDetailDialog {...props} reservation={{ ...today[0], status: 'pending' }} />)
    view.rerender(<ReservationDetailDialog {...props} />)
    oldStatusConfirm()
    expect(screen.queryByRole('alertdialog', { name: '無断にしますか？' })).toBeNull()
    expect(attendance).not.toHaveBeenCalled()
  })
  it('埋込の詳細にも無断を直接置き、確認後に no_show を送る', async () => {
    const attendance = vi.fn()
    const data = snapshotOf({ reservations: today, reservationTotal: 2 })
    render(<ReservationDetailDialog inline reservation={today[0]} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={attendance} />)
    const panel = await screen.findByRole('region', { name: '予約の詳細' })
    fireEvent.click(within(panel).getByRole('button', { name: '無断にする' }))
    expect(attendance).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: '無断にしますか？' })).getByRole('button', { name: '無断にする' }))
    expect(attendance).toHaveBeenCalledWith('r1', 'no_show')
  })
  it('来店済みは退店にするを直接置き、無断は置かない', async () => {
    const attendance = vi.fn()
    const visited = reservation('r3', { customer_name: '見本 114', status: 'visited', guest_count: 2 })
    const data = snapshotOf({ reservations: [visited], reservationTotal: 1 })
    render(<ReservationDetailDialog reservation={visited} accountId="account-1" tables={data.tables} courses={data.menuItems}
      busy={false} canWrite onClose={() => {}} onCancel={() => {}} onRestore={() => {}} onEdit={() => {}} onAttendance={attendance} />)
    const dialog = await screen.findByRole('dialog', { name: '見本 114さん・2名' })
    fireEvent.click(within(dialog).getByRole('button', { name: '退店にする' }))
    expect(attendance).toHaveBeenCalledWith('r3', 'depart')
    expect(within(dialog).queryByRole('button', { name: '無断にする' })).toBeNull()
  })
  it('連絡先が無い予約は来店を数えない（口を呼ばない）', async () => {
    fixture.reservationsDay.mockResolvedValue({ data: { date: '', reservations: [{ ...today[0], customer_phone: null }] } })
    const dialog = await openDetail()
    expect(dialog.textContent).toContain('これまでの来店：連絡先が無いので数えられません')
    expect(fixture.customerHistory).not.toHaveBeenCalled()
  })
})
