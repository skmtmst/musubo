// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { PreviewStep } from './editor-actions-preview'
import { EMPTY_DEFINITION, EMPTY_RULE } from './editor-model'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
afterEach(() => { cleanup(); verifiedStaffRole(null) })
function preview(canEdit: boolean, runTest = vi.fn()) {
  return <PreviewStep rule={EMPTY_RULE} definition={EMPTY_DEFINITION} routeNames={[]} runTest={runTest} onTestConditions={vi.fn()} testing={false} testOk={false} overlapNotes={[]} slackConnected scenarios={[]} canEdit={canEdit} hrefFor={step => '/friend-add-settings/new?step=' + step} accountId="account-a" />
}
describe('確認の行の変更操作', () => {
  it('管理できる時は同じ行き先の文字リンクとテスト操作を残す', () => {
    verifiedStaffRole('owner')
    const run = vi.fn()
    render(preview(true, run))
    const rows = screen.getByRole('region', { name: '設定の確認' })
    const links = within(rows).getAllByRole('link', { name: '変更する' })
    expect(links).toHaveLength(6)
    expect(links[0].getAttribute('href')).toBe('/friend-add-settings/new?step=basic')
    for (const link of links) expect(link.getAttribute('data-variant')).toBe('text')
    const checks = screen.getByRole('region', { name: '有効にする前の確認' })
    expect(within(checks).getAllByRole('link', { name: '見直す' })).toHaveLength(3)
    fireEvent.click(within(checks).getByRole('button', { name: '直す' }))
    expect(run).toHaveBeenCalledOnce()
  })
  it.each(['viewer', null] as const)('役割%sでは行の変更とテストを表示したまま止める', async role => {
    verifiedStaffRole(role)
    const run = vi.fn()
    render(preview(false, run))
    const rows = screen.getByRole('region', { name: '設定の確認' })
    const checks = screen.getByRole('region', { name: '有効にする前の確認' })
    expect(within(rows).queryByRole('link', { name: '変更する' })).toBeNull()
    const actions = [...within(rows).getAllByRole('button', { name: '変更する' }), ...within(checks).getAllByRole('button', { name: /見直す|直す/ })]
    expect(actions).toHaveLength(10)
    for (const action of actions) {
      expect(action.getAttribute('href')).toBeNull()
      expect(action.getAttribute('data-variant')).toBe('text')
      expect(action.getAttribute('aria-disabled') === 'true' || (action as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(action)
      fireEvent.keyDown(action, { key: 'Enter' })
    }
    expect(run).not.toHaveBeenCalled()
    if (role === 'viewer') {
      fireEvent.focus(within(checks).getByRole('button', { name: '直す' }))
      expect((await screen.findByRole('tooltip')).textContent).toContain('閲覧のみ')
    }
  })
})
