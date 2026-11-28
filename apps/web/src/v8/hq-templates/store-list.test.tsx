// @vitest-environment happy-dom
/*
 * 統括のひな形の一覧（店と同じ形＋配る口・〜・）の動き。
 * 6種類のタブで種類を替える・配布先の列・全種類の行の［配る］（「…」の左。オーナー 2026-10-08）・閲覧のみには配る／作る口を置かない・フォルダで絞る。
 */
import { waitFor } from '@testing-library/react'
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: (allowed: boolean) => allowed ? undefined : '統括の管理権限が必要です' }))

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/templates',
}))

const heldFolder = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && typeof props.title === 'string' && props.title.includes('フォルダ') && props.onConfirm) heldFolder.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})
import HqStoreList, { type HqStoreListProps } from './store-list'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import type { HqTemplate } from '@/lib/hq-templates-api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (id: string, name: string, count: number, folder: string | null = null): HqTemplate => ({
  id, name, description: null, template_type: 'template', folder_id: folder, revision: 1, updated_at: '2026-09-30T01:00:00.000Z',
  kind: 'message', content_summary: '本文', distributed_account_count: count,
  distributed_account_names: count ? ['本店', '渋谷店'].slice(0, count) : [], distributed_account_more: 0,
})
const ROWS = [row('t-1', '秋の新商品', 2, 'f-1'), row('t-2', '定休日', 0)]

let host: HTMLDivElement
let root: Root
const handlers = () => ({
  onKindChange: vi.fn(), onFolderFilter: vi.fn(), onAddFolder: vi.fn(async () => {}), onRenameFolder: vi.fn(async () => {}),
  onDeleteFolder: vi.fn(async () => {}), onCreate: vi.fn(), onEdit: vi.fn(), onDistribute: vi.fn(), onDuplicate: vi.fn(), onRemove: vi.fn(),
})
async function render(extra: Partial<HqStoreListProps> = {}) {
  const h = handlers()
  const props: HqStoreListProps = {
    type: 'template', rows: ROWS, ready: true, busy: false, canEdit: true, accountTotal: 4,
    kind: 'message', kindCounts: { message: 2, carousel: 1 }, folders: [{ id: 'f-1', name: 'お問い合わせ', revision: 1 }],
    folderLoadFailed: false, folderFilter: 'all', ...h, ...extra,
  }
  await act(async () => { root.render(<HqStoreList {...props} />) })
  return h
}

beforeEach(() => {
  window.history.replaceState({}, '', '/hq/templates')
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
})

const buttons = () => [...document.querySelectorAll('button')]

describe('統括のひな形の一覧（店と同じ形）', () => {
  it('リッチメニューの配布数から、店ごとの公開との違いを確認できる', async () => {
    await render({ type: 'rich_menu', kind: undefined })
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="配ったアカウントの説明"]')!
    expect(help).toBeTruthy()
    await act(async () => { help.click() })
    expect(document.getElementById(help.getAttribute('aria-describedby')!)?.textContent).toContain('LINEへの公開は各アカウントで行います')
  })
  it.each(['template', 'form', 'tag', 'rich_menu'] as const)('フォルダの説明は共通の?へ渡し、%sの固有説明と機能を保つ', async type => {
    await render({ type, kind: type === 'template' ? 'message' : undefined })
    const panel = host.querySelector('aside[aria-label="フォルダ"]')!
    expect(panel.textContent).not.toContain('フォルダを消しても')
    const help = panel.querySelector<HTMLButtonElement>('button[aria-label="フォルダの説明"]')!
    expect(help).toBeTruthy()
    await act(async () => { help.click() })
    const explanation = document.getElementById(help.getAttribute('aria-describedby')!)!
    expect(explanation.textContent).toContain('フォルダを消しても、中の項目は未分類に残ります。')
    if (type === 'template') expect(explanation.textContent).toContain('種類のタブをまたいで')
    expect(panel.textContent).toContain('フォルダを追加')
    expect(host.querySelector('tbody tr')).toBeTruthy()
  })
  it('メッセージのタブでも保存した形の札を出し、古い応答からテキストを推測しない', async () => {
    await render({ rows: [
      { ...row('text', '文字の案内', 0), message_type: 'text' },
      { ...row('flex', 'カードの案内', 0), message_type: 'flex' },
      { ...row('image', '写真の案内', 0), message_type: 'image' },
      row('legacy', '古い応答', 0),
    ] })
    const cells = [...host.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[2].textContent)
    expect(cells).toEqual(['テキスト', 'カード型', '画像', '—'])
    expect(host.querySelectorAll('tbody tr')[3].querySelectorAll('td')[2].querySelector('span')).toBeNull()
  })

  it.each([true, false])('フォルダの取得失敗でも作る操作と閲覧時の場所を保つ（編集=%s）', async canEdit => {
    const h = await render({ folderLoadFailed: true, canEdit })
    const panel = host.querySelector('aside[aria-label="フォルダ"]')!
    expect(panel.textContent).toContain('フォルダを読み込めませんでした')
    expect(panel.textContent).not.toContain('フォルダを追加')
    const create = panel.querySelector('button') as HTMLButtonElement | null
    if (canEdit) {
      expect(create).not.toBeNull()
      await act(async () => create!.click())
      expect(h.onCreate).toHaveBeenCalledOnce()
    } else {
      expect(create?.getAttribute('aria-disabled')).toBe('true')
      await act(async () => create!.click())
      expect(h.onCreate).not.toHaveBeenCalled()
    }
  })

  for (const canEdit of [true, false]) {
    it(`タグ一覧はタグ名から始まり、星・注目の操作と絞り込みを出さない（編集=${canEdit}）`, async () => {
      await render({ type: 'tag', kind: undefined, canEdit })
      const heads = [...host.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
      // ［配る］は「…」の中なので、編集できる人も見出しの空の列は「…」の1つだけ。
      expect(heads).toEqual(['タグ', '人数', '付け方', '配布先', ''])
      expect(host.querySelector('tbody tr td')?.textContent).toContain(ROWS[0].name)
      expect(host.querySelector('svg.lucide-star')).toBeNull()
      expect(host.querySelector('[aria-label*="友だち一覧に表示"]')).toBeNull()
      expect(host.textContent).not.toMatch(/☆|★|注目のみ|★のみ表示/)
      expect(buttons().some((button) => /注目|一覧に出す/.test(button.getAttribute('aria-label') ?? ''))).toBe(false)
    })
  }

  it('フォルダの保存色を左の列と名前の前に表示する', async () => {
    await render({ folders: [{ id: 'f-1', name: 'お問い合わせ', revision: 1, color: '#8b5cf6' }] })
    const dot = host.querySelector('[data-folder-dot="filed"]') as HTMLElement
    expect(dot.style.backgroundColor).toBe('#8b5cf6')
    expect(dot.getAttribute('aria-label')).toBe('フォルダ：お問い合わせ')
    expect(host.innerHTML).toContain('#8b5cf6')
  })

  it('タグ名はタグの札（中にフォルダ色の丸）で出し、押すと詳細を開く', async () => {
    const onOpen = vi.fn()
    await render({ type: 'tag', onOpen, folders: [{ id: 'f-1', name: 'お問い合わせ', revision: 1, color: '#8b5cf6' }] })
    const name = host.querySelector('[data-list-name]')!
    expect(name.textContent).toBe('秋の新商品')
    const pill = name.querySelector('[role="group"][aria-label="タグ「秋の新商品」"]')!
    expect(pill).not.toBeNull()
    const dot = pill.querySelector('[role="img"][aria-label="フォルダ：お問い合わせ"]')!
    expect(dot.getAttribute('style')).toContain('#8b5cf6')
    expect(name.querySelectorAll('[data-folder-dot]')).toHaveLength(1)
    expect(pill.contains(dot)).toBe(true)
    await act(async () => { name.querySelector<HTMLButtonElement>('button')!.click() })
    expect(onOpen).toHaveBeenCalledWith(ROWS[0])
  })

  it('配布先の列に配ったアカウントの数、配っていない行は「まだ配っていない」', async () => {
    await render()
    expect(host.textContent).toContain('2 アカウント')
    expect(host.textContent).toContain('本店・渋谷店')
    expect(host.textContent).toContain('まだ配っていない')
  })

  /* （オーナー決定）：行の右端は「…」1つ。［配る］は「…」の中にあり、押すとその行を配る。 */
  const rowMenuButton = (name: string) => {
    const tr = [...document.querySelectorAll('tr')].find((row) => row.querySelector('[data-list-name]')?.textContent?.includes(name))
    return tr?.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement | null
  }
  const distributeItem = () => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === '配る') as HTMLElement | undefined

  for (const type of ['template', 'tag', 'rich_menu', 'form', 'scenario'] as const) {
    it(`${type} の一覧は、行の右端が「…」1つで、その中の［配る］を押すとその行を配る`, async () => {
      const h = await render({ type, kind: type === 'template' ? 'message' : undefined })
      for (const r of ROWS) {
        /* 行の右端に［配る］のボタンを並べない。 */
        expect(buttons().some((b) => b.getAttribute('aria-label') === `${r.name}を配る`), r.name).toBe(false)
        const menu = rowMenuButton(r.name)
        expect(menu, r.name).toBeTruthy()
        await act(async () => { menu!.click() })
        expect(distributeItem(), r.name).toBeTruthy()
        await act(async () => { menu!.click() })
      }
      await act(async () => { rowMenuButton('定休日')!.click() })
      await act(async () => { distributeItem()!.click() })
      expect(h.onDistribute).toHaveBeenCalledWith(ROWS[1])
      /* ［配る］の列（空の見出し）は無い。 */
      expect(document.querySelector('th[aria-label="配る"]')).toBeNull()
      expect(host.textContent).not.toContain('アカウントへ配る')
    })
  }

  it('テンプレートは「…」の中から配る。配布の札と今月送った数を出す（i0Ao0R・API-18）', async () => {
    const rows = [
      { ...ROWS[0], outdated_account_count: 1, this_month_sent_count: 1860 },
      { ...ROWS[1], this_month_sent_count: null },
      { ...row('t-3', '予約の受付', 1), outdated_account_count: 0, this_month_sent_count: 0 },
    ]
    const h = await render({ rows, stats: { thisMonthSentCount: 1860, outdatedTemplateCount: 1 } })
    expect(host.textContent).toContain('更新の配布待ち')
    expect(host.textContent).toContain('未配布')
    expect(host.textContent).toContain('配布済み')
    expect(host.textContent).toContain('1,860通')
    expect(host.textContent).toContain('0通')
    expect(host.textContent).toContain('新しい版を未配布')
    const menu = buttons().find((b) => b.getAttribute('aria-label') === 'テンプレート「秋の新商品」の操作')
    // 統括の一覧の行の「…」は絵（・・・）どおり 28角。
    expect(menu!.getAttribute('data-size')).toBe('row')
    await act(async () => { menu!.click() })
    await act(async () => { distributeItem()!.click() })
    expect(h.onDistribute).toHaveBeenCalledWith(rows[0])
  })

  it.each(['template', 'rich_menu', 'form', 'scenario'] as const)('%sは配布記録の状態を出し、公開と未取得を推測しない', async type => {
    await render({ type, kind: undefined, rows: [
      { ...row('distributed', '配ったメニュー', 3), template_type: 'rich_menu', outdated_account_count: 0 },
      { ...row('changed', '更新待ちメニュー', 3), template_type: 'rich_menu', outdated_account_count: 1 },
      { ...row('draft', 'まだ配らないメニュー', 0), template_type: 'rich_menu' },
      { ...row('unknown', '記録が未取得', 3), template_type: 'rich_menu', distributed_account_count: undefined },
      { ...row('unknown-version', '版が未取得', 3), template_type: 'rich_menu' },
    ] })
    const column = [...host.querySelectorAll('thead th')].findIndex(th => th.textContent === '配布状況')
    expect(column).toBeGreaterThanOrEqual(0)
    for (const [id, state] of [['distributed', '配布済み'], ['changed', '更新の配布待ち'], ['draft', '未配布'], ['unknown', '—'], ['unknown-version', '—']]) {
      const tr = host.querySelector('tr[data-row-id="' + id + '"]')!
      expect(tr.querySelectorAll('td')[column].textContent).toBe(state)
    }
    expect(host.querySelector('tbody')!.textContent).not.toContain('公開中')
  })

  it.each([true, false])('一覧未取得中は配布済みの行を出さない（読込中=%s）', async busy => {
    await render({ ready: false, busy })
    expect(host.querySelector('tbody')).toBeNull()
    expect(host.textContent).toContain(busy ? 'ひな形を読み込み中…' : '読み込めませんでした。権限や接続を確認し、ページを再読み込みしてください。')
  })

  it('タグは人数・付け方、リッチメニューは順・誰に出すか・今月押されたを出す（DzdC3・noVq4）', async () => {
    await render({ type: 'tag', kind: undefined, rows: [{ ...ROWS[0], template_type: 'tag', friend_count: 64, assignment_method: '手動・自動' }] })
    expect(host.textContent).toContain('64人')
    expect(host.textContent).toContain('手動・自動')
    await render({ type: 'rich_menu', kind: undefined, rows: [{ ...ROWS[0], template_type: 'rich_menu', display_order: 0, display_audience: 'タグ「ゴールド会員」', tap_count: 3210 }] })
    expect(host.querySelector('[data-truncated-text][title="タグ「ゴールド会員」"]')?.textContent).toBe('タグ「ゴールド会員」')
    expect(host.textContent).toContain('3,210回')
  })

  it('共有ページ送りは1ページでは件数だけ残し、2ページなら次と前で表示行を切り替える', async () => {
    window.history.replaceState(null, '', '/hq/templates')
    await render()
    expect(host.querySelector('[data-pagination-summary]')?.textContent).toBe('2件中 1〜2件')
    expect(host.querySelector('nav[data-pagination]')).toBeNull()
    expect(host.querySelector('[data-pagination] button')).toBeNull()

    const rows = Array.from({ length: 21 }, (_, index) => ({ ...row('page-' + (index + 1), '案内' + (index + 1), 0), outdated_account_count: 0 }))
    await render({ rows })
    expect(host.querySelector('[data-pagination-summary]')?.textContent).toBe('21件中 1〜20件')
    const next = host.querySelector<HTMLButtonElement>('nav[data-pagination] button[aria-label="次のページ"]')!
    expect(next.disabled).toBe(false)
    await act(async () => { next.click() })
    expect(host.querySelector('[data-pagination-summary]')?.textContent).toBe('21件中 21〜21件')
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(host.querySelector('tbody tr')?.getAttribute('data-row-id')).toBe('page-21')
    expect(host.querySelector('nav[data-pagination] [aria-current="page"]')?.getAttribute('aria-label')).toBe('2ページ目へ')
    const previous = host.querySelector<HTMLButtonElement>('nav[data-pagination] button[aria-label="前のページ"]')!
    await act(async () => { previous.click() })
    expect(host.querySelector('[data-pagination-summary]')?.textContent).toBe('21件中 1〜20件')
    expect(host.querySelectorAll('tbody tr')).toHaveLength(20)
    expect(host.querySelector('tbody tr')?.getAttribute('data-row-id')).toBe('page-1')
  })

  it('上のタブで種類を替える（店と同じ6種類）', async () => {
    const h = await render()
    const tabs = [...document.querySelectorAll('[role="tab"], a, button')].map((el) => el.textContent ?? '')
    for (const label of ['メッセージ', 'カルーセル', 'リッチメッセージ', 'リッチビデオ', '質問', 'クーポン', 'リサーチ']) expect(tabs.some((text) => text.startsWith(label))).toBe(true)
    const carousel = [...document.querySelectorAll('button, a')].find((el) => el.textContent?.startsWith('カルーセル'))
    await act(async () => { (carousel as HTMLElement).click() })
    expect(h.onKindChange).toHaveBeenCalledWith('carousel')
  })

  it('「未配布」の札で配っていない行だけにする', async () => {
    await render()
    const chip = buttons().find((b) => b.textContent?.includes('未配布'))
    await act(async () => { chip!.click() })
    expect(host.textContent).not.toContain('秋の新商品')
    expect(host.textContent).toContain('定休日')
  })

  for (const type of ['template', 'tag', 'rich_menu', 'form'] as const) {
    it(`閲覧のみには作る・配る口を置かない（${type}）`, async () => {
      await render({ type, kind: type === 'template' ? 'message' : undefined, canEdit: false })
      const create = buttons().filter((b) => b.textContent?.includes('を作る'))
      expect(create.length).toBeGreaterThan(0)
      expect(create.every((b) => b.getAttribute('aria-disabled') === 'true')).toBe(true)
      await act(async () => create[0].click())
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(buttons().some((b) => b.getAttribute('aria-label')?.endsWith('を配る'))).toBe(false)
      expect(buttons().some((b) => b.textContent?.trim() === '配る')).toBe(false)
      expect(document.querySelector('th[aria-label="配る"]')).toBeNull()
    })
  }
})

describe('フォルダの配布口を出す範囲（G-7）', () => {
  it('すべてと空フォルダには出さず、未分類と別種類だけ入ったフォルダにも出す', async () => {
    document.documentElement.dataset.theme = 'v8'
    const onDistributeFolder = vi.fn()
    await render({ rows: [ROWS[1]], folderContents: [ROWS[0], ROWS[1]], onDistributeFolder,
      folders: [{ id: 'f-1', name: '別種類だけ', revision: 1 }, { id: 'f-empty', name: '空', revision: 1 }] })
    const all = buttons().find((button) => button.getAttribute('aria-label') === 'フォルダ「すべて」の操作')!
    await act(async () => all.click())
    expect([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === 'このフォルダを配る')).toBe(false)
    expect([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === 'フォルダを追加')).toBe(true)
    await act(async () => all.click())
    const unfiled = buttons().find((button) => button.getAttribute('aria-label') === 'フォルダ「未分類」の操作')!
    expect(unfiled).toBeTruthy()
    await act(async () => unfiled.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)))
    const entry = document.querySelector('[role="menuitem"]') as HTMLButtonElement
    expect(entry.textContent).toBe('このフォルダを配る')
    expect(entry.querySelector('strong')).not.toBeNull()
    await act(async () => entry.click())
    expect(onDistributeFolder).toHaveBeenCalledWith('none', '未分類')
    await act(async () => buttons().find((button) => button.getAttribute('aria-label') === 'フォルダ「空」の操作')!.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)))
    expect([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === 'このフォルダを配る')).toBe(false)
    delete document.documentElement.dataset.theme
  })
  it('閲覧のみにはフォルダの配布口を出さない', async () => {
    await render({ canEdit: false, folderContents: ROWS, onDistributeFolder: vi.fn() })
    expect(buttons().some((button) => button.getAttribute('aria-label')?.endsWith('の操作'))).toBe(false)
  })
})

it.each(['template', 'rich_menu', 'form', 'tag', 'scenario'] as const)('%s のひな形も色を変えて保存できる', async (type) => {
  const h = await render({ type })
  await act(async () => (host.querySelector('[aria-label="フォルダ「お問い合わせ」の操作"]') as HTMLButtonElement).click())
  await act(async () => ([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === '色を変更する') as HTMLElement).click())
  await act(async () => (document.querySelector('[aria-label^="フォルダの色："]') as HTMLButtonElement).click())
  await act(async () => (document.querySelector('[role="radio"][aria-label="ピンク"]') as HTMLButtonElement).click())
  await act(async () => (buttons().find((el) => el.textContent === '保存する') as HTMLButtonElement).click())
  expect(h.onRenameFolder).toHaveBeenCalledWith(expect.objectContaining({ id: 'f-1', revision: 1 }), 'お問い合わせ', '#ec4899')
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
})

it('フォルダの保存が 409（ほかの人が先に直した）なら理由を出して一覧を読み直し、入力は残したまま2回目は新しい版で通る（2026-10-09）', async () => {
  const { HqTemplatesApiError } = await import('@/lib/hq-templates-api')
  const onRenameFolder = vi.fn()
    .mockRejectedValueOnce(new HqTemplatesApiError('内容が更新されました。', 409, true, true, 'VERSION_CONFLICT'))
    .mockResolvedValueOnce(undefined)
  const onReloadFolders = vi.fn(async () => { reload() })
  let reload: () => void = () => {}
  const base = handlers()
  function Harness() {
    const [folders, setFolders] = React.useState([{ id: 'f-1', name: 'お問い合わせ', revision: 1 }])
    reload = () => setFolders([{ id: 'f-1', name: 'お問い合わせ', revision: 2 }])
    return <HqStoreList type="tag" rows={ROWS} ready busy={false} canEdit accountTotal={4} folders={folders} folderLoadFailed={false} folderFilter="all"
      {...base} onRenameFolder={onRenameFolder} onReloadFolders={onReloadFolders} />
  }
  await act(async () => { root.render(<Harness />) })
  await act(async () => (host.querySelector('[aria-label="フォルダ「お問い合わせ」の操作"]') as HTMLButtonElement).click())
  await act(async () => ([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === '名前を変更する') as HTMLElement).click())
  const input = document.querySelector('[role="dialog"] input') as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'テスト')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => (buttons().find((el) => el.textContent === '保存する') as HTMLButtonElement).click())
  expect(onRenameFolder).toHaveBeenNthCalledWith(1, expect.objectContaining({ revision: 1 }), 'テスト', folderDisplayColor({ name: 'お問い合わせ' }))
  expect(onReloadFolders).toHaveBeenCalledTimes(1)
  const alert = document.querySelector('[role="dialog"] [data-folder-dialog-error]') as HTMLElement
  expect(alert.textContent).toContain('ほかの人が先に直しました。最新の内容を読み込みました。もう一度保存してください。')
  expect((document.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe('テスト')
  await act(async () => (buttons().find((el) => el.textContent === '保存する') as HTMLButtonElement).click())
  expect(onRenameFolder).toHaveBeenNthCalledWith(2, expect.objectContaining({ revision: 2 }), 'テスト', folderDisplayColor({ name: 'お問い合わせ' }))
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
})

it('同じ名前（409 FOLDER_NAME_CONFLICT）は名前の欄に、読めない理由は状態番号と符号を添えて出す', async () => {
  const { HqTemplatesApiError } = await import('@/lib/hq-templates-api')
  const onAddFolder = vi.fn()
    .mockRejectedValueOnce(new HqTemplatesApiError('x', 409, true, true, 'FOLDER_NAME_CONFLICT'))
    .mockRejectedValueOnce(new HqTemplatesApiError('x', 500, true, false, 'UNAVAILABLE'))
  await render({ onAddFolder })
  await waitFor(() => expect(buttons().find((el) => el.textContent?.includes('フォルダを追加'))).toBeTruthy())
  await act(async () => (buttons().find((el) => el.textContent?.includes('フォルダを追加')) as HTMLButtonElement).click())
  const input = document.querySelector('[role="dialog"] input') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '季節')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => (buttons().find((el) => el.textContent === '追加する') as HTMLButtonElement).click())
  expect((document.querySelector('[role="dialog"] input') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('同じ名前のフォルダがあります。')
  await act(async () => (buttons().find((el) => el.textContent === '追加する') as HTMLButtonElement).click())
  expect(document.querySelector('[data-folder-dialog-error]')?.textContent).toBe('失敗：フォルダを保存できませんでした。（状態 500・UNAVAILABLE）')
})

it('空の種類タブに、ほかの種類の未配布数や通数を混ぜない', async () => {
  await render({ rows: [], kind: 'rich_video', stats: { outdatedTemplateCount: 1, thisMonthSentCount: 20 } })
  const title = [...host.querySelectorAll('[data-kpi-label]')].find(el => el.textContent?.includes('新しい版を未配布'))
  const card = title?.closest('[data-kpi-presentation]')
  expect(card).toBeTruthy()
  expect(card?.querySelector('[data-kpi-value]')?.textContent).toContain('0')
  expect(host.textContent).toContain('まだテンプレート')
})
it('統括ひな形のフォルダ名を編集中は移動前に確認する', async () => {
  await render()
  await act(async () => { buttons().find(button => button.textContent?.includes('フォルダを追加'))!.click() })
  const input = document.querySelector('[data-folder-name-color] input') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ひな形')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const link = document.createElement('a')
  link.href = '/events'
  link.textContent = 'イベントへ'
  document.body.append(link)
  await act(async () => { link.click() })
  expect(document.body.textContent).toContain('保存していない変更があります')
  link.remove()
})

it('統括ひな形のフォルダ削除窓に対象と環境を出す', async () => {
  await render()
  await act(async () => (host.querySelector('[aria-label="フォルダ「お問い合わせ」の操作"]') as HTMLButtonElement).click())
  await act(async () => ([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === '消す') as HTMLElement).click())
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('統括のフォルダ')
  expect(dialog.textContent).toContain('環境')
})

it('統括ひな形フォルダは閉じた確認から削除しない', async () => {
  const h = await render()
  await act(async () => (host.querySelector('[aria-label="フォルダ「お問い合わせ」の操作"]') as HTMLButtonElement).click())
  await act(async () => ([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === '消す') as HTMLElement).click())
  const previous = heldFolder.confirm!
  await act(async () => ([...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent === 'キャンセル') as HTMLElement).click())
  await act(async () => { await previous() })
  expect(h.onDeleteFolder).not.toHaveBeenCalled()
})
