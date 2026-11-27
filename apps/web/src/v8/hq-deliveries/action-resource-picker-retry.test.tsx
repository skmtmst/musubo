// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqActionResourcePicker from './action-resource-picker'
const fixture = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock('@/lib/api/helpers/hq-resource-search', () => ({ searchHqTemplateResources: fixture.search }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('続きの取得に失敗しても表示済みの候補を残し、続きから読み直せる', async () => {
  fixture.search.mockResolvedValueOnce({success:true,data:{kind:'tag',items:[{id:'a',name:'見本A',accountId:'s',accountName:'見本店'}],nextCursor:'next'}})
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({success:true,data:{kind:'tag',items:[{id:'b',name:'見本B',accountId:'s',accountName:'見本店'}],nextCursor:null}})
  render(<HqActionResourcePicker kind="tag" onConfirm={() => {}} onCancel={() => {}} />)
  await screen.findByText('見本A')
  fireEvent.click(screen.getByRole('button', {name:'さらに表示する'}))
  await screen.findByText('再読込')
  expect(screen.getByText('見本A')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', {name:'再読込'}))
  await screen.findByText('見本B')
  expect(screen.getByText('見本A')).toBeTruthy()
  await waitFor(() => expect(fixture.search).toHaveBeenLastCalledWith(expect.objectContaining({cursor:'next'})))
})
