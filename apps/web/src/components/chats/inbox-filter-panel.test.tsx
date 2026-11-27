// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InboxFilterPanel, { type InboxFilterValue } from './inbox-filter-panel'
import InboxRulesPopover from '@/v8/inbox-chat/rules-popover'

const role = vi.hoisted(() => ({ value: 'viewer' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {} }),
  usePathname: () => '/chats',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => role.value,
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, api: { ...original.api, supportMarks: { list: async () => ({ success: true, data: [] }) } } }
})

afterEach(cleanup)

const initial: InboxFilterValue = {
  status: 'on_hold', assignee: 'operator-a', channel: 'email', unreadOnly: true, quickFilter: 'all',
}

function Panel({ slaEnabled = false, count = null }: { slaEnabled?: boolean; count?: number | null }) {
  const [value, setValue] = useState(initial)
  const [open, setOpen] = useState(true)
  return <><output aria-label="現在の条件">{JSON.stringify(value)}</output><InboxFilterPanel
    open={open} value={value} operators={[{ id: 'operator-a', name: '担当者A' }]}
    slaEnabled={slaEnabled} unassignedUnreadCount={count}
    auxiliaryActions={<button type="button" onClick={() => setOpen(false)}>対応ルールを開く</button>}
    onChange={setValue} onClose={() => setOpen(false)}
    onReset={() => setValue({ status: 'all', assignee: 'all', channel: 'all', unreadOnly: false, quickFilter: 'all' })}
  /></>
}

function chooseDeadline(label: string) {
  fireEvent.click(screen.getByRole('button', { name: '期限で絞り込む' }))
  fireEvent.click(screen.getByRole('option', { name: label }).querySelector('button')!)
}

describe('受信箱の期限と補助操作', () => {
  it('対応状況は正本の4状態を順に表示する', () => {
    render(<Panel />)
    fireEvent.click(screen.getByRole('button', { name: '対応状況で絞り込む' }))
    expect(screen.getAllByRole('option').map(option => option.textContent?.trim())).toEqual(['すべて', '未対応', '対応中', '保留', '対応済み'])
  })

  it.each([false, true])('期限を変えてもほかの条件を保持し、リセットは期限も解除する（期限あり=%s）', (slaEnabled) => {
    render(<Panel slaEnabled={slaEnabled} />)
    chooseDeadline('要返信')
    expect(JSON.parse(screen.getByLabelText('現在の条件').textContent!)).toEqual({ ...initial, quickFilter: 'reply' })
    chooseDeadline(slaEnabled ? '期限超過' : '1時間以上待ち')
    expect(JSON.parse(screen.getByLabelText('現在の条件').textContent!)).toEqual({ ...initial, quickFilter: 'overdue' })
    chooseDeadline('すべて')
    expect(JSON.parse(screen.getByLabelText('現在の条件').textContent!)).toEqual(initial)
    fireEvent.click(screen.getByRole('button', { name: 'リセット' }))
    expect(JSON.parse(screen.getByLabelText('現在の条件').textContent!)).toEqual({
      status: 'all', assignee: 'all', channel: 'all', unreadOnly: false, quickFilter: 'all',
    })
  })

  it('期限未接続の呼び出し元では操作を出さず、ほかの条件と即時反映は保つ', () => {
    const { quickFilter: _quickFilter, ...value } = initial
    const onChange = vi.fn()
    render(<InboxFilterPanel open value={value} operators={[]} onChange={onChange} onReset={() => {}} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: '期限で絞り込む' })).toBeNull()
    expect(screen.queryByText('対応期限はまだ記録していないため、この条件では絞り込めません')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '未読だけ表示' }))
    expect(onChange).toHaveBeenCalledWith({ ...value, unreadOnly: false })
  })

  it.each([null, 0, 27])('未割り当ての未読数%sを渡し、候補を選んでも期限条件を保つ', (count) => {
    render(<Panel count={count} />)
    fireEvent.click(screen.getByRole('button', { name: '担当者で絞り込む' }))
    const picker = screen.getAllByRole('dialog').at(-1)!
    expect(within(picker).getByText(count === null ? '未読 —' : `未読 ${count}件`)).toBeTruthy()
    fireEvent.click(within(picker).getByRole('radio', { name: '未割り当て' }))
    fireEvent.click(within(picker).getByRole('button', { name: '選択する' }))
    expect(JSON.parse(screen.getByLabelText('現在の条件').textContent!)).toEqual({ ...initial, assignee: 'unassigned' })
  })

  it('補助操作を窓内から起動し、閉じると窓と操作を外す', () => {
    render(<Panel />)
    const dialog = screen.getByRole('dialog', { name: '絞り込み' })
    fireEvent.click(within(dialog).getByRole('button', { name: '対応ルールを開く' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: '対応ルールを開く' })).toBeNull()
  })

  it.each(['owner', 'viewer'])('実際の対応ルールから%sの既存操作へ焦点を移せる', async (staffRole) => {
    role.value = staffRole
    render(<InboxFilterPanel open value={initial} operators={[]} onChange={() => {}} onReset={() => {}} onClose={() => {}}
      auxiliaryActions={<InboxRulesPopover accountId="account-a" />} />)
    fireEvent.click(screen.getByRole('button', { name: '対応ルール' }))
    await waitFor(() => expect(screen.getByText('対応マークはまだありません。')).toBeTruthy())
    const rules = screen.getByRole('dialog', { name: '対応ルール' })
    const settings = within(rules).queryByRole('button', { name: '割り当てと返事の期限' })
    if (staffRole === 'owner') {
      expect(settings).not.toBeNull()
      settings!.focus()
      expect(document.activeElement).toBe(settings)
    } else {
      // 閲覧リンクの操作を守り、変更操作の表示方法はこの試験で固定しない。
      const link = within(rules).getByRole('link')
      link.focus()
      expect(document.activeElement).toBe(link)
    }
  })
})

it('絞り込みの中から担当を選ぶ窓は手前に出て、選択を反映する', async () => {
  function Anchored() {
    const anchor=useRef<HTMLButtonElement>(null)
    const [value,setValue]=useState(initial)
    return <><button ref={anchor}>絞り込みを開く</button><output aria-label="現在の条件">{JSON.stringify(value)}</output><InboxFilterPanel open anchorRef={anchor} value={value} operators={[{id:'operator-a',name:'担当者A'}]} onChange={setValue} onReset={()=>{}} onClose={()=>{}} /></>
  }
  render(<Anchored />)
  const filter=await screen.findByRole('dialog',{name:'絞り込み'})
  fireEvent.click(within(filter).getByRole('button',{name:'担当者で絞り込む'}))
  const picker=await screen.findByRole('dialog',{name:/担当者/})
  const menu=filter.closest('[data-menu-portal]') as HTMLElement
  const overlay=picker.closest('[role="presentation"]') as HTMLElement
  await waitFor(()=>expect(Number(overlay.style.zIndex)).toBeGreaterThan(Number(menu.style.zIndex)))
  fireEvent.click(within(picker).getByRole('radio',{name:'未割り当て'}))
  fireEvent.click(within(picker).getByRole('button',{name:'選択する'}))
  expect(JSON.parse(screen.getByLabelText('現在の条件').textContent!).assignee).toBe('unassigned')
})
