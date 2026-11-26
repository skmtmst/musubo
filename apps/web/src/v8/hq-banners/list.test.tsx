// @vitest-environment happy-dom
/*
 * V8 統括のバナー生成・一覧（src/v8/hq-banners/list.tsx）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 数のカード・プロジェクトのカード・作る窓（名前が空なら押せない）・ライブラリの次の12件・
 * 閲覧のみには押せないボタン（作る・取り込む・星）を置かない。
 */
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: (allowed: boolean) => allowed ? undefined : '統括の管理権限が必要です' }))

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const presets = vi.hoisted(() => vi.fn())
const stats = vi.hoisted(() => vi.fn())
const listProjects = vi.hoisted(() => vi.fn())
const createProject = vi.hoisted(() => vi.fn())
const updateProject = vi.hoisted(() => vi.fn())
const listImages = vi.hoisted(() => vi.fn())
const listAccounts = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const nav = vi.hoisted(() => ({ query: '' }))
const roleBox = vi.hoisted(() => ({ role: 'owner' as string | null }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      hqBanners: {
        ...actual.api.hqBanners,
        presets,
        stats,
        projects: { ...actual.api.hqBanners.projects, list: listProjects, create: createProject, update: updateProject },
        images: { ...actual.api.hqBanners.images, list: listImages },
      },
      lineAccounts: { ...actual.api.lineAccounts, list: listAccounts },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.query),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useTenantWideAccess: () => ['owner', 'admin'].includes(roleBox.role), useStaffRole: () => roleBox.role }
})

import HqBannersListV8 from './list'
import { flushListUrlState } from '@/components/shared/list-url-state'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: `${name}の説明`, isFavorite: false, archivedAt: null, imageCount: 3, runningCount: 0,
  createdBy: null, createdAt: '2026-09-01T09:00:00+09:00', updatedAt: '2026-09-30T10:00:00+09:00', ...extra,
})
const image = (n: number) => ({
  id: `img-${n}`, projectId: 'p1', generationId: null, sequence: n, source: 'upload', parentImageId: null, isFavorite: n === 1,
  createdBy: null, createdAt: `2026-09-${String(30 - n).padStart(2, '0')}T10:00:00+09:00`,
  media: { id: `m-${n}`, filename: `${n}.png`, mimeType: 'image/png', sizeBytes: 100, width: 1040, height: 1040, url: `https://example.invalid/${n}.png` },
  generation: null, deliveredAccountIds: n === 1 ? ['a1'] : [],
})

beforeEach(() => {
  flushListUrlState()
  window.history.replaceState(null, '', '/hq/banners')
  document.documentElement.dataset.theme = 'v8'
  nav.query = ''
  roleBox.role = 'owner'
  presets.mockResolvedValue({ success: true, data: { presets: [], maxCount: 4, engineReady: true, usage: { month: { used: 40, limit: 150, remaining: 110 }, today: { used: 6, limit: 30, remaining: 24 }, paused: false, pausedReason: null } } })
  stats.mockResolvedValue({ success: true, data: { projects: { active: 2, archived: 1 }, deliveredImages: 9, deliveredAccounts: 3 } })
  listProjects.mockResolvedValue({ success: true, data: [project('p1', '秋のキャンペーン', { isFavorite: true }), project('p2', '2周年 春の感謝祭', { imageCount: 0, runningCount: 1 })] })
  createProject.mockResolvedValue({ success: true, data: project('p9', '新しい案件') })
  updateProject.mockImplementation(async (id: string, patch: { isFavorite?: boolean }) => ({ success: true, data: project(id, '秋のキャンペーン', patch) }))
  listImages.mockResolvedValue({ success: true, data: Array.from({ length: 12 }, (_, i) => image(i + 1)), nextBefore: '2026-09-18T10:00:00+09:00', counts: { all: 23, favorite: 3, delivered: 9, unused: 14 } })
  listAccounts.mockResolvedValue({ success: true, data: [] })
  push.mockReset()
  replace.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
})

async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() })
}

const buttonNamed = (name: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.replace(/\s+/g, '') === name.replace(/\s+/g, ''))

describe('V8 バナー生成・一覧（src/v8/hq-banners）の動き', () => {
  it('数のカードとプロジェクトのカード（更新日・生成中の札）が出る', async () => {
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    expect(host.textContent).toContain('今月の残り')
    expect(host.textContent).toContain('上限 150枚')
    expect(host.textContent).toContain('秋のキャンペーン')
    expect(host.textContent).toContain('3 枚・09/30 更新')
    expect(host.textContent).toContain('—・いま作成中')
    expect(host.querySelector('[aria-label="秋のキャンペーン を開く"]')).toBeTruthy()
  })

  it('作る窓は名前が空のあいだ押せず、作ると新しいプロジェクトを開く', async () => {
    stats.mockResolvedValueOnce({ success: true, data: { projects: { active: 2, archived: 1 }, deliveredImages: 9, deliveredAccounts: 3 } })
    stats.mockResolvedValue({ success: true, data: { projects: { active: 3, archived: 1 }, deliveredImages: 9, deliveredAccounts: 3 } })
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    const projectCount = () => within(host).getByText('プロジェクト').closest('[data-kpi-presentation]')!.querySelector('[data-kpi-number]')?.textContent
    expect(projectCount()).toBe('2')
    expect(host.querySelectorAll('button[aria-label$=" を開く"]')).toHaveLength(2)
    act(() => { buttonNamed('プロジェクトを作る')!.click() })
    await flush()
    const submit = buttonNamed('作って開く') as HTMLButtonElement
    expect(submit, '作って開くがありません').toBeTruthy()
    expect(submit.disabled).toBe(true)
    const name = document.querySelector('input[placeholder="例：春の感謝祭 2周年"]') as HTMLInputElement
    fireEvent.change(name, { target: { value: '新しい案件' } })
    await flush()
    expect(submit.disabled).toBe(false)
    listProjects.mockResolvedValue({ success: true, data: [project('p9', '新しい案件'), project('p1', '秋のキャンペーン'), project('p2', '2周年 春の感謝祭', { imageCount: 0, runningCount: 1 })] })
    stats.mockResolvedValue({ success: true, data: { projects: { active: 3, archived: 1 }, deliveredImages: 9, deliveredAccounts: 3 } })
    act(() => { submit.click() })
    await flush()
    expect(createProject).toHaveBeenCalledWith({ name: '新しい案件', description: null })
    expect(host.textContent).toContain('新しい案件')
    const projectKpi = [...host.querySelectorAll('[data-kpi-presentation]')].find(item => item.textContent?.includes('プロジェクト'))
    expect(projectKpi?.textContent).toMatch(/3\s*件/)
    expect(push).toHaveBeenCalledWith('/hq/banners?highlight=p9')
    expect(host.textContent).toContain('新しい案件')
    expect(projectCount()).toBe('3')
    expect(host.querySelectorAll('button[aria-label$=" を開く"]')).toHaveLength(3)
    expect(host.textContent).toContain('2周年 春の感謝祭')
    expect(listProjects).toHaveBeenCalledTimes(2)
    expect(stats).toHaveBeenCalledTimes(2)
  })

  it('作成後の一覧更新が失敗しても新しい案件を残し、読み直せる', async () => {
    act(() => { root.render(<HqBannersListV8 />) }); await flush()
    act(() => { buttonNamed('プロジェクトを作る')!.click() }); await flush()
    fireEvent.change(document.querySelector('input[placeholder="例：春の感謝祭 2周年"]')!, { target: { value: '新しい案件' } })
    listProjects.mockRejectedValueOnce(new Error('offline'))
    act(() => { buttonNamed('作って開く')!.click() }); await flush()
    expect(host.textContent).toContain('新しい案件')
    expect(host.textContent).toContain('一覧を更新できませんでした')
    listProjects.mockRejectedValueOnce(new Error('offline again'))
    act(() => { buttonNamed('もう一度読み込む')!.click() }); await flush()
    expect(host.textContent).toContain('新しい案件')
    expect(host.textContent).toContain('一覧を更新できませんでした')
    listProjects.mockResolvedValue({ success: true, data: [project('p9', '新しい案件'), project('p1', '秋のキャンペーン')] })
    act(() => { buttonNamed('もう一度読み込む')!.click() }); await flush()
    expect(host.textContent).toContain('新しい案件')
    expect(host.textContent).not.toContain('一覧を更新できませんでした')
  })

  it('作成前の遅い件数応答で新しい件数を上書きしない', async () => {
    let resolveOld!: (value: unknown) => void
    stats.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    act(() => { buttonNamed('プロジェクトを作る')!.click() })
    await flush()
    fireEvent.change(document.querySelector('input[placeholder="例：春の感謝祭 2周年"]')!, { target: { value: '新しい案件' } })
    listProjects.mockResolvedValue({ success: true, data: [project('p9', '新しい案件')] })
    stats.mockResolvedValue({ success: true, data: { projects: { active: 3, archived: 1 }, deliveredImages: 9, deliveredAccounts: 3 } })
    act(() => { buttonNamed('作って開く')!.click() })
    await flush()
    await act(async () => { resolveOld({ success: true, data: { projects: { active: 2, archived: 1 }, deliveredImages: 9, deliveredAccounts: 3 } }); await Promise.resolve() })
    expect(within(host).getByText('プロジェクト').closest('[data-kpi-presentation]')?.textContent).toContain('3')
  })

  it('アーカイブ・検索中でも作成後は絞り込みを解除して新しい案件を出す', async () => {
    window.history.replaceState(null, '', '/hq/banners?view=archived&q=旧案件')
    listProjects.mockImplementation(async (params?: { archived?: boolean }) => ({ success: true, data: params?.archived ? [project('old', '旧案件')] : [project('p9', '新しい案件')] }))
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    expect(host.textContent).toContain('旧案件')
    expect(within(host.querySelector('[role="group"][aria-label="見るもので絞り込む"]') as HTMLElement).getByRole('button', { name: /アーカイブ/ }).getAttribute('aria-pressed')).toBe('true')
    act(() => { buttonNamed('プロジェクトを作る')!.click() })
    await flush()
    fireEvent.change(document.querySelector('input[placeholder="例：春の感謝祭 2周年"]')!, { target: { value: '新しい案件' } })
    act(() => { buttonNamed('作って開く')!.click() })
    await flush()
    expect((document.querySelector('input[placeholder="プロジェクト名・説明で探す"]') as HTMLInputElement).value).toBe('')
    expect(host.textContent).toContain('新しい案件')
    expect(within(host.querySelector('[role="group"][aria-label="見るもので絞り込む"]') as HTMLElement).getByRole('button', { name: 'すべて' }).getAttribute('aria-pressed')).toBe('true')
    expect(listProjects).toHaveBeenLastCalledWith({ archived: false })
  })

  it('作成に失敗したら検索と表示を保ち、一覧を読み直さない', async () => {
    window.history.replaceState(null, '', '/hq/banners?q=秋のキャンペーン')
    createProject.mockRejectedValueOnce(new Error('offline'))
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    act(() => { buttonNamed('プロジェクトを作る')!.click() })
    await flush()
    fireEvent.change(document.querySelector('input[placeholder="例：春の感謝祭 2周年"]')!, { target: { value: '新しい案件' } })
    act(() => { buttonNamed('作って開く')!.click() })
    await flush()
    expect((document.querySelector('input[placeholder="プロジェクト名・説明で探す"]') as HTMLInputElement).value).toBe('秋のキャンペーン')
    expect(host.textContent).toContain('秋のキャンペーン')
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(listProjects).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })

  it.each(['loading', 'error'])('一覧が%sでも作成後に一覧を再取得し、既存の案件を隠さない', async initial => {
    let resolveOld: ((value: unknown) => void) | undefined
    if (initial === 'loading') listProjects.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    else listProjects.mockRejectedValueOnce(new Error('offline'))
    listProjects.mockResolvedValue({ success: true, data: [project('p1', '既存の案件'), project('p9', '新しい案件')] })
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    act(() => { buttonNamed('プロジェクトを作る')!.click() })
    await flush()
    fireEvent.change(document.querySelector('input[placeholder="例：春の感謝祭 2周年"]')!, { target: { value: '新しい案件' } })
    await flush()
    act(() => { buttonNamed('作って開く')!.click() })
    await flush()
    if (resolveOld) await act(async () => { resolveOld!({ success: true, data: [project('old', '古い結果')] }) })
    await flush()
    expect(host.textContent).toContain('既存の案件')
    expect(host.textContent).toContain('新しい案件')
    expect(host.textContent).not.toContain('古い結果')
  })

  it('星を押すとお気に入りを切り替える', async () => {
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    const star = host.querySelector('[aria-label="秋のキャンペーン をお気に入りから外す"]') as HTMLButtonElement
    expect(star).toBeTruthy()
    act(() => { star.click() })
    await flush()
    expect(updateProject).toHaveBeenCalledWith('p1', { isFavorite: false })
  })

  it('お気に入り・生成中・アーカイブは上の絞り込みの札。選ぶ物のないフォルダ列を出さず、絞り込みを保つ（W2）', async () => {
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    expect(host.querySelector('[data-template-region="folders"]')).toBeNull()
    expect(host.textContent).not.toContain('フォルダを追加')
    const chips = host.querySelector('[role="group"][aria-label="見るもので絞り込む"]') as HTMLElement
    expect(chips.textContent).toContain('お気に入り 1')
    expect(chips.textContent).toContain('生成中 1')
    act(() => { (Array.from(chips.querySelectorAll('button')).find((b) => b.textContent?.startsWith('お気に入り')) as HTMLButtonElement).click() })
    await flush()
    expect(host.textContent).toContain('秋のキャンペーン')
    expect(host.textContent).not.toContain('2周年 春の感謝祭')
    act(() => { (Array.from(chips.querySelectorAll('button')).find((b) => b.textContent?.startsWith('すべて')) as HTMLButtonElement).click() })
    await flush()
    expect(host.textContent).toContain('2周年 春の感謝祭')
  })

  it('ライブラリの配布済み・未使用も上の絞り込みの札で選ぶ', async () => {
    nav.query = 'tab=library'
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    const chips = host.querySelector('[role="group"][aria-label="見るもので絞り込む"]') as HTMLElement
    expect(chips.textContent).toContain('配布済み 9')
    act(() => { (Array.from(chips.querySelectorAll('button')).find((b) => b.textContent?.startsWith('配布済み')) as HTMLButtonElement).click() })
    await flush()
    expect(listImages).toHaveBeenLastCalledWith(expect.objectContaining({ delivered: true }))
  })

  it('ライブラリは12枚ずつ・数は「見る」に出て、次の12件で続きを読む', async () => {
    nav.query = 'tab=library'
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    expect(host.textContent).toContain('1–12 件 / 23 件')
    expect(listImages).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 12, withCounts: true }))
    act(() => { buttonNamed('次の 12 件')!.click() })
    await flush()
    expect(listImages).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 12, before: '2026-09-18T10:00:00+09:00' }))
    expect(buttonNamed('画像を取り込む')).toBeTruthy()
  })

  it('ライブラリの道具の段は探す・札・向きの切り替えの1段で、動かない並びの字を置かない', async () => {
    nav.query = 'tab=library'
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    expect(host.querySelector('input[aria-label="テキスト・指示で探す"]')).not.toBeNull()
    expect(host.querySelector('[role="group"][aria-label="見るもので絞り込む"]')).not.toBeNull()
    expect(host.querySelector('[role="group"][aria-label="用途"]')).not.toBeNull()
    expect(host.textContent).not.toContain('並び：作成が新しい順')
  })

  it('閲覧のみには作る・取り込む・星を置かない（押せないボタンを残さない）', async () => {
    roleBox.role = 'viewer'
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    expect(host.textContent).toContain('秋のキャンペーン')
    expect(buttonNamed('プロジェクトを作る')?.getAttribute('aria-disabled')).toBe('true')
    act(() => { buttonNamed('プロジェクトを作る')?.click() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[aria-label="秋のキャンペーン をお気に入りから外す"]')).toBeNull()
    act(() => { root.unmount() })
    nav.query = 'tab=library'
    root = createRoot(host)
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    expect(host.textContent).toContain('1–12 件 / 23 件')
    expect(buttonNamed('画像を取り込む')?.getAttribute('aria-disabled')).toBe('true')
    act(() => { buttonNamed('画像を取り込む')?.click() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[aria-label="お気に入りにする"]')).toBeNull()
  })
})

it.each([false,true])('ライブラリの案件取得success:false（保管=%s）を空の案件と扱わない',async archived=>{
 nav.query='tab=library'
 listProjects.mockImplementation(async(params?:{archived?:boolean})=>Boolean(params?.archived)===archived?{success:false,error:'fixture failure'}:{success:true,data:[]})
 await act(async()=>{root.render(<HqBannersListV8/>)})
 await flush()
 expect(host.querySelector('[data-list-state="error"]')).toBeTruthy()
 expect(host.querySelector('[data-list-state="empty"]')).toBeNull()
})

// 接続の文字列ではなく、両一覧で実際に描かれる数と作成入口を確かめる。
it.each(['', 'tab=library'])('数・タブ・説明とフォルダなしの作成入口を型へ接続する（%s）', async query => {
  nav.query = query
  act(() => { root.render(<HqBannersListV8 />) })
  await flush()
  const frame = host.querySelector('[data-page-template="list"]')!
  const statsRegion = frame.querySelector('[data-template-region="stats"]')!
  expect(statsRegion.querySelector('[data-content-layout="stats"] [data-kpi-strip]')).toBeTruthy()
  expect(statsRegion.querySelectorAll('[data-kpi-label]')).toHaveLength(4)
  expect(frame.querySelector('[data-template-region="tabs"]')).toBeTruthy()
  expect(frame.querySelector('[data-template-region="heading"] button[aria-label="この画面の説明"]')).toBeTruthy()
  expect(within(frame.querySelector<HTMLElement>('[data-template-region="heading"]')!).getByRole('button', { name: query ? '画像を取り込む' : 'プロジェクトを作る', exact: true })).toBeTruthy()
})

it('空一覧では閲覧のみのプロジェクト作成を理由付きで止める', async () => {
    roleBox.role = 'viewer'
    listProjects.mockResolvedValue({ success: true, data: [] })
    act(() => { root.render(<HqBannersListV8 />) })
    await flush()
    const b = buttonNamed('最初のプロジェクトを作る')!
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(host.textContent).toContain('統括の管理権限が必要です')
    act(() => { b.click() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
