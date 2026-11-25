// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TemplateRichEditor from './rich'
import type { TemplateEditHost } from './host'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({ useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [], notificationRules: [] }) }))
vi.mock('@/lib/api', () => ({ api: { folders: { list: async () => ({ success: true, data: [] }) } } }))
beforeEach(() => document.documentElement.setAttribute('data-theme', 'v8'))
afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-theme') })

/* 採用案 Wmch0：面は右の一覧（記号＋場所の名前）。 */
const areaRows = () => within(screen.getByRole('list', { name: '面の一覧' })).getAllByRole('button').map((row) => `${row.children[0].textContent}${row.children[1].textContent}`)
it('6形の順を保ち、キーで形を変えると見本と同じA・Bの設定行になる', () => {
  render(<TemplateRichEditor />)
  const group = screen.getByRole('radiogroup', { name: '面の分け方' })
  expect(within(group).getAllByRole('radio').map((input) => input.getAttribute('aria-label'))).toEqual([
    '1面（面 A）', '上下2面（面 A・B）', '左右2面（面 A・B）', '上1・下2（面 A・B・C）', '4面（面 A・B・C・D）', '6面（面 A・B・C・D・E・F）',
  ])
  expect(areaRows()).toEqual(['A上', 'B左下', 'C右下'])
  const one = within(group).getByRole('radio', { name: '1面（面 A）' })
  fireEvent.click(one)
  expect(areaRows()).toEqual(['A全体'])
  fireEvent.keyDown(one, { key: 'ArrowRight' })
  const two = within(group).getByRole('radio', { name: '上下2面（面 A・B）' }) as HTMLInputElement
  expect(two.checked).toBe(true)
  expect(two.closest('[data-choice-card]')?.textContent).toBe('上下2面AB')
  expect(two.closest('[data-choice-card]')?.querySelectorAll('input:checked')).toHaveLength(1)
  expect(areaRows()).toEqual(['A上', 'B下'])
})
it('設定済みのBが消える形は確認してから変え、取り消すと元の形と設定を保つ', async () => {
  render(<TemplateRichEditor visual />)
  fireEvent.click(screen.getByRole('radio', { name: '1面（面 A）' }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('B')
  expect((screen.getByRole('radio', { name: '上下2面（面 A・B）' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(areaRows()).toEqual(['A上', 'B下'])
  fireEvent.click(screen.getByRole('radio', { name: '1面（面 A）' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /変える|変更/ }))
  expect((screen.getByRole('radio', { name: '1面（面 A）' }) as HTMLInputElement).checked).toBe(true)
  expect(areaRows()).toEqual(['A全体'])
})

it('画像の上の面か右の一覧で選んだ面だけ、下で動きを決める（採用案 Wmch0）', () => {
  render(<TemplateRichEditor visual />)
  /* 見本：A は URL、B は動き。最初は A を選んでいる。 */
  const rows = within(screen.getByRole('list', { name: '面の一覧' })).getAllByRole('button')
  expect(rows.map((row) => row.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  expect(rows[0].textContent).toContain('https://nen.example/summer')
  expect((screen.getByLabelText('面 A のURL') as HTMLInputElement).value).toBe('https://nen.example/summer')
  expect(screen.queryByRole('group', { name: '面 B' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '面 B「下」を選択する' }))
  expect(screen.getByRole('group', { name: '面 B' })).toBeTruthy()
  expect(screen.queryByLabelText('面 A のURL')).toBeNull()
  fireEvent.click(rows[0])
  fireEvent.change(screen.getByLabelText('面 A のURL'), { target: { value: 'https://nen.example/autumn' } })
  expect(within(screen.getByRole('list', { name: '面の一覧' })).getAllByRole('button')[0].textContent).toContain('https://nen.example/autumn')
})

it.each(['shop', 'hq'] as const)('%sでもテキストの追加処理を開き、加点を入力して面を替えても保つ', scope => {
  const host: TemplateEditHost | undefined = scope === 'hq' ? {
    description: '', folders: [], folder: '', onFolderChange: vi.fn(),
    busy: false, onSave: vi.fn(), onCancel: vi.fn(),
  } : undefined
  render(<TemplateRichEditor visual host={host} />)
  fireEvent.click(screen.getByRole('button', { name: '面 B「下」を選択する' }))
  fireEvent.click(screen.getByRole('button', { name: '押されたときにあわせて行うことを足す' }))
  const score = screen.getByRole('spinbutton', { name: /面 B.*の足すスコア/ }) as HTMLInputElement
  fireEvent.change(score, { target: { value: '10' } })
  fireEvent.click(screen.getByRole('button', { name: '面 A「上」を選択する' }))
  fireEvent.click(screen.getByRole('button', { name: '面 B「下」を選択する' }))
  expect((screen.getByRole('spinbutton', { name: /面 B.*の足すスコア/ }) as HTMLInputElement).value).toBe('10')
})
