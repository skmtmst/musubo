// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFeatureSettingsCache } from '@/lib/feature-settings-cache'
import { useFeatureSettings } from './use-feature-settings'

const fixture = vi.hoisted(() => ({
  accountId: 'acc-a',
  putStatus: 200,
  impactResolver: null as ((value: Response) => void) | null,
  impactCalls: 0,
  holdImpact: false,
  requireImpactConfirmation: false,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/settings',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))
vi.mock('@/hooks/use-account-style', () => ({
  useAccountStyle: () => ({ status: 'ready', data: { style: 'standard', styleSelected: true, version: 1, answers: {} } }),
}))

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const loadedPayload = {
  success: true,
  data: {
    features: { scenarios: true, broadcasts: true, templates: true, forms: true },
    sidebarItemOrder: {},
    specializedFeatureKeys: [],
    version: 3,
  },
}

function Harness() {
  const s = useFeatureSettings()
  const firstOffItem = s.groups.flatMap((group) => group.items).find((item) => !item.required && item.keys.includes('scenarios'))
  return (
    <div>
      <output data-testid="loading">{String(s.loading)}</output>
      <output data-testid="saving">{String(s.saving)}</output>
      <output data-testid="conflict">{String(s.conflict)}</output>
      <output data-testid="impact-open">{String(s.impactOpen)}</output>
      <output data-testid="impact-busy">{String(s.impactBusy)}</output>
      <output data-testid="impact-error">{s.impactError}</output>
      <button type="button" onClick={() => { if (firstOffItem) s.toggleItem(firstOffItem, false) }}>シナリオをオフ</button>
      <button type="button" onClick={() => s.setReason('運用見直しのため')}>理由を入力</button>
      <button type="button" onClick={() => void s.save()}>保存</button>
      <button type="button" onClick={() => void s.confirmImpactSave()}>確認して保存</button>
    </div>
  )
}

beforeEach(() => {
  fixture.accountId = 'acc-a'
  fixture.putStatus = 200
  fixture.impactResolver = null
  fixture.impactCalls = 0
  fixture.holdImpact = false
  fixture.requireImpactConfirmation = false
  clearFeatureSettingsCache()
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/settings/features/impact')) {
      fixture.impactCalls += 1
      if (fixture.holdImpact) {
        return new Promise<Response>((resolve) => {
          fixture.impactResolver = resolve
        })
      }
      return jsonResponse({
        success: true,
        data: {
          version: 3,
          requiresConfirmation: fixture.requireImpactConfirmation,
          impacts: fixture.requireImpactConfirmation
            ? [{ feature: 'scenarios', blocking: false, items: [{ kind: 'published', targetType: 'シナリオ', count: 1 }] }]
            : [],
          impactToken: fixture.requireImpactConfirmation ? 'tok-1' : null,
        },
      })
    }
    if (url.includes('/api/settings/features') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(loadedPayload)
    }
    if (url.includes('/api/settings/features') && init?.method === 'PUT') {
      if (fixture.putStatus === 409) {
        return jsonResponse({ success: false, error: 'conflict' }, 409)
      }
      return jsonResponse(loadedPayload)
    }
    if (url.includes('/api/analytics/usage')) {
      return jsonResponse({ success: true, data: { categories: [], features: [] } })
    }
    return jsonResponse({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useFeatureSettings のアカウント切替・二重保存の守り', () => {
  it('A で 409 競合になったあと B へ切り替えると conflict が消える', async () => {
    fixture.putStatus = 409
    const view = render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'シナリオをオフ' }))
    fireEvent.click(screen.getByRole('button', { name: '理由を入力' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByTestId('conflict').textContent).toBe('true'))

    fixture.accountId = 'acc-b'
    view.rerender(<Harness />)

    await waitFor(() => expect(screen.getByTestId('conflict').textContent).toBe('false'))
  })

  it('A で影響確認の通信中に B へ切り替えても impactBusy と impactError が B に残らない', async () => {
    fixture.requireImpactConfirmation = true
    const view = render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'シナリオをオフ' }))
    fireEvent.click(screen.getByRole('button', { name: '理由を入力' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByTestId('impact-open').textContent).toBe('true'))

    fixture.holdImpact = true
    fireEvent.click(screen.getByRole('button', { name: '確認して保存' }))
    await waitFor(() => expect(screen.getByTestId('impact-busy').textContent).toBe('true'))

    fixture.accountId = 'acc-b'
    view.rerender(<Harness />)

    await waitFor(() => expect(screen.getByTestId('impact-busy').textContent).toBe('false'))

    fixture.impactResolver?.(jsonResponse({
      success: true,
      data: { version: 3, requiresConfirmation: true, impacts: [], impactToken: 'tok-late' },
    }))
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    expect(screen.getByTestId('impact-error').textContent).toBe('')
    expect(screen.getByTestId('impact-busy').textContent).toBe('false')
  })

  it('保存の確認通信中にもう一度保存を押しても二重送信しない', async () => {
    const view = render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'シナリオをオフ' }))
    fireEvent.click(screen.getByRole('button', { name: '理由を入力' }))

    fixture.holdImpact = true
    const saveButton = screen.getByRole('button', { name: '保存' })
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('true'))
    expect(fixture.impactCalls).toBe(1)

    fixture.impactResolver?.(jsonResponse({
      success: true,
      data: { version: 3, requiresConfirmation: false, impacts: [], impactToken: null },
    }))
    await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('false'))
    view.unmount()
  })
})
