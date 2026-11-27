// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApplyToTagModal } from '@/components/rich-menus/apply-to-tag-modal'

const requests: unknown[] = []
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/tags') return reply({ success: true, data: [{ id: 'tag-1', name: '常連', color: '#333333' }] })
    if (path === '/api/rich-menu-groups/g-1/apply-to-tag') {
      requests.push(JSON.parse(String(init?.body)))
      return reply({ success: true, data: { chunks: 1, total: 3 } })
    }
    return reply({ success: true, data: null })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('全員のデフォルトは確認窓を経てから実行する', async () => {
  render(<ApplyToTagModal groupId="g-1" groupName="通常メニュー" onClose={() => {}} />)
  fireEvent.click(screen.getByRole('radio', { name: /全員のデフォルトに設定する/ }))
  fireEvent.click(screen.getByRole('button', { name: '実行する' }))
  const dialog = await screen.findByRole('dialog', { name: '「通常メニュー」を全員のデフォルトにしますか？' })
  expect(requests).toEqual([])
  fireEvent.click(within(dialog).getByRole('button', { name: '全員のデフォルトにする' }))
  await waitFor(() => expect(requests).toEqual([{ mode: 'set-default' }]))
})

it('今いる友だちへの適用は確認窓を挟まず実行する', async () => {
  render(<ApplyToTagModal groupId="g-1" groupName="通常メニュー" onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '実行する' }))
  await waitFor(() => expect(requests).toEqual([{ mode: 'bulk-link', tagId: null }]))
  expect(screen.queryByRole('dialog', { name: '「通常メニュー」を全員のデフォルトにしますか？' })).toBeNull()
})

it('タグを選んだ適用も確認窓を挟まず実行する', async () => {
  render(<ApplyToTagModal groupId="g-1" groupName="通常メニュー" onClose={() => {}} />)
  const choice = await screen.findByRole('radio', { name: /タグで絞り込んで適用/ })
  await waitFor(() => expect((choice as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(choice)
  fireEvent.click(screen.getByRole('button', { name: '実行する' }))
  await waitFor(() => expect(requests).toEqual([{ mode: 'bulk-link', tagId: 'tag-1' }]))
  expect(screen.queryByRole('dialog', { name: '「通常メニュー」を全員のデフォルトにしますか？' })).toBeNull()
})
