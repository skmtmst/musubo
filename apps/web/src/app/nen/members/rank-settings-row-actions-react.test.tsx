// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NenRankSettingsData } from '@/lib/nen-ranks-api'
import RankSettingsTab from '@/v8/nen-members/ranks'
const m = vi.hoisted(() => ({ deleteRank: vi.fn(), rankDeletePreview: vi.fn(), retry: vi.fn() }))
vi.mock('@/lib/nen-ranks-api', () => ({ nenRanksApi: { deleteRank: m.deleteRank, rankDeletePreview: m.rankDeletePreview } }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
const SETTINGS: NenRankSettingsData = {
 ranks: [
 { id:'r1', key:'gold', name:'ゴールド', annualThresholdYen:10000, mileRatePercent:3, tagId:null, tagName:null, memberCount:2 },
 { id:'r0', key:'base', name:'レギュラー', annualThresholdYen:0, mileRatePercent:1, tagId:null, tagName:null, memberCount:10 },
 ],
 milestones: [],
 rules: { yearStartMonth:1, applyOnReach:'immediate', keepUntil:'year_end', countOrders:'paid', version:4, syncStatus:'synced', syncError:null, syncedAt:null, updatedAt:'2026-10-11T00:00:00Z' },
 kpis:{ members:12,annualTotalYen:0,lifetimeTotalYen:0,balanceTotal:0,usedThisMonth:0,byRank:{} },
}
function renderTab(settings = SETTINGS) {
 return render(<RankSettingsTab accountId="acc-1" status="ready" settings={settings} readonly={false} onTopBand={vi.fn()} onSaved={vi.fn()} onRetry={m.retry}/>)
}
afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks(); m.deleteRank.mockResolvedValue({ success:true, data:{ ecSync:'synced' } }); m.rankDeletePreview.mockResolvedValue({ success: true, data: { count: 2, version: 4, members: [{ friendId: 'f1', customerId: 'c1' }, { friendId: 'f2', customerId: 'c2' }] } }) })
describe('V8 ランクの幅と行の操作', () => {
 it('区画いっぱいに広がり、操作列は右端にある', () => {
 const { container } = renderTab()
 expect(container.querySelector('[data-presentation="notification"]')).toBeTruthy()
 const head = container.querySelector('[class*="rankHeadRow"]')!
 expect(head.children).toHaveLength(4)
 expect(head.lastElementChild?.className).toContain('rankColAction')
 })
 it('行の列幅は見出しと合う', () => {
 const { container } = renderTab()
 const head = Array.from(container.querySelector('[class*="rankHeadRow"]')!.children).map(x => x.className)
 const rows = Array.from(container.querySelectorAll('[class*="rankRow"]'))
 expect(rows).toHaveLength(2)
 for (const row of rows) expect(Array.from(row.children).map(x => x.className)).toEqual(head)
 })
 it('保存済みの行は「…」に削除を集約し、直置きのゴミ箱は出さない', () => {
 renderTab()
 expect(screen.queryByRole('button', { name:'ゴールドを削除する' })).toBeNull()
 fireEvent.click(screen.getByRole('button', { name:'ランク「ゴールド」のその他操作' }))
 expect(screen.getByRole('menuitem', { name:'ランクを削除する' })).toBeTruthy()
 })
 it('削除は確認するまで送らず、確定後に読み直して行が外れる', async () => {
 const view = renderTab()
 fireEvent.click(screen.getByRole('button', { name:'ランク「ゴールド」のその他操作' }))
 fireEvent.click(screen.getByRole('menuitem', { name:'ランクを削除する' }))
 expect(screen.getByRole('alertdialog').textContent).toContain('ゴールド')
 await screen.findByText(/このランクには会員が 2 人います/)
 expect(screen.getByRole('alertdialog').querySelector('[data-required-badge]')?.textContent).toBe('必須')
 expect(screen.getByLabelText('ランク名 1')).toHaveProperty('value','ゴールド')
 expect(m.deleteRank).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button', { name:'削除する' }))
 await waitFor(() => expect(m.retry).toHaveBeenCalledTimes(1))
 expect(m.deleteRank).toHaveBeenCalledWith('acc-1','r1',{replacementRankId:'r0',expectedVersion:4,confirmedMembers:[{friendId:'f1',customerId:'c1'},{friendId:'f2',customerId:'c2'}]})
 view.rerender(<RankSettingsTab accountId="acc-1" status="ready" settings={{...SETTINGS,ranks:SETTINGS.ranks.slice(1)}} readonly={false} onTopBand={vi.fn()} onSaved={vi.fn()} onRetry={m.retry}/>)
 await waitFor(() => expect(screen.getByLabelText('ランク名 1')).toHaveProperty('value','レギュラー'))
 expect(screen.queryByRole('button',{name:'ランク「ゴールド」のその他操作'})).toBeNull()
 })
 it('追加したばかりの行は確認なしに外せる', () => {
 renderTab()
 fireEvent.click(screen.getByRole('button',{name:'ランクを足す'}))
 expect(screen.getAllByLabelText(/ランク名/)).toHaveLength(3)
 fireEvent.click(screen.getByRole('button',{name:'ランク「ランク 2」のその他操作'}))
 fireEvent.click(screen.getByRole('menuitem',{name:'ランクを削除する'}))
 expect(screen.getAllByLabelText(/ランク名/)).toHaveLength(2)
 expect(screen.queryByRole('alertdialog')).toBeNull()
 expect(m.deleteRank).not.toHaveBeenCalled()
 })
})
