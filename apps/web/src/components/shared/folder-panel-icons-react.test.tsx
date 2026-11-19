// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import styles from './folder-panel.module.css'
import FolderPanel, { CollapsedFolderActions, type FolderPanelRow } from './folder-panel'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
})

async function render(row: FolderPanelRow, activeId = '', onSelect = vi.fn()) {
  await act(async () => {
    root.render(<FolderPanel rows={[row]} activeId={activeId} onSelect={onSelect} />)
  })
  const button = host.querySelector('nav button') as HTMLButtonElement
  const icon = button.querySelector('.' + styles.folderIcon + ' svg') as SVGElement
  if ((row.kind ?? (row.label === 'すべて' ? 'all' : row.label === '未分類' ? 'unfiled' : 'folder')) === 'folder') return { button, icon, onSelect }
  expect(icon).not.toBeNull()
  return { button, icon, onSelect }
}

const callerIcon = <svg data-caller-icon fill="red"><circle cx="7" cy="7" r="7" /></svg>

describe('V8 フォルダの列の共通の印（faSbC）', () => {
  it.each(['', 'all'])('all は画面の色・印を無視し、選択中でも墨色のトレー（active=%s）', async (activeId) => {
    const { button, icon, onSelect } = await render({
      id: 'all', kind: 'all', label: '全部を見る', count: 12, color: 'red', icon: callerIcon,
    }, activeId)
    expect(icon.classList.contains('lucide-inbox')).toBe(true)
    expect(icon.getAttribute('fill')).toBe('none')
    expect(icon.style.color).toBe('var(--color-ink)')
    expect(button.querySelector('.' + styles.folderIcon + ' [data-caller-icon]')).toBeNull()
    expect(button.textContent).toBe('全部を見る12')
    await act(async () => button.click())
    expect(onSelect).toHaveBeenCalledWith('all')
  })

  it.each(['', 'unfiled'])('unfiled は画面の色・印を無視し、選択中でも灰色の開いたフォルダ（active=%s）', async (activeId) => {
    const { button, icon } = await render({
      id: 'unfiled', kind: 'unfiled', label: '分類なし', count: 0, color: 'red', icon: callerIcon,
    }, activeId)
    expect(icon.classList.contains('lucide-folder-open')).toBe(true)
    expect(icon.getAttribute('fill')).toBe('none')
    expect(icon.style.color).toBe('var(--color-ink-secondary)')
    expect(button.querySelector('.' + styles.folderIcon + ' [data-caller-icon]')).toBeNull()
  })

  it.each([
    ['すべて', 'lucide-inbox', 'var(--color-ink)'],
    ['未分類', 'lucide-folder-open', 'var(--color-ink-secondary)'],
  ])('古い呼び方でも %s は共通の印になる', async (label, className, color) => {
    const { icon } = await render({ id: 'legacy', label, count: null, color: 'red', icon: callerIcon })
    expect(icon.classList.contains(className)).toBe(true)
    expect(icon.getAttribute('fill')).toBe('none')
    expect(icon.style.color).toBe(color)
  })

  it.each(['キャンペーン', 'すべて', '未分類'])('作ったフォルダ「%s」は名前に関係なく、そのフォルダの色のフォルダを出す', async (label) => {
    const { button } = await render({ id: 'folder', kind: 'folder', label, count: 3, color: 'rebeccapurple', icon: callerIcon })
    const folder = button.querySelector('.' + styles.folderIcon + ' svg') as SVGElement
    expect(folder.classList.contains('lucide-folder')).toBe(true)
    expect(folder.style.color).toBe('rebeccapurple')
    expect(button.querySelector('[data-folder-dot]')).toBeNull()
    expect(folder.getAttribute('fill')).toBe('currentColor')
    expect(button.querySelector('.' + styles.folderIcon + ' [data-caller-icon]')).toBeNull()
  })

  it('すべての印を旧テーマ専用の要素で描かない', async () => {
    const { button, icon } = await render({ id: 'all', kind: 'all', label: 'すべて', count: 1, color: 'red' })
    expect(icon.classList.contains('lucide-inbox')).toBe(true)
    expect(icon.style.color).toBe('var(--color-ink)')
    expect(button.querySelector('.v7-only')).toBeNull()
  })
})

describe('フォルダの行ごとに追加する操作', () => {
  it('追加操作だけの行にもメニューを出し、先頭に置いて今の操作と区切る', async () => {
    const distribute = vi.fn()
    await render({ id: 'test', label: 'テスト', count: 1, leadingActions: [{ id: 'send', label: 'このフォルダを配る', emphasis: true, onSelect: distribute }], onEdit: vi.fn() })
    await act(async () => (host.querySelector('[aria-label="フォルダ「テスト」の操作"]') as HTMLButtonElement).click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)))
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(items[0].textContent).toBe('このフォルダを配る')
    expect(items[0].querySelector('strong')).not.toBeNull()
    expect(items[1].parentElement?.querySelector('hr')).toBeNull() // ：同じ整理の組の中は区切らない。
    await act(async () => (items[0] as HTMLButtonElement).click())
    expect(distribute).toHaveBeenCalledTimes(1)
  })
  it('畳んだフォルダにも同じ追加操作のメニューを出す', async () => {
    const send = vi.fn()
    await act(async () => root.render(<CollapsedFolderActions row={{ id: 'none', label: '未分類', count: 1,
      leadingActions: [{ id: 'send', label: 'このフォルダを配る', onSelect: send }] }} />))
    await act(async () => (host.querySelector('[aria-label="フォルダ「未分類」の操作"]') as HTMLButtonElement).click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)))
    await act(async () => (document.querySelector('[role="menuitem"]') as HTMLButtonElement).click())
    expect(send).toHaveBeenCalledTimes(1)
  })

})


describe('作る操作と閲覧時の場所取り', () => {
  it('作る操作を一度だけ出し、閲覧時は同じ位置に空きを一つ残す', async () => {
    const rows: FolderPanelRow[] = [{ id: 'all', kind: 'all', label: 'すべて' }]
    await act(async () => root.render(<FolderPanel rows={rows} activeId="all" onSelect={() => {}} createAction={<button>作る</button>} />))
    expect([...host.querySelectorAll('button')].filter(button => button.textContent === '作る')).toHaveLength(1)
    expect(host.querySelectorAll('aside > div[aria-hidden="true"]')).toHaveLength(0)
    await act(async () => root.render(<FolderPanel rows={rows} activeId="all" onSelect={() => {}} createAction={null} />))
    expect(host.textContent).not.toContain('作る')
    expect(host.querySelectorAll('aside > div[aria-hidden="true"]')).toHaveLength(1)
    await act(async () => root.render(<FolderPanel readOnly rows={rows} activeId="all" onSelect={() => {}} />))
    expect(host.querySelectorAll('aside > div[aria-hidden="true"]')).toHaveLength(1)
  })

  it('閲覧のみでも渡された作る操作を表示する', async () => {
    const rows: FolderPanelRow[] = [{ id: 'all', kind: 'all', label: 'すべて' }]
    await act(async () => root.render(<FolderPanel readOnly rows={rows} activeId="all" onSelect={() => {}} createAction={<button aria-disabled="true">作る</button>} />))
    expect(host.querySelector('button[aria-disabled="true"]')?.textContent).toBe('作る')
    expect(host.querySelectorAll('aside > div[aria-hidden="true"]')).toHaveLength(0)
  })

  it('作る操作を持たない分類列には空きを足さず、選ぶ窓は明示して空きを省ける', async () => {
    const rows: FolderPanelRow[] = [{ id: 'all', kind: 'all', label: 'すべて' }]
    await act(async () => root.render(<FolderPanel rows={rows} activeId="all" onSelect={() => {}} />))
    expect(host.querySelectorAll('aside > div[aria-hidden="true"]')).toHaveLength(0)
    await act(async () => root.render(<FolderPanel readOnly reserveCreateSpace={false} rows={rows} activeId="all" onSelect={() => {}} />))
    expect(host.querySelectorAll('aside > div[aria-hidden="true"]')).toHaveLength(0)
  })
})

describe('選ぶだけのフォルダ列', () => {
  it('操作を渡されても追加・編集・並べ替えを出さず、選択だけはできる', async () => {
    const onSelect = vi.fn(), mutate = vi.fn()
    await act(async () => root.render(<FolderPanel readOnly rows={[{
      id: 'f1', kind: 'folder', label: '季節', count: 3, color: 'blue',
      onEdit: mutate, onMoveUp: mutate, onMoveDown: mutate, onDelete: mutate,
      leadingActions: [{ id: 'send', label: '配る', onSelect: mutate }],
      trailing: <button onClick={mutate}>まとめて選ぶ</button>,
    }]} activeId="f1" onSelect={onSelect} onAddFolder={mutate}
      reserveCreateSpace>
      <button onClick={mutate}>追加操作</button>
    </FolderPanel>))
    expect(host.querySelector('[aria-hidden="true"].' + styles.createPlaceholder)).not.toBeNull()
    const buttons = host.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    await act(async () => buttons[0].click())
    expect(onSelect).toHaveBeenCalledWith('f1')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('処理中は選択も止め、未取得件数を0にしない', async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(<FolderPanel readOnly disabled rows={[
      { id: 'all', kind: 'all', label: 'すべて', count: null },
    ]} activeId="all" onSelect={onSelect} />))
    const button = host.querySelector('nav button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('すべて')
    await act(async () => button.click())
    expect(onSelect).not.toHaveBeenCalled()
  })
})
