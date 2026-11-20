import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { findDetailMenuItem } from '@/test-utils/detail-menu'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/**
 * ★V8 タグ タグの一覧（src/v8/tags）の動きの試験。
 * 絵（・・）の置き場に移した操作が、押せる形で残っているかを見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const narrow = vi.hoisted(() => ({ value: false }))
const replaceMock = vi.hoisted(() => vi.fn())

vi.mock('next/link', () => ({
  default: ({ children, href, className, title }: { children: React.ReactNode; href: string; className?: string; title?: string }) =>
    React.createElement('a', { href, className, title }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/tags',
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => role.value,
  useStaffIdentity: () => null,
  canManageRole: (value: string | null | undefined) => value === 'owner' || value === 'admin',
}))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => narrow.value }))
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

import { FRIEND_ATTRIBUTES_QA_GROUPS, FRIEND_ATTRIBUTES_QA_TAGS, isUnused } from '@/components/friend-fields/tags-page-v4'
import TagsList from './list'
import { tagLinkText } from './tags-tab'

let container: HTMLDivElement
let root: Root

async function render(node: React.ReactElement) {
  await act(async () => { root.render(node) })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/tags')
  role.value = verifiedStaffRole('owner')
  narrow.value = false
  replaceMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const fixture = { items: FRIEND_ATTRIBUTES_QA_TAGS, groups: FRIEND_ATTRIBUTES_QA_GROUPS }

describe('V8 タグ タグの一覧', () => {
  it('絵の列（タグ・人数・付け方・連動・使っている所・操作）と4つのタブを出し、名前の前にフォルダの色の丸', async () => {
    await render(<TagsList fixture={fixture} />)
    const heads = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    // 左にフォルダの列があるので表にフォルダ列は置かない（2026-10-07 オーナー）。
    expect(heads).toEqual(['タグ', '人数', '付け方', '連動', '使っている所', '操作'])
    expect(container.querySelectorAll('tbody [data-list-name]').length).toBe(FRIEND_ATTRIBUTES_QA_TAGS.length)
    for (const label of ['タグ', '友だち情報欄', '対応マーク', '保存した検索']) {
      expect(screen.getAllByRole('tab', { name: label }).length).toBeGreaterThan(0)
    }
    expect(container.querySelector('[data-design-node="I1E7Bt"]')).not.toBeNull()
    expect(screen.getByText('EC顧客連携済み')).toBeTruthy()
    const createLinks = screen.getAllByRole('link', { name: 'タグを作る' })
    expect(createLinks.map(link => link.getAttribute('href'))).toEqual(createLinks.map(() => '/tags/new'))
    expect(container.querySelector('[data-list-name]')?.textContent).not.toContain('登録')
  })

  it('空の状態列を外しても、名前が重なったタグの注意は出す', async () => {
    await render(<TagsList fixture={{ ...fixture, items: fixture.items.map((tag, index) => index === 0 ? { ...tag, cleanupReasons: ['duplicate_name' as const] } : tag) }} />)
    expect(screen.getByRole('columnheader', { name: '状態' })).toBeTruthy()
    expect(screen.getByText('名前が重なっている')).toBeTruthy()
  })

  // 2026-10-06 オーナー決定：閲覧のみには押せないボタンを置かずに隠す（帯は出す）。
  it('1152 の板 ID は aPeD8、閲覧のみは fkGUR で帯を出し、作る・CSV・行の「…」を出さない', async () => {
    narrow.value = true
    await render(<TagsList fixture={fixture} />)
    expect(container.querySelector('[data-design-node="aPeD8"]')).not.toBeNull()
    // ：1152でも名前の色の丸でフォルダを伝え、重複の列を置かない。
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).not.toContain('フォルダ')
    expect(container.querySelectorAll('tbody [data-list-name]').length).toBe(FRIEND_ATTRIBUTES_QA_TAGS.length)
    await act(async () => root.unmount())
    root = createRoot(container)
    role.value = verifiedStaffRole('staff')
    narrow.value = false
    await render(<TagsList fixture={fixture} />)
    expect(container.querySelector('[data-design-node="fkGUR"]')).not.toBeNull()
    expect(screen.getByText(PERMISSION_LOCK_SUMMARY.feature)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'CSVで一括登録する' })).toBeNull()
    const create = screen.getAllByRole('button', { name: 'タグを作る' })
    expect(create.every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true)
    fireEvent.click(create[0])
    expect(screen.queryByRole('link', { name: 'タグを作る' })).toBeNull()
    expect(screen.queryAllByRole('link', { name: 'タグを作る' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^タグ「.+」の操作$/ })).toHaveLength(0)
  })

  it.each(['staff', 'owner', 'admin'])('タグの編集・複製は権限のある人だけが使える（%s）', async (staffRole) => {
    role.value = staffRole
    await render(<TagsList fixture={fixture} />)
    await act(async () => { fireEvent.click(container.querySelector('tbody tr')!) })
    const panel = screen.getByRole('dialog', { name: fixture.items[0].name })
    if (staffRole === 'staff') {
      expect(within(panel).getByRole('button', { name: '編集する' }).getAttribute('aria-disabled')).toBe('true')
      expect(within(panel).queryByRole('link', { name: '編集する' })).toBeNull()
    } else expect(within(panel).getByRole('link', { name: '編集する' }).getAttribute('href')).toContain('/tags/edit')
    const duplicate = await findDetailMenuItem('複製して作る', panel)
    expect(duplicate.getAttribute('aria-disabled') === 'true').toBe(staffRole === 'staff')
    expect(duplicate.getAttribute('href') !== null).toBe(staffRole !== 'staff')
  })

  it('「よく使う絞り込み」に星を出さず、残った未使用の絞り込みは動く', async () => {
    await render(<TagsList fixture={fixture} />)
    expect(container.querySelectorAll('tbody tr').length).toBe(FRIEND_ATTRIBUTES_QA_TAGS.length)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'よく使う絞り込み' })) })
    expect(screen.queryByRole('menuitem', { name: /★|☆|注目/ })).toBeNull()
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '未使用のタグ' })) })
    const unused = FRIEND_ATTRIBUTES_QA_TAGS.filter(isUnused).length
    expect(container.querySelectorAll('tbody tr').length).toBe(unused)
    expect(screen.getByRole('button', { name: /よく使う絞り込み（1 件選択中）/ })).toBeTruthy()
  })

  it('タブを押すとそのタブの本文に切り替わる', async () => {
    await render(<TagsList fixture={fixture} />)
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '対応マーク' })) })
    expect(container.querySelector('[data-design-node="vKDj5"]')).not.toBeNull()
    expect(screen.getByText('対応マークを読み込めませんでした')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'マークを作る' }).getAttribute('href')).toMatch(/^\/tags\/marks\/new(\?|$)/)
  })

  it('保存した検索のタブでは閲覧のみの作成リンクを隠し、検索の閲覧は保つ', async () => {
    role.value = verifiedStaffRole('staff')
    await render(<TagsList fixture={fixture} />)
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '保存した検索' })) })
    expect(screen.queryByRole('link', { name: '友だち一覧で条件を作る' })).toBeNull()
    expect(screen.getByPlaceholderText('条件名で探す')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: 'この画面の説明' })
    await act(async () => { fireEvent.click(toggle) })
    expect(document.getElementById(toggle.getAttribute('aria-describedby') ?? '')?.textContent).toContain('この条件を保存')
    await act(async () => { fireEvent.click(toggle) })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByPlaceholderText('条件名で探す')).toBeTruthy()
  })

  it('保存した検索の説明は題から開閉し、条件作成のリンクには検索の印を出す', async () => {
    await render(<TagsList fixture={fixture} />)
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '保存した検索' })) })
    const toggle = screen.getByRole('button', { name: 'この画面の説明' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(toggle) })
    expect(document.getElementById(toggle.getAttribute('aria-describedby') ?? '')?.textContent).toContain('配信や自動処理の宛先にも使えます')
    await act(async () => { fireEvent.click(toggle) })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const create = screen.getByRole('link', { name: '友だち一覧で条件を作る' })
    expect(create.getAttribute('href')).toBe('/friends')
    expect(create.querySelector('svg.lucide-search')).not.toBeNull()
  })

  it('連動は絵の書き方（本人+10・1.2倍 他1）', () => {
    const base = { mileageReward: 0, referralMileageReward: 0, mileageMultiplierBps: null, otherActionCount: 0 } as unknown as Tag
    expect(tagLinkText({ ...base, mileageReward: 10, mileageMultiplierBps: 12000, otherActionCount: 1 } as Tag)).toBe('本人+10・1.2倍 他1')
    expect(tagLinkText({ ...base, otherActionCount: 2 } as Tag)).toBe('他2')
    expect(tagLinkText(base)).toBe('—')
  })
})

afterEach(() => { verifiedStaffRole(null) })
