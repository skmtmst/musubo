// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpsMe } from '@/lib/api'
import { usePageTitle } from '@/components/shell/page-chrome'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/logout', () => ({ logoutAndGoToLogin: vi.fn(async () => {}) }))

import OpsShellV8, { opsTitleForPath } from './shell'

const me = {
  id: 'ops-1',
  name: '運営担当',
  email: null,
  readOnly: false,
  totpEnabled: true,
  lineLinked: false,
  legacy: false,
  impersonation: null,
} as OpsMe

function ChildWithTitle({ title }: { title: string }) {
  usePageTitle(title)
  return <p>本文</p>
}

afterEach(() => cleanup())

describe('OpsShellV8 パンくず重複防止とパス境界判定', () => {
  it('opsTitleForPath は別名の前方一致を誤判定せず、クエリ付きや末尾スラッシュ付きを正しく判定する', () => {
    expect(opsTitleForPath('/ops/tenants/detail')).toBe('契約先の詳細')
    expect(opsTitleForPath('/ops/tenants/detail?id=t1')).toBe('契約先の詳細')
    expect(opsTitleForPath('/ops/tenants/detail/')).toBe('契約先の詳細')
    expect(opsTitleForPath('/ops/tenants/detail-other')).toBe('契約先アカウント')
    expect(opsTitleForPath('/ops/applications/detail?id=a1')).toBe('申込アカウント › 詳細')
    expect(opsTitleForPath('/ops/applications/detail-extra')).toBe('申込アカウント')
  })

  it('子画面が同じ画面名を usePageTitle で設定してもパンくずが二重にならない', () => {
    const { container, rerender } = render(
      <OpsShellV8 me={me} meError="" onRetryMe={() => {}} pathname="/ops/announcements">
        <ChildWithTitle title="お知らせ" />
      </OpsShellV8>,
    )
    const headerText = container.querySelector('header')?.textContent ?? ''
    expect(headerText).toContain('運営 › お知らせ')
    expect(headerText).not.toContain('運営 › お知らせ › お知らせ')

    rerender(
      <OpsShellV8 me={me} meError="" onRetryMe={() => {}} pathname="/ops/announcements/new">
        <ChildWithTitle title="新規作成" />
      </OpsShellV8>,
    )
    expect(container.querySelector('header')?.textContent ?? '').toContain('運営 › お知らせ › 新規作成')
  })
})
