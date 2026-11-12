// @vitest-environment happy-dom
import { expectLockedFolderMenu } from '@/test-utils/permission-locked-control'
/*
 * フォルダの列の「…」（V8.pen 共通部品4 の H・）の動き。
 * V8 の言葉（名前を変える・色を変える・並べ替える・消す）、消す前の確認の窓、
 * 消すと共通のフォルダの口へ DELETE を送って読み直す。閲覧のみでも「…」を開け、変更項目は理由付きで拒否する。
 */
import { renderHook, within } from '@testing-library/react'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@line-crm/shared'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const capturedConfirm = vi.hoisted(() => ({ current: null as null | (() => unknown) }))
vi.mock('./confirm-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('./confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.onConfirm) capturedConfirm.current = props.onConfirm
    return <actual.default {...props} />
  } }
})
vi.mock('@/lib/line-accounts-cache', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/line-accounts-cache')>()),
  loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'acc-1', name: '選択中の店' }, { id: 'acc-owner', name: 'フォルダの所有店' }] })),
}))

const remove = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const update = vi.hoisted(() => vi.fn())
const swap = vi.hoisted(() => vi.fn(async () => ({ success: true, data: { swapped: ['a', 'b'] } })))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, folders: { ...actual.api.folders, delete: remove, swapOrder: swap, update } } }
})

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

import FolderPanel from './folder-panel'
import { useFolderRowActions } from './folder-row-actions'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const folder = (id: string, name: string, order: number): Folder => ({
  id, kind: 'rich_menu', name, parentId: null, displayOrder: order, color: '#2f6fdf', createdAt: '', updatedAt: '', revision: 7,
})
const FOLDERS = [folder('f-1', 'キャンペーン', 0), folder('f-2', 'EC・フォロー', 1)]

function Screen({ enabled, onChanged, onDeleted, accountId = 'acc-1', folders: providedFolders }: { enabled: boolean; onChanged: () => void; onDeleted: (id: string) => void; accountId?: string; folders?: Folder[] }) {
  const folders = providedFolders ?? FOLDERS.map(f => ({ ...f, accountId }))
  const actions = useFolderRowActions({
    kind: 'rich_menu', folders, accountId, enabled, itemLabel: 'リッチメニュー',
    countOf: (id) => (id === 'f-1' ? 2 : 0), onChanged, onDeleted,
  })
  return (
    <>
      <FolderPanel
        activeId=""
        onSelect={() => {}}
        onAddFolder={enabled ? () => {} : undefined}
        rows={[{ id: '', label: 'すべて', count: 3 }, ...folders.map((f, i) => ({ ...actions.rowActions(f, i), id: f.id, label: f.name, count: 1 }))]}
      />
      {actions.dialogs}
    </>
  )
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  remove.mockClear()
  swap.mockClear()
  update.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
})

const menuButton = (name: string) => document.querySelector(`button[aria-label="フォルダ「${name}」の操作"]`) as HTMLButtonElement | null
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click() }) }

describe('フォルダの「…」（共通）', () => {
  it.each([
    ['別の所属', 'owner-b', 'owner-b', undefined],
    ['所属なし', null, '', '所属なし'],
    ['未取得', undefined, '', undefined],
  ])('%sのフォルダは選択中アカウントで所属を埋めない', (_label, owner, id, name) => {
    const selected = { ...FOLDERS[0], accountId: owner }
    const view = renderHook(() => useFolderRowActions({ kind: 'rich_menu', folders: [selected], accountId: 'acc-1', enabled: true, itemLabel: 'リッチメニュー', onChanged: () => {} }))
    act(() => view.result.current.rowActions(selected, 0).onDelete?.())
    const dialog = React.Children.toArray((view.result.current.dialogs as React.ReactElement<{ children: React.ReactNode }>).props.children).at(-1) as React.ReactElement<{ children: React.ReactElement<{ accounts: Array<{ id: string; name?: string; label: string }> }> }>
    expect(dialog.props.children.props.accounts).toEqual([
      { id, name, label: 'フォルダの所属先' },
      { id: 'acc-1', label: '選択中のLINEアカウント' },
    ])
    view.unmount()
  })
  it('フォルダの版が確認できない場合は削除を止める', async () => {
    const unversioned = { ...FOLDERS[0], revision: undefined }
    const view = renderHook(() => useFolderRowActions({ kind: 'rich_menu', folders: [unversioned], accountId: 'acc-1', enabled: true, itemLabel: 'リッチメニュー', onChanged: () => {} }))
    act(() => view.result.current.rowActions(unversioned, 0).onDelete?.())
    const dialog = React.Children.toArray((view.result.current.dialogs as React.ReactElement<{ children: React.ReactNode }>).props.children).at(-1) as React.ReactElement<{ onConfirm: () => void; confirmDisabled: boolean; confirmDisabledReason?: string }>
    expect(dialog.props.confirmDisabled).toBe(true)
    expect(dialog.props.confirmDisabledReason).toContain('読み直')
    await act(async () => dialog.props.onConfirm())
    expect(remove).not.toHaveBeenCalled()
    view.unmount()
  })
  it('同じフォルダを開き直しても閉じた削除確認は使えない', async () => {
    const owned = FOLDERS.map(folder => ({ ...folder, accountId: 'acc-1' }))
    const view = renderHook(() => useFolderRowActions({ kind: 'rich_menu', folders: owned, accountId: 'acc-1', enabled: true, itemLabel: 'リッチメニュー', onChanged: () => {} }))
    const currentDialog = () => React.Children.toArray((view.result.current.dialogs as React.ReactElement<{ children: React.ReactNode }>).props.children).at(-1) as React.ReactElement<{ onConfirm: () => void; onCancel: () => void }>
    act(() => view.result.current.rowActions(owned[0], 0).onDelete?.())
    const old = currentDialog().props
    act(() => old.onCancel())
    act(() => view.result.current.rowActions(owned[0], 0).onDelete?.())
    await act(async () => old.onConfirm())
    expect(remove).not.toHaveBeenCalled()
    await act(async () => currentDialog().props.onConfirm())
    expect(remove).toHaveBeenCalledTimes(1)
    view.unmount()
  })
  it('権限判定が省略された画面でもアカウント変更で削除確認を失効する', async () => {
    const props = { enabled: true, onChanged: vi.fn(), onDeleted: vi.fn() }
    await act(async () => root.render(<Screen {...props} accountId="acc-1" />))
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.trim() === '消す'))
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    await act(async () => root.render(<Screen {...props} accountId="acc-2" />))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })
  it('親画面の未保存確認が済むまでフォルダ編集を開かない', async () => {
    const stop = (event: Event) => event.preventDefault()
    window.addEventListener('musubo:request-unsaved-action', stop)
    try {
      await act(async () => { root.render(<Screen enabled onChanged={() => {}} onDeleted={() => {}} />) })
      await click(menuButton('キャンペーン'))
      await click([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.trim() === '名前を変える'))
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { window.removeEventListener('musubo:request-unsaved-action', stop) }
  })
  it('V8 の言葉で出す。端の行には押せない並べ替えを置かない', async () => {
    await act(async () => { root.render(<Screen enabled onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    expect(menuItems()).toEqual(['名前を変える', '色を変える', '並べ替える（下へ）', '消す'])
  })

  it('所有先と環境を表示し、選択中アカウントで穴埋めしない', async () => {
    const folders = [{ ...FOLDERS[0], accountId: 'acc-owner' }, FOLDERS[1]]
    await act(async () => { root.render(<Screen enabled folders={folders} onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('フォルダの所有店'))
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('環境')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('選択中の店')
  })

  it('所有先と選択中のアカウントが異なるフォルダを削除しない', async () => {
    const folders = [{ ...FOLDERS[0], accountId: 'acc-owner' }]
    await act(async () => { root.render(<Screen enabled folders={folders} onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    await act(async () => { await capturedConfirm.current?.() })
    expect(remove).not.toHaveBeenCalled()
  })

  it('共通フォルダは選択アカウントを指定せずに削除する', async () => {
    const folders = [{ ...FOLDERS[0], accountId: null }]
    await act(async () => { root.render(<Screen enabled folders={folders} onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('所属なし')
    await act(async () => { await capturedConfirm.current?.() })
    expect(remove).toHaveBeenCalledWith('f-1', undefined, 7)
  })

  it('所有先を確認できないフォルダは削除しない', async () => {
    await act(async () => { root.render(<Screen enabled folders={[FOLDERS[0]]} onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    await act(async () => { await capturedConfirm.current?.() })
    expect(remove).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('所有先を確認できません')
  })

  it('削除完了直後に古い確定を繰り返しても一度だけ送る', async () => {
    await act(async () => { root.render(<Screen enabled onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    const held = capturedConfirm.current!
    await act(async () => { held(); await Promise.resolve(); await Promise.resolve(); held(); await Promise.resolve() })
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('閉じた確認の古い確定は削除しない', async () => {
    await act(async () => { root.render(<Screen enabled onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    const held = capturedConfirm.current!
    await click([...document.querySelectorAll('[role="alertdialog"] button')].find((el) => el.textContent?.trim() === 'キャンセル'))
    await act(async () => { await held() })
    expect(remove).not.toHaveBeenCalled()
  })

  it('旧アカウントの削除中に切り替えても、新しいアカウントの操作を妨げない', async () => {
    let resolveOld!: (result: { success: true; data: null }) => void
    remove.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    await act(async () => { root.render(<Screen enabled accountId="acc-1" onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    await click([...document.querySelectorAll('[role="alertdialog"] button')].find((el) => el.textContent?.trim() === '削除する'))
    await act(async () => { root.render(<Screen enabled accountId="acc-2" onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((el) => el.textContent?.trim() === '削除する')!
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(false)
    await click(button)
    expect(remove).toHaveBeenCalledTimes(2)
    await act(async () => { resolveOld({ success: true, data: null }); await Promise.resolve() })
  })

  it('切替後もフォルダ編集を開ける', async () => {
    await act(async () => { root.render(<Screen enabled accountId="acc-1" onChanged={() => {}} onDeleted={() => {}} />) })
    await act(async () => { root.render(<Screen enabled accountId="acc-2" onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '名前を変える'))
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  })

  it('旧アカウントの確認を保持しても切替後に削除できない', async () => {
    await act(async () => { root.render(<Screen enabled accountId="acc-1" onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    const held = capturedConfirm.current!
    await act(async () => { root.render(<Screen enabled accountId="acc-2" onChanged={() => {}} onDeleted={() => {}} />) })
    await act(async () => { await held() })
    expect(remove).not.toHaveBeenCalled()
  })

  it('消す前に確認の窓で件数と行き先を読ませ、確かめたら DELETE して読み直す', async () => {
    const onChanged = vi.fn()
    const onDeleted = vi.fn()
    await act(async () => { root.render(<Screen enabled onChanged={onChanged} onDeleted={onDeleted} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '消す'))
    expect(document.body.textContent).toContain('「キャンペーン」を削除しますか？')
    expect(document.body.textContent).toContain('中のリッチメニュー 2 件は消えずに「未分類」へ移ります。')
    expect(remove).not.toHaveBeenCalled()
    await click([...document.querySelectorAll('button')].find((el) => el.textContent === '削除する'))
    expect(remove).toHaveBeenCalledWith('f-1', 'acc-1', 7)
    expect(onDeleted).toHaveBeenCalledWith('f-1')
    expect(onChanged).toHaveBeenCalled()
  })

  it('確認後に別の人が変更したら、読み直して窓を開き直すまで削除できない', async () => {
    remove.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, code: 'VERSION_CONFLICT' }))
    const onChanged = vi.fn(), onDeleted = vi.fn()
    await act(async () => { root.render(<Screen enabled onChanged={onChanged} onDeleted={onDeleted} />) })
    await click(menuButton('キャンペーン'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.trim() === '消す'))
    const dialog = within(document.querySelector('[role="alertdialog"]') as HTMLElement)
    await click(dialog.getByRole('button', { name: '削除する' }))
    expect(remove).toHaveBeenCalledWith('f-1', 'acc-1', 7)
    expect(onChanged).toHaveBeenCalledOnce()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(dialog.getByText(/窓を閉じて最新の内容を確認/)).toBeTruthy()
    expect((dialog.getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('並べ替えは隣と入れ替える口を1回だけ送る', async () => {
    await act(async () => { root.render(<Screen enabled onChanged={() => {}} onDeleted={() => {}} />) })
    await click(menuButton('EC・フォロー'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '並べ替える（上へ）'))
    expect(swap).toHaveBeenCalledTimes(1)
    expect(swap).toHaveBeenCalledWith('f-2', 'f-1', 'acc-1')
  })

  it('変えられない人にも「…」を出し、変更項目は理由付きで拒否する', async () => {
    await act(async () => { root.render(<Screen enabled={false} onChanged={() => {}} onDeleted={() => {}} />) })
    await expectLockedFolderMenu(menuButton('キャンペーン'))
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(swap).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('フォルダを追加する')
    expect(document.body.textContent).not.toContain('色を変える')
  })
})

it('色の変更に失敗しても窓と入力を残し、再試行で名前・色・所属を保存して読み直す', async () => {
  update.mockResolvedValueOnce({ success: false, error: '保存できませんでした' }).mockResolvedValueOnce({ success: true, data: FOLDERS[0] })
  const onChanged = vi.fn()
  await act(async () => root.render(<Screen enabled onChanged={onChanged} onDeleted={() => {}} />))
  await click(menuButton('キャンペーン'))
  await click([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === '色を変える'))
  const dialog = within(document.querySelector('[role="dialog"]') as HTMLElement)
  await click(dialog.getByRole('button', { name: /フォルダの色/ }))
  await click([...document.querySelectorAll('[role="radio"]')].find((el) => el.getAttribute('aria-label') === 'ピンク'))
  await click(dialog.getByRole('button', { name: '保存する' }))
  expect(update).toHaveBeenCalledWith('f-1', { name: 'キャンペーン', color: '#ec4899' }, 'acc-1')
  expect(dialog.getByRole('alert').textContent).toContain('保存できませんでした')
  expect((dialog.getByRole('textbox', { name: 'フォルダ名' }) as HTMLInputElement).value).toBe('キャンペーン')
  expect(dialog.getByRole('button', { name: 'フォルダの色：ピンク' })).toBeTruthy()
  expect(onChanged).not.toHaveBeenCalled()
  await click(dialog.getByRole('button', { name: '保存する' }))
  expect(onChanged).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
