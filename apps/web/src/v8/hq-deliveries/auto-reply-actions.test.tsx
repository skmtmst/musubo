// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HqDeliveryTemplateDefinition } from '@line-crm/shared'
import HqAutoReplyActions from './auto-reply-actions'
import { replaceHqAutoReplyActions } from './auto-reply-actions-model'
import { searchHqTemplateResources } from '@/lib/api/helpers/hq-resource-search'
vi.mock('@/lib/api/helpers/hq-resource-search', () => ({ searchHqTemplateResources: vi.fn() }))
const search = vi.mocked(searchHqTemplateResources)
afterEach(cleanup)
const response = (kind: 'tag' | 'scenario' = 'tag', id = 'tag-a', cursor: string | null = null) => ({ success: true as const, data: { kind, items: [{ id, name: '会員', accountId: id, accountName: '本店' }], total: 2, nextCursor: cursor } })
beforeEach(() => { search.mockReset(); search.mockResolvedValue(response()) })
function mount(canEdit = true, initial: unknown[] = []) {
 const changed = vi.fn()
 function Harness() {
  const [definition, setDefinition] = useState<HqDeliveryTemplateDefinition>({ schemaVersion: 1, settings: { name: '返事', actions: initial }, references: [] })
  return <HqAutoReplyActions value={definition.settings.actions} references={definition.references} canEdit={canEdit} busy={false} onChange={(actions, resources) => { const next = replaceHqAutoReplyActions(definition, actions, resources); changed(next); setDefinition(next) }} />
 }
 render(<Harness />); return changed
}
async function open(label = 'タグを付ける') {
 fireEvent.click(screen.getByRole('button', { name: '行うことを足す' })); fireEvent.click(screen.getByRole('menuitem', { name: label }))
}
async function choose() { fireEvent.click(await screen.findByRole('radio', { name: /会員/ })); fireEvent.click(screen.getByRole('button', { name: '選択する', exact: true })) }
it('selects via HQ only, cancels without draft mutation and removes action/reference together', async () => {
 const changed = mount(); await open(); await screen.findByRole('radio', { name: /会員/ })
 expect(search).toHaveBeenCalledWith({ kind: 'tag', q: '', limit: 30, cursor: undefined })
 fireEvent.click(screen.getByRole('button', { name: 'キャンセル' })); expect(changed).not.toHaveBeenCalled()
 await open(); await choose()
 expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { actions: [{ actionType: 'tag', config: { op: 'add', tagIds: ['tag-a'] }, onFailure: 'stop' }] }, references: [{ sourceId: 'tag-a', kind: 'tag', accountId: 'tag-a' }] })
 fireEvent.click(screen.getByRole('button', { name: /1つ目の行うこと.*操作/ }))
 fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
 fireEvent.click(within(screen.getByRole('dialog', { name: '「行うこと」を削除しますか？' })).getByRole('button', { name: '削除する' }))
 expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { actions: [] }, references: [] })
})
it('failed/denied candidates cannot commit, retry and pagination preserve both account candidates', async () => {
 search.mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce(response('tag', 'tag-a', '30')).mockResolvedValueOnce(response('tag', 'tag-b'))
 const changed = mount(); await open('タグを外す'); fireEvent.click(await screen.findByRole('button', { name: '再読込' }))
 expect(changed).not.toHaveBeenCalled(); fireEvent.click(await screen.findByRole('button', { name: 'さらに表示する' }))
 await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2))
 fireEvent.click(screen.getAllByRole('radio')[1]); fireEvent.click(screen.getByRole('button', { name: '選択する', exact: true }))
 expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { actions: [{ actionType: 'tag', config: { op: 'remove', tagIds: ['tag-b'] } }] }, references: [{ sourceId: 'tag-b', accountId: 'tag-b' }] })
})
it('viewer preserves unknown saved actions without controls or requests', () => {
 mount(false, [{ actionType: 'notify_staff', config: { notificationRuleId: 'notice' } }]); expect(screen.getByText('保存済みの後処理')).toBeTruthy(); expect(screen.queryByRole('button')).toBeNull(); expect(search).not.toHaveBeenCalled()
})
it('uses canonical scenario start/restart shape without starting or sending', async () => {
 search.mockResolvedValue(response('scenario', 'scenario')); const changed = mount(); await open('シナリオを始める'); await choose()
 expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { actions: [{ actionType: 'scenario', config: { op: 'start', restart: 'from_start', scenarioId: 'scenario' }, onFailure: 'stop' }] }, references: [{ kind: 'scenario', sourceId: 'scenario' }] })
})

it('changing a target is explicit and preserves the action failure policy', async () => {
 const changed = mount(true, [{ actionType: 'scenario', config: { op: 'start', scenarioId: 'old', restart: 'resume' }, onFailure: 'continue' }])
 fireEvent.click(screen.getByRole('button', { name: /シナリオを始める/ }))
 fireEvent.click(screen.getByRole('button', { name: '対象を選び直す' }))
 search.mockResolvedValue(response('scenario', 'new'))
 // The request for this opening already started; retry with a new query to exercise stale result rejection.
 fireEvent.change(screen.getByRole('searchbox'), { target: { value: '会員' } })
 await choose()
 expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { actions: [{ actionType: 'scenario', config: { op: 'start', scenarioId: 'new', restart: 'resume' }, onFailure: 'continue' }] } })
})
