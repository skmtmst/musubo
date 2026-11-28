import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/**
 * 回答フォームの編集（★V8・src/v8/form-edit）の動き。
 * V8 のテーマで出し、タブ・ページの指定・競合の帯・公開の確かめ・押せないボタンが無いことを見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyLayout, type FormLayout } from '@line-crm/shared'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const navigation = vi.hoisted(() => ({ query: '', push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  usePathname: () => '/form-submissions/edit',
  useSearchParams: () => new URLSearchParams(navigation.query),
  useParams: () => ({}),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a>,
}))
const account = vi.hoisted(() => ({ id: 'acc-1' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { id: account.id, name: 'テスト店', liffId: 'liff-1' }, accounts: [], loading: false }),
}))
const chromeTitle = vi.hoisted(() => vi.fn())
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: chromeTitle, usePageCrumbs: () => {}, usePageChrome: () => ({ title: '' }) }))

const forcedRole = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('@/lib/staff-role', async original => {
  const actual = await original<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => { const role = actual.useStaffRole(); return forcedRole.value ?? role } }
})
const staffMe = vi.hoisted(() => vi.fn())
const formsGet = vi.hoisted(() => vi.fn())
const formsUpdate = vi.hoisted(() => vi.fn())
const formsCreateDraft = vi.hoisted(() => vi.fn())
const formsPublish = vi.hoisted(() => vi.fn())
const menuStaff = vi.hoisted(()=>vi.fn(async (_accountId: string, _menuId: string): Promise<{ staff: Array<{ id: string; display_name: string }> }> => ({staff:[]})))
const emptyList = vi.hoisted(() => async () => ({ success: true, data: [] as never[] }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: vi.fn(async () => ({ success: true, data: [{ id: 'tag-1', name: 'アンケート回答' }] })),
    bookingApi: {
      ...actual.bookingApi,
      listMenus: vi.fn(async () => ({ menus: [{ id: 'bm-1', name: 'トリミング（小型犬）', duration_minutes: 60, is_active: 1 }] })),
      listMenuStaff: menuStaff,
    },
    api: {
      ...actual.api,
      forms: { ...actual.api.forms, get: formsGet, update: formsUpdate, publish: formsPublish, createDraft: formsCreateDraft },
      // 下書きの自動保存は閲覧のみの人には動かさないため、役割を読む（通信させない）。
      staff: { ...actual.api.staff, me: staffMe },
      friendFields: { ...actual.api.friendFields, list: emptyList },
      scenarios: { ...actual.api.scenarios, list: emptyList },
      reminders: { ...actual.api.reminders, list: emptyList },
      templates: { ...actual.api.templates, list: emptyList },
    },
  }
})

import FormEditPage from '@/app/form-submissions/edit/page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const layout: FormLayout = (() => {
  const l = emptyLayout()
  l.sections = [
    { id: 's1', name: '来店について', blocks: [
      { id: 'h1', kind: 'heading', text: '来店アンケート', level: 1 },
      { id: 'q1', kind: 'input', type: 'radio', name: 'purpose', label: '今日のご来店の目的は？', required: true, choiceMode: 'tag', choices: [{ id: 'c1', label: 'トリミング' }, { id: 'c2', label: 'ご相談' }] },
    ] },
    { id: 's2', name: '次回について', blocks: [
      { id: 'q2', kind: 'input', type: 'booking', name: 'next', label: '次回のご希望の日時を選んでください', booking: { menuId: 'bm-1', staffId: null, daysAhead: 14 } },
    ] },
  ]
  l.options = { ...l.options, afterActions: [{ kind: 'send_text', text: 'ご回答ありがとうございます' }] }
  return l
})()

const formData = {
  id: 'form-1', name: '来店アンケート', description: '', isActive: true, submitCount: 1284, onSubmitTagId: null,
  layout, ogTitle: null, ogDescription: null, ogImageUrl: null, contentRevision: 7, publishedVersionId: 'v3', publishedContentRevision: 6,
}

let host: HTMLDivElement
let root: Root
const render = async (query: string) => {
  navigation.query = query
  act(() => { root.render(<><FormEditPage /><ToastHost /></>) })
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  account.id = 'acc-1'
  forcedRole.value = null
  staffMe.mockReset().mockResolvedValue({ success: true, data: { role: 'owner' } })
  document.documentElement.dataset.theme = 'v8'
  formsGet.mockImplementation(async () => ({ success: true, data: structuredClone(formData) }))
  formsUpdate.mockImplementation(async () => ({ success: true, data: { id: 'form-1', contentRevision: 8, updatedAt: '' } }))
  formsCreateDraft.mockReset().mockResolvedValue({ success: true, data: { id: 'form-created', isActive: false, contentRevision: 1 } })
  formsPublish.mockImplementation(async () => ({ success: true, data: { id: 'v4', versionNumber: 4, contentRevision: 8, publishedAt: '', replayed: false } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

it.each(['v3', null])('公開版 %s の下書き保存をトースト1回で知らせる', async publishedVersionId => {
  formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), publishedVersionId } })
  await render('id=form-1')
  fireEvent.change(screen.getByLabelText('フォーム名'), { target: { value: '秋のアンケート' } })
  fireEvent.click(getPageAction({ name: '下書きを保存' }))
  await waitFor(() => expect(formsUpdate).toHaveBeenCalledWith('form-1', 'acc-1', expect.objectContaining({ name: '秋のアンケート' })))
  await screen.findByText('下書きを保存しました')
  expect(screen.getAllByText(/下書きを保存しました/)).toHaveLength(1)
})
