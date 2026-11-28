// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  scenario: vi.fn(),
  tags: vi.fn(),
  templates: vi.fn(),
  invalidateScenario: vi.fn(),
  draftGet: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=sc-1'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/scenarios/first-step',
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>{children}</a>
  ),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    accounts: [{ id: 'acc-1', name: '見本アカウント' }],
    selectedAccountId: 'acc-1',
    loading: false,
  }),
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => readStaffIdentity()?.role ?? null,
}))
vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: mocks.scenario,
    tags: mocks.tags,
    templates: mocks.templates,
    invalidateScenario: mocks.invalidateScenario,
  },
}))
vi.mock('@/components/scenarios/insert-toolbar', () => ({ default: () => null }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      scenarioDrafts: {
        ...actual.api.scenarioDrafts,
        get: mocks.draftGet,
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import ScenarioFirstStepV8 from './first-step'

const sampleScenario = {
  id: 'sc-1',
  name: '見本シナリオ',
  lineAccountId: 'acc-1',
  deliveryMode: 'elapsed' as const,
  steps: [
    {
      id: 'step-1',
      scenarioId: 'sc-1',
      stepOrder: 1,
      messageType: 'text' as const,
      messageContent: 'はじめましての本文',
      offsetDays: 0,
      offsetMinutes: 30,
      delayMinutes: 0,
      deliveryTime: null,
      templateId: null,
      question: null,
      targetCondition: null,
    },
  ],
}

describe('ScenarioFirstStepV8 読み込み失敗の分類と再読み込み復旧', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    forgetSessionSnapshot()
    verifiedStaffRole('owner')
    mocks.tags.mockResolvedValue({ success: true, data: [] })
    mocks.templates.mockResolvedValue({ success: true, data: [] })
    mocks.draftGet.mockRejectedValue(new ApiError(404, 'not_found', 'not_found'))
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
    forgetSessionSnapshot()
  })

  it('429 応答の待ち秒数を案内し、もう一度読み込むで編集画面へ復旧できる', async () => {
    mocks.scenario
      .mockRejectedValueOnce(new ApiError(429, 'Too many requests', undefined, undefined, undefined, 30))
      .mockResolvedValueOnce({ success: true, data: sampleScenario })

    render(<ScenarioFirstStepV8 />)

    expect(await screen.findByText('混み合っています')).toBeTruthy()
    expect(screen.getByText('30秒ほど待ってから、もう一度読み込んでください。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      const box = screen.getByRole('textbox', { name: '本文', exact: true }) as HTMLTextAreaElement
      expect(box.value).toBe('はじめましての本文')
    })
  })

  it('403 応答では通信エラーに丸めず権限の案内を表示する', async () => {
    mocks.scenario.mockRejectedValueOnce(new ApiError(403, 'forbidden'))

    render(<ScenarioFirstStepV8 />)

    expect(await screen.findByText('この画面を見る権限がありません')).toBeTruthy()
    expect(screen.getByText('この操作の権限がありません。オーナーか管理者に頼んでください。')).toBeTruthy()
  })
})
