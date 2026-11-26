// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ kind: '' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('id=action-1') }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'demo', accounts: [], loading: false }) }))
vi.mock('./shell', () => ({ useAutomationManage: () => true }))
vi.mock('@/lib/use-manual-href', () => ({ useManualHref: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, commonActions: { ...actual.api.commonActions, get: async () => ({ success: true, data: { id:'action-1', name:'見本の操作', status:'active', currentDraftVersionId:null, currentPublishedVersionId:'v1', versions:[{id:'v1',versionNumber:1,status:'published',actions:[],draftRevision:1,publishedAt:'2026-01-01'}], bindings:[{id:'binding-1',confirmationRevision:7,consumerType:fixture.kind,consumerId:'demo',consumerPath:'見本の利用先',versionId:'v1',versionNumber:1,latestVersionNumber:1,hasNewerVersion:false,runningCount:0,waitingCount:0,olderRunningCount:0,olderWaitingCount:0}] } }), list: async () => ({ success: true, data: [] }) } } }
})
import Versions from './versions'
afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__', 'future'])('未対応の利用先 %s も画面に残す', async kind => {
  fixture.kind = kind
  render(<Versions />)
  expect(await screen.findByText('見本の利用先')).toBeTruthy()
  expect(screen.getByText('ほか 1')).toBeTruthy()
  expect(screen.getByText(kind)).toBeTruthy()
})
