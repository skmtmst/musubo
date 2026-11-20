// @vitest-environment happy-dom

import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))

let PoolsPage: typeof import('./new/page').default

beforeAll(async () => {
  process.env.NEXT_PUBLIC_API_URL = 'https://worker.example.com'
  ;({ default: PoolsPage } = await import('./new/page'))
})

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => (
    new Response(JSON.stringify({ success: true, data: [{ id: 'a1', name: '本店', isActive: true }, { id: 'a2', name: '支店', isActive: true }] }), { status: 200 })
  )))
}

async function openCreateModal() {
  stubFetch()
  const view = render(<PoolsPage />)
  await waitFor(() => expect(view.getByLabelText('プール名')).toBeTruthy())
  return view
}

describe('新規プール窓のラベルの結び付き (R617)', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('URL名の入力欄は見える項目名ラベルと結び付いている', async () => {
    const view = await openCreateModal()
    const input = view.getByLabelText('URLに使う名前（あとから変えられません）') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    // 実ブラウザの input.labels と同じ向き：結び付いたlabelが1つある。
    expect(input.labels?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(input.id).toBe('pl-slug')
    expect(view.container.querySelector('label[for="pl-slug"]')?.textContent).toBe('URLに使う名前（あとから変えられません）')
  })

  it('URL名の説明はlabelの外にあり、入力欄の名前を汚さない', async () => {
    const view = await openCreateModal()
    const label = view.container.querySelector('label[for="pl-slug"]')
    expect(label, 'slugのlabelがない').toBeTruthy()
    // 実ブラウザではlabelの中の最初のラベル可能要素（button）へ結び付く
    // ため、labelの中にbuttonがあると入力欄の結び付きが外れる。
    expect(label?.querySelector('button'), 'HelpTipがlabelの中にある').toBeNull()
    const tip = view.getByRole('button', { name: 'URLに使う名前（あとから変えられません）の説明' })
    expect(tip).toBeTruthy()
    expect(label?.contains(tip)).toBe(false)
  })

  it('プール名の入力欄は見える項目名ラベルと結び付いている', async () => {
    const view = await openCreateModal()
    const input = view.getByLabelText('プール名') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    expect(input.labels?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(input.id).toBe('pl-name')
  })

  it('入力後も見えるラベルと受け入れ先を保つ', async () => {
    const view = await openCreateModal()
    fireEvent.change(view.getByLabelText('プール名'), { target: { value: '渋谷' } })
    fireEvent.change(view.getByLabelText('URLに使う名前（あとから変えられません）'), { target: { value: 'shibuya' } })
    expect(view.getByLabelText('プール名')).toBeTruthy()
    expect(view.getByLabelText('URLに使う名前（あとから変えられません）')).toBeTruthy()
    expect(view.getByText('2. いまの受け入れ先')).toBeTruthy()
  })

  it('受け入れ先を追加する選択口は名前と節の見出しを持つ', async () => {
    const view = await openCreateModal()
    await waitFor(() => expect((view.getByRole('button', { name: '＋ アカウントを足す' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(view.getByRole('button', { name: '＋ アカウントを足す' }))
    expect(view.getByLabelText('足すアカウント')).toBeTruthy()
    const heading = view.getByText('2. いまの受け入れ先')
    expect(heading.id).toBe('pool-create-where')
    expect(view.container.querySelector('[aria-labelledby="pool-create-where"]')).toBeTruthy()
  })

  it('URLの意味と変更できない理由を示し、入力後は発行予定のURLに変える', async () => {
    const view = await openCreateModal()
    fireEvent.click(view.getByRole('button', { name: 'URLに使う名前（あとから変えられません）の説明' }))
    expect(view.getByText(/配ったURLが使えなくなるため/)).toBeTruthy()
    fireEvent.change(view.getByLabelText('URLに使う名前（あとから変えられません）'), { target: { value: 'shibuya' } })
    expect(view.getByText(/保存すると、このURLが発行されます：/).textContent).toContain('/pool/shibuya')
  })

  it('プレビューは未発行の説明と入力したURL・受け入れ先を出す', async () => {
    const view = await openCreateModal()
    expect(view.getByText(/まだURLは発行されていません/)).toBeTruthy()
    await waitFor(() => expect(view.getAllByText(/本店/).length).toBeGreaterThan(0))
    fireEvent.change(view.getByLabelText('URLに使う名前（あとから変えられません）'), { target: { value: 'Shibuya!' } })
    const invalidUrl = view.getByText('友だち追加URL').nextElementSibling?.textContent ?? ''
    expect(invalidUrl).toContain('まだURLは発行されていません')
    expect(invalidUrl).not.toContain('/pool/')
    fireEvent.click(view.getByRole('button', { name: 'URLに使う名前（あとから変えられません）の説明' }))
    expect(view.getByText(/配ったURLが使えなくなるため/)).toBeTruthy()
    expect(view.queryByText(/保存すると、このURLが発行されます：/)).toBeNull()
    fireEvent.change(view.getByLabelText('URLに使う名前（あとから変えられません）'), { target: { value: 'sample-store' } })
    const dd = view.getByText('友だち追加URL').nextElementSibling
    expect(dd?.textContent).toContain('/pool/sample-store')
    expect(view.getByText('現在の受け入れ先').nextElementSibling?.textContent).toContain('本店')
    fireEvent.click(view.getByRole('button', { name: '＋ アカウントを足す' }))
    await pickEntity('足すアカウント', '支店')
    fireEvent.click(view.getByRole('button', { name: '追加', exact: true }))
    expect(view.getByText('現在の受け入れ先').nextElementSibling?.textContent).toContain('本店・支店')
  })

  it('入力例のplaceholderは残す', async () => {
    const view = await openCreateModal()
    expect(view.getByPlaceholderText('shibuya')).toBeTruthy()
    expect(view.getByPlaceholderText('例：渋谷エリア')).toBeTruthy()
  })
})

vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
