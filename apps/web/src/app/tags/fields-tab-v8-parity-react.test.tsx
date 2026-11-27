// @vitest-environment happy-dom

import React from 'react'
import { PageExplanationProvider } from '@/components/shared/page-explanation'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

type ApiResult = { success: boolean; data?: unknown }

const fixture = vi.hoisted(() => ({
  fields: [] as unknown[],
  list: null as null | (() => Promise<ApiResult>),
  listCalls: 0,
  remove: null as null | (() => Promise<ApiResult>),
  stats: (): Promise<ApiResult> => Promise.resolve({ success: true, data: null }),
  folders: (): Promise<ApiResult> => Promise.resolve({ success: true, data: [] }),
}))

const fieldItem = (id: string, name: string, isInherited: boolean) => ({
  id,
  accountId: 'account-a',
  name,
  fieldKey: `field_${id}`,
  type: 'text',
  isInherited,
  usageCount: 0,
  formUsageCount: 0,
  displayTargets: [],
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}))

vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffIdentity: () => null }))
vi.mock('@/lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  ApiError: class ApiError extends Error {
    status = 500
  },
  api: {
    friendFields: {
      stats: () => fixture.stats(),
      list: () => { fixture.listCalls += 1; return fixture.list ? fixture.list() : Promise.resolve({ success: true, data: fixture.fields }) },
      reorder: () => Promise.resolve({ success: true }),
      delete: () => fixture.remove ? fixture.remove() : Promise.resolve({ success: true }),
    },
    folders: {
      list: () => fixture.folders(),
      swapOrder: () => Promise.resolve({ success: true }),
      delete: () => Promise.resolve({ success: true }),
    },
  },
}))

afterEach(() => { cleanup(); fixture.list = null; fixture.listCalls = 0; fixture.remove = null })

describe('友だち情報欄V8一覧', () => {
  test('共通項目は並び替えと削除を許さず、独自の項目と区別する', async () => {
    fixture.fields = [fieldItem('f1', '会員番号', true), fieldItem('f2', '好きな色', false)]
    const { default: FieldsTabV8 } = await import('@/v8/tags/fields-tab')
    const rendered = render(<PageExplanationProvider pageKey="tags:fields"><FieldsTabV8 accountId="account-a" canEdit /></PageExplanationProvider>)
    await rendered.findByText('会員番号')
    expect(rendered.getAllByTitle('共通項目は移行後に並び替えできます').length).toBeGreaterThan(0)
    fireEvent.click(rendered.getByRole('button', { name: '項目「会員番号」の操作' }))
    const menu = await rendered.findByRole('menu')
    expect(menu.textContent).not.toContain('削除する')
    fireEvent.keyDown(menu, { key: 'Escape' })
    fireEvent.click(rendered.getByRole('button', { name: '項目「好きな色」の操作' }))
    expect(await rendered.findByRole('menuitem', { name: '削除する' })).toBeTruthy()
  })

  test('表示件数に30件・40件を選べる', async () => {
    fixture.fields = [fieldItem('f1', '会員番号', false)]
    const { default: FieldsTabV8 } = await import('@/v8/tags/fields-tab')
    const rendered = render(<PageExplanationProvider pageKey="tags:fields"><FieldsTabV8 accountId="account-a" canEdit /></PageExplanationProvider>)
    await rendered.findByText('会員番号')
    const box = rendered.container.querySelector('[aria-label="表示件数"]')
    if (!box) throw new Error('page size select is missing')
    fireEvent.click(box)
    const opened = await rendered.findByRole('listbox')
    expect(opened.textContent).toContain('30件表示')
    expect(opened.textContent).toContain('40件表示')
  })

  const draw = async () => {
    const { default: FieldsTabV8 } = await import('@/v8/tags/fields-tab')
    return render(<PageExplanationProvider pageKey="tags:fields"><FieldsTabV8 accountId="account-a" canEdit /></PageExplanationProvider>)
  }
  const menuOf = async (rendered: Awaited<ReturnType<typeof draw>>, name: string) => {
    fireEvent.click(rendered.getByRole('button', { name: `項目「${name}」の操作` }))
    return rendered.findByRole('menu')
  }

  test('値が入っている項目だけ「移行（種類を変える）」でその項目の移行へ進める', async () => {
    fixture.fields = [{ ...fieldItem('f1', '会員番号', false), usageCount: 3 }, fieldItem('f2', '好きな色', false)]
    const rendered = await draw()
    await rendered.findByText('会員番号')
    const used = await menuOf(rendered, '会員番号')
    const link = within(used).getByRole('menuitem', { name: '移行（種類を変更する）' })
    expect(new URL(link.getAttribute('href')!, 'https://fixture.invalid').pathname).toBe('/tags/fields/migrate')
    expect(new URL(link.getAttribute('href')!, 'https://fixture.invalid').searchParams.get('id')).toBe('f1')
    fireEvent.keyDown(used, { key: 'Escape' })
    await waitFor(() => expect(rendered.queryByRole('menu')).toBeNull())
    const unused = await menuOf(rendered, '好きな色')
    expect(within(unused).queryByRole('menuitem', { name: '移行（種類を変更する）' })).toBeNull()
  })

  test.each([
    ['使用人数を読めない項目', undefined, '使用人数を確認できないため削除できません。再読み込みしてください。'],
    ['値が入っている項目', 2, '値が入っているため、先に項目を移行してください'],
  ])('%sは削除を押せず理由を出し、0人と分かっている項目だけ削除できる', async (_label, usageCount, reason) => {
    fixture.fields = [{ ...fieldItem('f1', '会員番号', false), usageCount }, fieldItem('f2', '好きな色', false)]
    const rendered = await draw()
    await rendered.findByText('会員番号')
    const blocked = within(await menuOf(rendered, '会員番号')).getByRole('menuitem', { name: /削除する/ }) as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    expect(blocked.textContent).toContain(reason)
    fireEvent.keyDown(rendered.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(rendered.queryByRole('menu')).toBeNull())
    const free = within(await menuOf(rendered, '好きな色')).getByRole('menuitem', { name: '削除する' }) as HTMLButtonElement
    expect(free.disabled).toBe(false)
  })

  test('読み込みの失敗は空の案内や作る入口と混ぜず、もう一度読める', async () => {
    fixture.list = () => Promise.reject(new Error('down'))
    const rendered = await draw()
    expect(await rendered.findByText('友だち情報欄を読み込めませんでした')).toBeTruthy()
    expect(rendered.queryByText('まだ項目はありません')).toBeNull()
    expect(rendered.getByText('管理者にお問い合わせください。')).toBeTruthy()
    const calls = fixture.listCalls
    fixture.list = () => Promise.resolve({ success: true, data: [] })
    fireEvent.click(rendered.getByRole('button', { name: /もう一度/ }))
    expect(await rendered.findByText('まだ項目はありません')).toBeTruthy()
    expect(fixture.listCalls).toBe(calls + 1)
    expect(rendered.queryByText('友だち情報欄を読み込めませんでした')).toBeNull()
  })

  test('取得できて0件なら空の案内を出し、作る入口は項目の作成へ進む', async () => {
    fixture.fields = []
    const rendered = await draw()
    expect(await rendered.findByText('まだ項目はありません')).toBeTruthy()
    const links = rendered.getAllByRole('link', { name: '項目を作る' })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link.getAttribute('href')).toMatch(/^\/tags\/fields\/new(\?|$)/)
    expect(rendered.getByRole('complementary', { name: 'フォルダ' })).toBeTruthy()
  })

  test('削除の失敗は読み込みの失敗と別に出し、一覧は消さない', async () => {
    fixture.fields = [fieldItem('f2', '好きな色', false)]
    const { ApiError } = await import('@/lib/api')
    fixture.remove = () => Promise.reject(Object.assign(new ApiError('使われているため削除できません'), { status: 409 }))
    const rendered = await draw()
    await rendered.findByText('好きな色')
    fireEvent.click(within(await menuOf(rendered, '好きな色')).getByRole('menuitem', { name: '削除する' }))
    const dialog = await rendered.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    expect(await rendered.findByText('使われているため削除できません')).toBeTruthy()
    expect(rendered.getAllByText('好きな色').length).toBeGreaterThan(0)
    expect(rendered.queryByText('友だち情報欄を読み込めませんでした')).toBeNull()
  })

  test('回答フォームの使用数と出す場所はAPIの値で出し、未集計のフォーム数は「—」', async () => {
    fixture.fields = [
      { ...fieldItem('f1', '会員番号', false), formUsageCount: 3, displayTargets: ['受信箱', '友だち一覧'] },
      { ...fieldItem('f2', '好きな色', false), formUsageCount: undefined },
    ]
    const rendered = await draw()
    await rendered.findByText('会員番号')
    const row = (name: string) => rendered.getAllByRole('row').find((item) => within(item).queryByText(name))!
    expect(within(row('会員番号')).getByText('3つ')).toBeTruthy()
    expect(within(row('会員番号')).getByText('受信箱・友だち一覧')).toBeTruthy()
    expect(within(row('好きな色')).getByTitle('回答フォームの使用数は未集計').textContent).toBe('—')
  })
})
