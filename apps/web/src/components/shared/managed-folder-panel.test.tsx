// @vitest-environment happy-dom
/*
 * 一覧の左のフォルダの列（共通 ManagedFolderPanel・）の動き。
 * 共通の /api/folders を kind とアカウントで読み、すべて→各フォルダ→未分類の順に並べ、
 * 「フォルダを追加」「…」（名前・色・並べ替え・消す）と注を、変えてよい人にだけ出す。
 * kind が null（API が無い一覧）は「すべて」だけで、押せない口を置かない。
 */
import React, { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@line-crm/shared'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const folder = (id: string, name: string, order: number, color: string | null = '#3b82f6'): Folder => ({
  id, kind: 'scenario', accountId: 'acc-1', name, parentId: null, displayOrder: order, color, createdAt: '', updatedAt: '', itemCount: order + 2, revision: 1,
} as Folder)

const list = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const swap = vi.hoisted(() => vi.fn(async () => ({ success: true, data: { swapped: ['a', 'b'] } })))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, folders: { ...actual.api.folders, list, delete: remove, swapOrder: swap } } }
})

import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import ManagedFolderPanel, { useManagedFolders, type ManagedFolderControl } from './managed-folder-panel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Screen({ kind, canManage, onSelectSpy, controlRef, accountId = 'acc-1' }: { kind: string | null; canManage: boolean; onSelectSpy?: (id: string) => void; controlRef?: React.Ref<ManagedFolderControl>; accountId?: string }) {
  const state = useManagedFolders(kind, accountId)
  const [active, setActive] = useState('f-1')
  return (
    <ManagedFolderPanel
      kind={kind}
      accountId={accountId}
      folders={state.folders}
      onChanged={state.reload}
      canManage={canManage}
      itemLabel="シナリオ"
      activeId={active}
      onSelect={(id) => { onSelectSpy?.(id); setActive(id) }}
      allCount={9}
      unfiledCount={state.unfiledCount}
      createAction={canManage ? <button type="button">シナリオを作る</button> : undefined}
      controlRef={controlRef}
    />
  )
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  list.mockReset()
  list.mockResolvedValue({ success: true, data: [folder('f-1', 'キャンペーン', 0), folder('f-2', '会員', 1, null)], unfiledCount: 4 })
  remove.mockClear()
  swap.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  forgetStaffIdentity()
  host.remove()
  delete document.documentElement.dataset.theme
})

const rowLabels = () => [...host.querySelectorAll('nav[aria-label="フォルダ"] button[aria-current], nav[aria-label="フォルダ"] button[title]')]
  .map((el) => el.getAttribute('title')).filter((t): t is string => Boolean(t) && !t!.startsWith('フォルダ「'))
const menuButton = (name: string) => document.querySelector(`button[aria-label="フォルダ「${name}」の操作"]`) as HTMLButtonElement | null
const buttonByText = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click() }) }

describe('一覧の左のフォルダの列（共通）', () => {
  it('未保存の確認が必要なときは確認が済むまでフォルダ追加を開かない', async () => {
    let resume: (() => void) | undefined
    const hold = (event: Event) => { event.preventDefault(); resume = (event as CustomEvent<{ run: () => void }>).detail.run }
    window.addEventListener('musubo:request-unsaved-action', hold)
    await act(async () => { root.render(<Screen kind="scenario" canManage />) })
    await click(buttonByText('フォルダを追加'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(resume).toBeTypeOf('function')
    await act(async () => { resume?.() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('フォルダを追加')
    window.removeEventListener('musubo:request-unsaved-action', hold)
  })
  it('店舗を切り替えたあとは、前の店舗の遅い件数で上書きしない', async () => {
    let resolveOld!: (value: unknown) => void
    list.mockImplementation((_kind, accountId) => accountId === 'acc-1'
      ? new Promise(resolve => { resolveOld = resolve })
      : Promise.resolve({ success: true, data: [folder('new', '切替後のフォルダ', 0)], unfiledCount: 2 }))
    await act(async () => { root.render(<Screen kind="scenario" canManage />) })
    await act(async () => { root.render(<Screen kind="scenario" canManage accountId="acc-2" />) })
    expect(host.querySelector('button[title="未分類"]')?.textContent).toBe('未分類2')
    await act(async () => { resolveOld({ success: true, data: [folder('old', '前の店舗', 0)], unfiledCount: 9 }) })
    expect(host.textContent).toContain('切替後のフォルダ')
    expect(host.textContent).not.toContain('前の店舗')
    expect(host.querySelector('button[title="未分類"]')?.textContent).toBe('未分類2')
  })

  it('kind とアカウントで共通のフォルダを読み、作る→すべて→各フォルダ→未分類の順に並べる', async () => {
    await act(async () => { root.render(<Screen kind="scenario" canManage />) })
    expect(list).toHaveBeenCalledWith('scenario', 'acc-1')
    expect(rowLabels()).toEqual(['すべて', 'キャンペーン', '会員', '未分類'])
    const text = host.textContent ?? ''
    expect(text.indexOf('シナリオを作る')).toBeLessThan(text.indexOf('すべて'))
    expect(text).toContain('フォルダを追加')
    // ：削除の影響は操作直前の確認窓へ。下の削除試験で説明とAPIを守る。
    expect(text).not.toContain('フォルダを消しても、中のシナリオは未分類に残ります')
    // 未分類の数はサーバーの同じ母集団の数
    expect(host.querySelector('button[title="未分類"]')?.textContent).toContain('4')
  })

  it('色の無いフォルダも名前から選んだ色のフォルダで出す', async () => {
    await act(async () => { root.render(<Screen kind="scenario" canManage />) })
    const icon = host.querySelector('button[title="会員"] svg.lucide-folder') as SVGElement
    expect(icon.style.color).not.toBe('')
    expect(icon.getAttribute('fill')).toBe('currentColor')
  })

  it('「…」は 名前を変える・色を変える・並べ替える・消す。消すと DELETE を送り、選んでいたら「すべて」へ戻して読み直す', async () => {
    const onSelect = vi.fn()
    await act(async () => { root.render(<Screen kind="scenario" canManage onSelectSpy={onSelect} />) })
    await click(menuButton('キャンペーン'))
    expect(menuItems()).toEqual(['名前を変える', '色を変える', '並べ替える（下へ）', '消す'])
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('消す')))
    expect(document.body.textContent).toContain('中のシナリオ 2 件は消えずに「未分類」へ移ります')
    list.mockClear()
    await click(buttonByText('削除する'))
    expect(remove).toHaveBeenCalledWith('f-1', 'acc-1', 1)
    expect(onSelect).toHaveBeenCalledWith('all')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('並べ替えは隣と入れ替える共通の口を呼ぶ', async () => {
    await act(async () => { root.render(<Screen kind="scenario" canManage />) })
    await click(menuButton('会員'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('上へ')))
    expect(swap).toHaveBeenCalledWith('f-2', 'f-1', 'acc-1')
  })

  it('閲覧のみも操作を残し、行の選択を保ったまま追加・変更・削除を起動しない', async () => {
    verifiedStaffRole('viewer')
    await act(async () => { root.render(<Screen kind="scenario" canManage={false} />) })
    expect(rowLabels()).toEqual(['すべて', 'キャンペーン', '会員', '未分類'])
    const add = buttonByText('フォルダを追加')
    expect(add?.getAttribute('aria-disabled')).toBe('true')
    await click(add)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(menuButton('キャンペーン'))
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.getAttribute('aria-disabled')).toBe('true')
      await click(item)
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(remove).not.toHaveBeenCalled()
    expect(swap).not.toHaveBeenCalled()
  })

  it('kind が null（API が無い一覧）は「すべて」だけ。追加・「…」・未分類・注を出さず、読みにも行かない', async () => {
    await act(async () => { root.render(<Screen kind={null} canManage />) })
    expect(list).not.toHaveBeenCalled()
    expect(rowLabels()).toEqual(['すべて'])
    expect(host.textContent).toContain('シナリオを作る')
    expect(host.textContent).not.toContain('フォルダを追加')
    expect(host.textContent).not.toContain('未分類')
  })

  it('畳んだ板の「フォルダの操作」から同じ窓を開ける（変えてよい人だけ）', async () => {
    const ref = createRef<ManagedFolderControl>()
    await act(async () => { root.render(<Screen kind="scenario" canManage controlRef={ref} />) })
    await act(async () => { ref.current?.startDelete(folder('f-2', '会員', 1, null)) })
    expect(document.body.textContent).toContain('「会員」を削除しますか？')
    await click(buttonByText('キャンセル'))
    await act(async () => { ref.current?.startAdd() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('フォルダを追加')

    act(() => root.unmount())
    root = createRoot(host)
    const viewerRef = createRef<ManagedFolderControl>()
    await act(async () => { root.render(<Screen kind="scenario" canManage={false} controlRef={viewerRef} />) })
    await act(async () => { viewerRef.current?.startAdd() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
