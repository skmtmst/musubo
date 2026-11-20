// @vitest-environment happy-dom
import ListToolbar from '@/components/shared/list-toolbar'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { ListPage, ListPageBody } from '.'
import { FolderDotName } from '@/components/shared/folder-dot'

afterEach(cleanup)

const rows = [
  { id: '', label: 'すべて' },
  { id: 'f1', label: '春の案内' },
]
const collapsedRegion = (container: HTMLElement) => container.querySelector('[data-template-region="collapsed-folders"]')
const toolbarRegion = (container: HTMLElement) => container.querySelector('[data-template-region="toolbar"]')

describe('一覧の型：板が狭いときに畳む左の列（folderNav）', () => {
  it('folderNav を渡すと、作るボタンと「フォルダ：今のフォルダ」の選ぶ欄を畳んだ段に出し、選ぶと渡した処理を呼ぶ', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ListPage title="一覧" folders={<nav>列</nav>} folderNav={{ rows, activeId: '', onSelect, createAction: <a href="/new">＋ 作る</a> }}>本文</ListPage>,
    )
    const collapsed = collapsedRegion(container)!
    expect(collapsed).toBeTruthy()
    expect(collapsed.querySelector('a[href="/new"]')?.textContent).toBe('＋ 作る')
    const trigger = screen.getByRole('button', { name: 'フォルダ' })
    expect(collapsed.contains(trigger)).toBe(true)
    expect(trigger.textContent).toContain('フォルダ：すべて')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '春の案内' }))
    expect(onSelect).toHaveBeenCalledWith('f1')
  })

  it('閲覧のみでも畳んだ段に作る操作を表示する', () => {
    const { container } = render(<ListPage readOnly title="一覧" folders={<nav>列</nav>} folderNav={{ rows, activeId: '', onSelect: () => {}, createAction: <button aria-disabled="true">作る</button> }}>本文</ListPage>)
    const button = collapsedRegion(container)!.querySelector('button[aria-disabled="true"]')
    expect(button?.textContent).toBe('作る')
  })

  it('選んだフォルダの削除なども畳んだ欄から実行できる', () => {
    const onDelete = vi.fn()
    const folders = [rows[0], { ...rows[1], onDelete }]
    render(<ListPage title="一覧" folders={<nav>列</nav>} folderNav={{ rows: folders, activeId: 'f1', onSelect: () => {} }}>本文</ListPage>)
    fireEvent.click(screen.getByRole('button', { name: 'フォルダ「春の案内」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '消す' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('呼び名を渡すとその名で出す（統括のアカウントは「タグ：すべて」）。作るボタンを渡さないときは作るを出さない', () => {
    const { container } = render(
      <ListPage title="一覧" folders={<nav>列</nav>} folderNav={{ rows, activeId: 'f1', onSelect: () => {}, label: 'タグ' }}>本文</ListPage>,
    )
    expect(screen.getByRole('button', { name: 'タグ' }).textContent).toContain('タグ：春の案内')
    expect(collapsedRegion(container)!.querySelectorAll('a').length).toBe(0)
  })

  it('選ぶものが2つある画面は配列で渡し、2つとも出す', () => {
    render(
      <ListPage
        title="一覧"
        folders={<nav>列</nav>}
        folderNav={[
          { rows, activeId: '', onSelect: () => {}, label: '種類' },
          { rows, activeId: 'f1', onSelect: () => {}, label: '分類' },
        ]}
      >本文</ListPage>,
    )
    expect(screen.getByRole('button', { name: '種類' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '分類' })).toBeTruthy()
  })

  it('画面が collapsedFolders を渡したときはそれを優先し、型は組まない', () => {
    render(
      <ListPageBody folders={<nav>列</nav>} collapsedFolders={<span>画面の畳んだ段</span>} folderNav={{ rows, activeId: '', onSelect: () => {} }}>本文</ListPageBody>,
    )
    expect(screen.getByText('画面の畳んだ段')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'フォルダ' })).toBeNull()
  })

  it("画面が狭い幅で左の列を外しても、渡されたフォルダの操作を失わない", () => {
    const { container } = render(<ListPageBody folderNav={{ rows, activeId: '', onSelect: () => {} }}>本文</ListPageBody>)
    expect(collapsedRegion(container)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'フォルダ' })).toBeTruthy()
  })

  it('道具を渡さない画面では、畳んだ段だけの道具の段に印を付ける（広い板では CSS が隠す）', () => {
    const { container, rerender } = render(<ListPageBody folders={<nav>列</nav>} folderNav={{ rows, activeId: '', onSelect: () => {} }}>本文</ListPageBody>)
    expect(toolbarRegion(container)!.hasAttribute('data-collapsed-only')).toBe(true)
    rerender(<ListPageBody folders={<nav>列</nav>} folderNav={{ rows, activeId: '', onSelect: () => {} }} toolbar={<span>探す</span>}>本文</ListPageBody>)
    expect(toolbarRegion(container)!.hasAttribute('data-collapsed-only')).toBe(false)
  })
})

describe('一覧の型の CSS：畳んだ段は板が 1100 未満のときだけ', () => {
  const css = readFileSync(resolve(import.meta.dirname, 'page-templates.module.css'), 'utf8')
  const narrowBlock = css.slice(css.indexOf('@container v8-page (max-width: 1099px)'))
  it('広い板では畳んだ段も、畳んだ段だけの道具の段も隠す', () => {
    expect(css).toMatch(/\.collapsedFolders \{ display: none; \}/)
    expect(css).toMatch(/\.toolbar\[data-collapsed-only\] \{ display: none; \}/)
  })
  it('狭い板では左の列を隠し、畳んだ段と道具の段を出す', () => {
    expect(narrowBlock).toMatch(/\.folders \{ display: none; \}/)
    expect(narrowBlock).toMatch(/\.collapsedFolders \{ display: flex;/)
    expect(narrowBlock).toMatch(/\.toolbar\[data-collapsed-only\] \{ display: flex; \}/)
  })
  it('選ぶ欄は選択中の名前の実寸を確保する', () => {
    expect(css).toMatch(/\.collapsedSelect \{[^}]*width: max-content/)
  })
})

describe('左の列を持つ一覧は、畳んだときの行き先も持つ', () => {
  const SRC = resolve(import.meta.dirname, '../..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue }
      if (full.endsWith('.tsx') && !/\.test\.tsx$/.test(full)) files.push(full)
    }
  }
  walk(join(SRC, 'v8'))
  walk(join(SRC, 'app'))
  const folderLists = (source: string) => {
    const ast = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const lists: Array<{ component: string; fallback: boolean }> = []
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const component = node.tagName.getText(ast)
        if (['ListPage', 'ListPageBody', 'AffiliateFrame', 'MileageFrame'].includes(component)) {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
          if (attrs.some((attr) => attr.name.getText(ast) === 'folders')) {
            const fallback = attrs.some((attr) => ['collapsedFolders', 'folderNav'].includes(attr.name.getText(ast)) && attr.initializer?.getText(ast) !== '{undefined}')
            lists.push({ component, fallback })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    return lists
  }
  const listFiles = files.filter((file) => {
    const source = readFileSync(file, 'utf8')
    return folderLists(source).length > 0
  })
  it('情報欄編集の folders を一覧の左列と混同せず、本物の左列は見張る', () => {
    expect(folderLists('<ListPage><FieldEditor folders={rows} /></ListPage>')).toEqual([])
    expect(folderLists('<ListPageBody folders={rows} />')).toEqual([{ component: 'ListPageBody', fallback: false }])
  })
  it('一覧の型を使う画面を拾えている（見張りが空振りしない）', () => {
    expect(listFiles.length).toBeGreaterThan(20)
  })
  it.each(listFiles.map((file) => [relative(SRC, file), file]))('%s は collapsedFolders か folderNav を渡す', (_name, file) => {
    const source = readFileSync(file, 'utf8')
    expect(folderLists(source).every((list) => list.fallback)).toBe(true)
  })
})


it('X1: a one-choice rail places creation before other heading actions', () => {
  const { container } = render(<ListPage title="決めごと" folders={<nav>すべて</nav>}
    folderNav={{rows:[{id:'all',label:'すべて'}],activeId:'all',onSelect:()=>{},createAction:<a href="/new">作る</a>}}
    actions={<button>CSVで書き出す</button>}
    toolbar={<ListToolbar search={{placeholder:'名前で探す',value:'',onChange:()=>{}}} />}>本文</ListPage>)
  expect(container.querySelector('[data-template-region="folders"]')).toBeNull()
  expect(screen.queryByRole('button',{name:'フォルダ'})).toBeNull()
  const heading=container.querySelector('[data-template-region="heading"]')!
  const create=screen.getByRole('link',{name:'作る'})
  expect(heading.contains(create)).toBe(true)
  expect(create.getAttribute('href')).toBe('/new')
  expect(create.compareDocumentPosition(screen.getByRole('button',{name:'CSVで書き出す'})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(container.querySelector('[data-template-region="toolbar"]')?.contains(create)).toBe(false)
})

it('X2: folderless names retain selection and links; an unfiled name in a folder list has a grey dot', () => {
  const select=vi.fn()
  const body=<FolderDotName><a href="/detail">決めごと</a></FolderDotName>
  const {container,rerender}=render(<ListPage title="一覧" folderNav={{rows:[rows[0]],activeId:'',onSelect:select}}>{body}</ListPage>)
  expect(container.querySelector('[data-folder-dot]')).toBeNull()
  expect(screen.getByRole('link',{name:'決めごと'}).getAttribute('href')).toBe('/detail')
  rerender(<ListPage title="一覧" folderNav={{rows,activeId:'',onSelect:select}}>{body}</ListPage>)
  expect(container.querySelector('[data-folder-dot]')?.getAttribute('data-folder-dot')).toBe('unfiled')
  fireEvent.click(screen.getByRole('button',{name:'フォルダ'}))
  fireEvent.click(screen.getByRole('button',{name:'春の案内'}))
  expect(select).toHaveBeenCalledWith('f1')
})


it('W2: a readonly no-choice list leaves no empty leading slot', () => {
  const { container } = render(<ListPage title="決めごと" readOnly folders={<nav>すべて</nav>}
    folderNav={{rows:[{id:'all',label:'すべて'}],activeId:'all',onSelect:()=>{}}}
    toolbar={<ListToolbar search={{placeholder:'名前で探す',value:'',onChange:()=>{}}} />}>本文</ListPage>)
  expect(container.querySelector('[data-template-region="folders"]')).toBeNull()
  expect(container.querySelector('[data-toolbar-leading]')).toBeNull()
})
