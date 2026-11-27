// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ id: '', account: 'account-a' as string | null, status: 404, noDraft: false }))
const get = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(state.id ? `id=${state.id}` : ''),
}))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, loading: false }) }))
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, commonActions: { ...actual.api.commonActions,
    get, resources: vi.fn(async () => ({ success: true, data: {} })), list: vi.fn(async () => ({ success: true, data: [] })),
  } } }
})
import { ApiError } from '@/lib/api'
import EditPage from '@/app/common-actions/edit/page'
import VersionsPage from '@/app/common-actions/versions/page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  state.id = ''; state.account = 'account-a'; state.status = 404; state.noDraft = false
  get.mockReset().mockImplementation(async () => { if (state.noDraft) return { success: true, data: { versions: [] } }; throw new ApiError(state.status, 'internal API error') })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
async function draw(page: React.ReactNode) {
  await act(async () => { root.render(page) })
  for (let i = 0; i < 15; i++) await act(async () => { await Promise.resolve() })
}

describe('共通アクションの対象がないとき', () => {
  it.each([
    ['編集', <EditPage key="edit" />, '編集する共通アクションが指定されていません'],
    ['版', <VersionsPage key="versions" />, '版を確認する共通アクションが指定されていません'],
  ])('%sは対象未指定と一覧への戻り先を示す', async (_name, page, message) => {
    await draw(page)
    expect(host.textContent).toContain(message)
    expect(host.textContent).toContain('一覧から')
    expect(host.textContent).not.toContain('IDが不正')
    expect(host.querySelector('a[href="/common-actions"]')).not.toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
  it.each([
    ['編集', <EditPage key="edit" />, '共通アクションを編集するLINEアカウントを選んでください'],
    ['版', <VersionsPage key="versions" />, 'LINE公式アカウントを選んでください'],
  ])('%sはアカウント未選択を示し、取得しない', async (_name, page, message) => {
    state.id = 'ca-1'; state.account = null
    await draw(page)
    expect(host.textContent).toContain(message)
    expect(get).not.toHaveBeenCalled()
  })
  it.each([['編集', <EditPage key="edit" />], ['版', <VersionsPage key="versions" />]])('%sは存在しない対象を案内し、生のエラーを出さない', async (_name, page) => {
    state.id = 'ca-1'
    await draw(page)
    expect(get).toHaveBeenCalledWith('ca-1', 'account-a')
    expect(host.textContent).toContain('この共通アクションは見つかりません')
    expect(host.textContent).toContain('削除されたか、別のLINEアカウントのものです')
    expect(host.textContent).not.toContain('internal API error')
  })
  it('編集権限がないときは権限不足を案内する', async () => {
    state.id = 'ca-1'; state.status = 403
    await draw(<EditPage key="edit" />)
    expect(host.textContent).toContain('この共通アクションを編集する権限がありません')
    expect(host.textContent).not.toContain('internal API error')
  })
  it('下書きがないときは版の画面を案内する', async () => {
    state.id = 'ca-1'; state.noDraft = true
    await draw(<EditPage key="edit" />)
    expect(host.textContent).toContain('編集中の下書きがありません')
    expect(host.querySelector('a[href="/common-actions/versions?id=ca-1"]')).not.toBeNull()
  })

})
