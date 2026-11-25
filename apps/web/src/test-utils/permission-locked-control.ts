import { act } from 'react'
import { expect, vi } from 'vitest'
import { api } from '@/lib/api'

const writes = () => Object.values(api).flatMap(feature => Object.entries(feature ?? {}).flatMap(([name, method]) =>
  /^(create|update|delete|remove|move|swap|save|set|start|stop|retry|archive|restore|duplicate|clone)/i.test(name) && vi.isMockFunction(method)
    ? [{ method, count: method.mock.calls.length }] : []))
const fetchWrites = () => {
  const fetchMock = vi.mocked(globalThis.fetch)
  if (!vi.isMockFunction(fetchMock)) return null
  return fetchMock.mock.calls.filter(([input, init]) =>
    !['GET', 'HEAD'].includes(String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase())).length
}

/** 灰色の操作を焦点・クリック・Enterで試し、説明と書込拒否を確認する。 */
export async function expectPermissionLocked(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  const control = element as HTMLElement
  expect(control.getAttribute('aria-disabled')).toBe('true')
  expect(control.hasAttribute('data-permission-locked')).toBe(true)
  const reason = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
  expect(reason).toMatch(/権限|閲覧|オーナー|管理者/)
  const before = writes(), requests = fetchWrites()
  await act(async () => {
    control.focus()
    control.click()
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
  })
  for (const { method, count } of before) expect(method.mock.calls.length).toBe(count)
  expect(fetchWrites()).toBe(requests)
}

/** フォルダのメニューは開けるが、変更項目は理由付きで拒否する。 */
export async function expectLockedFolderMenu(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => { (element as HTMLElement).click() })
  const items = [...document.querySelectorAll('[role="menuitem"]')].filter(item => /名前を変更する|色を変更する|並べ替える|消す/.test(item.textContent ?? ''))
  expect(items.some(item => item.textContent?.includes('名前を変更する'))).toBe(true)
  expect(items.some(item => item.textContent?.includes('色を変更する'))).toBe(true)
  for (const item of items) await expectPermissionLocked(item)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
}
