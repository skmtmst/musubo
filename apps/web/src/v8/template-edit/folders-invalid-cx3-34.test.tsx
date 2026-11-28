// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 テンプレートの作る・編集（src/v8/template-edit）の動きの試験。V8 のテーマで描いて確かめる。
 * 保存の口・断り方・保存の 409 の帯・差し込み・閲覧のみ（押せない操作を置かない）・クーポン／リサーチの保存。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const templatesApi = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), update: vi.fn(), publish: vi.fn(), delete: vi.fn() }))
const assetsCreate = vi.hoisted(() => vi.fn())
const assetsPublish = vi.hoisted(() => vi.fn())
const assetsList = vi.hoisted(() => vi.fn())
const assetsUpdate = vi.hoisted(() => vi.fn())
const assetFoldersList = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const account = vi.hoisted(() => ({ id: 'account-a' }))
const search = vi.hoisted(() => ({ value: '' }))
const loadExamples = vi.hoisted(() => vi.fn())
vi.mock('@/v8/templates/examples', () => ({ loadTemplateExamples: loadExamples }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      templates: { ...api.templates, ...templatesApi },
      broadcastMessageAssets: { ...api.broadcastMessageAssets, create: assetsCreate, publish: assetsPublish, list: assetsList, update: assetsUpdate, folders: { list: assetFoldersList } },
      folders: { ...api.folders, list: listFolders },
      friendFields: { list: async () => ({ success: true, data: [{ fieldKey: 'plan', name: 'プラン', canInsertText: true, defaultValue: '定期便' }] }) },
      commonVars: { list: async () => ({ success: true, data: [] }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => React.createElement('a', { href, ...rest }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(search.value),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '然 - NEN -' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})
const narrow = vi.hoisted(() => ({ value: false }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => narrow.value }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => true }) }))
vi.mock('@/components/auto-replies/inline-action-list', async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...(await importOriginal()),
  useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [], notificationRules: [] }),
}))

import { ApiError } from '@/lib/api'
import TemplateEditV8 from './edit'
import TemplateMessageEditor from './message'
import TemplateRichEditor from './rich'
import TemplateAssetEditor from './asset'
import type { TemplateEditHost } from './host'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const detail = (patch: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    id: 'template-1', name: '予約前日のご案内', category: 'general', folderId: null, messageType: 'text',
    messageContent: '明日のご予約です。', accountId: 'account-a', publishedVersion: 3, draftRevision: 2,
    updatedAt: '2026-10-06T05:02:00Z',
    usedBy: { autoReplies: [], automations: [], scenarioSteps: [], reminderSteps: [], richMenuAreas: [], trackedLinks: [] },
    ...patch,
  },
})

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}
async function mount(query = '') {
  search.value = query
  await act(async () => { root.render(<TemplateEditV8 />) })
  await flush()
}
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } })

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'v8')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  role.value = verifiedStaffRole('owner')
  account.id = 'account-a'
  narrow.value = false
  push.mockReset()
  for (const fn of Object.values(templatesApi)) fn.mockReset()
  assetsCreate.mockReset()
  assetsPublish.mockReset()
  assetsList.mockReset()
  assetsUpdate.mockReset()
  assetFoldersList.mockReset()
  assetFoldersList.mockResolvedValue({ success: true, data: [{ id: 'asset-folder-1', name: '販促' }] })
  assetsPublish.mockResolvedValue({ success: true, data: { id: 'asset-1', publishedVersion: 1, draftRevision: 0 } })
  listFolders.mockReset()
  listFolders.mockResolvedValue({ success: true, data: [{ id: 'fol-1', kind: 'template', name: '予約', itemCount: 1 }] })
  templatesApi.get.mockResolvedValue(detail())
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

it.each(['message', 'rich'] as const)('%s のフォルダが不正なら入力を残して読み直す', async kind => {
  listFolders.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [{ id: 'folder', name: '予約' }] })
  await act(async () => { root.render(kind === 'message' ? <TemplateMessageEditor id={null} visual={false} /> : <TemplateRichEditor />) })
  await flush()
  expect(screen.getByText(/フォルダを読み込めませんでした/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'フォルダ' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '入力中の名前' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' })) })
  await flush()
  expect(screen.queryByText(/フォルダを読み込めませんでした/)).toBeNull()
  expect((screen.getByRole('button', { name: 'フォルダ' }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByLabelText('テンプレート名') as HTMLInputElement).value).toBe('入力中の名前')
})
