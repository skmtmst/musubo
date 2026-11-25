import linePreviewStyles from '@/components/shared/line-preview.module.css'
import { waitFor } from '@testing-library/react'
// @vitest-environment happy-dom
/*
 * 一斉配信の作成フォームにあるテンプレート選択を、本物の React で確かめる
 * （IDEA-11）。
 *
 * 見る筋書き:
 *   1. 先頭3件だけではなく、読み込んだ候補が全部出る。
 *   2. 名前・本文の検索と置き場（フォルダ）で目的別に絞れる。
 *      未分類だけを選ぶ口もある。
 *   3. 選んだテンプレートは、挿入前に右側へ全文（改行つき）が出る。
 *   4. フォルダの選択欄は、テンプレートの置き場（kind='template'）から
 *      本物の選択肢を読む。固定の「すべて」だけではない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const TEMPLATE_FOLDERS = [
  { id: 'folder-visit', name: '来店案内', kind: 'template', parentId: null, displayOrder: 0, color: null, accountId: 'acc-1', createdAt: '', updatedAt: '' },
]

const TEMPLATES = [
  { id: 'tpl-1', name: '初回来店のお礼', category: 'general', messageType: 'text', messageContent: 'ご来店ありがとうございました。\n次回のご予約はこちらです。', folderId: 'folder-visit' },
  { id: 'tpl-2', name: '発送のお知らせ', category: 'general', messageType: 'text', messageContent: '商品を発送しました。', folderId: null },
  { id: 'tpl-3', name: '再入荷のお知らせ', category: 'general', messageType: 'text', messageContent: 'お待たせしていた商品が再入荷しました。', folderId: 'folder-visit' },
  { id: 'tpl-4', name: 'キャンペーン終了間際', category: 'general', messageType: 'text', messageContent: 'キャンペーンは明日までです。', folderId: null },
].map((template) => ({
  ...template,
  accountId: 'acc-1',
  publishedAt: '2026-09-01T00:00:00.000Z',
  publishedVersion: 1,
  question: null,
  questionStatus: 'published',
  usageCount: 0,
  tapCount: 0,
  monthlySendCount: null,
  totalSendCount: null,
  hasDraft: false,
  draftRevision: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const emptyList = async () => ({ success: true, data: [] })
  return {
    ...actual,
    api: {
      ...actual.api,
      broadcasts: {
        ...actual.api.broadcasts,
        get: vi.fn(),
        list: async () => ({ success: true, data: [] }),
        preflight: async () => ({ success: true, data: { audienceCount: 10 } }),
        previewCount: async () => ({ success: true, data: { count: 10 } }),
      },
      // 置き場は種別で返し分ける。テンプレートの置き場だけ本物の選択肢を返す。
      folders: {
        list: vi.fn(async (kind?: string) =>
          kind === 'template'
            ? { success: true, data: TEMPLATE_FOLDERS }
            : { success: true, data: [] }),
      },
      scenarios: { list: emptyList },
      commonVars: { list: emptyList },
      friendFields: { list: emptyList },
      broadcastMessageAssets: { list: emptyList, upload: emptyList },
      templates: {
        list: async () => ({ success: true, data: TEMPLATES }),
        // PERF-12: 選択画面は区画取得を使う。同じ中身を区画の形で返す。
        listPage: async () => ({ success: true, data: { items: TEMPLATES, total: TEMPLATES.length, limit: 100 } }),
      },
      commonActions: { resources: async () => ({ success: true, data: [] }) },
      accountSettings: { getTestRecipients: async () => ({ success: true, data: [] }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/broadcasts/new',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))

/*
 * フォルダの欄は共通 Select（listbox）。ここで見たいのは選んだ後の
 * テンプレートの判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

import BroadcastForm from './broadcast-form'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderPicker() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <BroadcastForm tags={[]} onSuccess={() => {}} onCancel={() => {}} openTemplatePickerInitially />,
    )
  })
  await flush()
}

function templateRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"] input[type="radio"]')]
}

function templateRowNames(): string[] {
  return templateRows().map((row) => row.getAttribute('aria-label') ?? '')
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

async function chooseFolder(value: string) {
  const label = value === 'folder-visit' ? '来店案内' : value === '__none__' ? '未分類' : 'すべて'
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent?.startsWith(label))!
  await act(async () => { button.click() })
  await flush()
}

async function typeSearch(value: string) {
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="search"]')
  expect(input, '検索欄がない').not.toBeNull()
  await act(async () => {
    setNativeValue(input!, value)
  })
  await flush()
}

async function clickRow(name: string) {
  const row = templateRows().find((el) => el.getAttribute('aria-label') === name)
  expect(row, `${name} の行がない`).toBeDefined()
  await act(async () => {
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

afterEach(() => {
  if (root) act(() => { root.unmount() })
  container?.remove()
})

describe('一斉配信のテンプレート選択（IDEA-11）', () => {
  it('動画付きImagemapをリッチビデオとして候補に出し、配信へ挿入できる', async () => {
    const video={originalContentUrl:'https://worker.example/images/video.mp4',previewImageUrl:'https://worker.example/images/preview.jpg',area:{x:0,y:0,width:1040,height:520},externalLink:{linkUri:'https://example.com',label:'詳しく見る'}}
    TEMPLATES.push({...TEMPLATES[0],id:'tpl-video',name:'お店紹介の動画',messageType:'imagemap',messageContent:JSON.stringify({baseUrl:'https://worker.example/images/imagemaps/v',baseSize:{width:1040,height:520},actions:[],altText:'お店の動画',video})})
    try {
      await renderPicker()
      expect(templateRows().find(row=>row.getAttribute('aria-label') === 'お店紹介の動画')?.closest('label')?.textContent).toContain('リッチビデオ')
      await clickRow('お店紹介の動画')
      const insert=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent === '選択する')
      expect(insert).toBeDefined()
      await act(async()=>insert!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
      await flush()
      expect(container.textContent).toContain('リッチビデオ')
      expect(container.textContent).not.toContain('リッチビデオには未対応')
      expect(container.querySelector('.broadcast-template-row')).toBeNull()
    } finally { TEMPLATES.pop() }
  })

  it('先頭3件ではなく、読み込んだ候補をすべて出す', async () => {
    await renderPicker()

    expect(templateRowNames()).toEqual([
      '初回来店のお礼',
      '発送のお知らせ',
      '再入荷のお知らせ',
      'キャンペーン終了間際',
    ])
  })

  it('フォルダの選択肢はテンプレートの置き場から読む', async () => {
    await renderPicker()

    const labels = [...document.querySelectorAll('[role="dialog"] button')].map((button) => button.textContent?.replace(/\d+$/, ''))
    expect(labels).toContain('すべて')
    expect(labels).toContain('来店案内')
    expect(labels).toContain('未分類')
  })

  it('名前・本文の検索で絞れる', async () => {
    await renderPicker()
    await typeSearch('再入荷')

    await waitFor(() => expect(templateRowNames()).toEqual(['再入荷のお知らせ']))
  })

  it('フォルダと未分類で絞れる', async () => {
    await renderPicker()

    await chooseFolder('folder-visit')
    expect(templateRowNames()).toEqual(['初回来店のお礼', '再入荷のお知らせ'])

    await chooseFolder('__none__')
    expect(templateRowNames()).toEqual(['発送のお知らせ', 'キャンペーン終了間際'])
  })

  it('条件に合う候補が無いときは0件と分かる', async () => {
    await renderPicker()
    await typeSearch('存在しない文字列')

    await waitFor(() => expect(templateRows()).toHaveLength(0))
    expect(document.body.textContent).toContain('当てはまる候補がありません。')
  })

  it('選ぶと挿入前に改行つきの全文がプレビューへ出る', async () => {
    await renderPicker()
    await clickRow('初回来店のお礼')

    const preview = document.querySelector<HTMLElement>('[aria-label="選んだ候補の見え方"]')
    expect(preview, 'プレビューの領域がない').toBeDefined()
    // whitespace-pre-wrap の吹き出しで出るので、改行もそのまま確かめられる。
    const bubble = preview!.querySelector('.' + linePreviewStyles.bubbleText)
    expect(bubble, '改行つきの全文プレビューがない').not.toBeNull()
    expect(bubble!.textContent).toBe('ご来店ありがとうございました。\n次回のご予約はこちらです。')
  })
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
