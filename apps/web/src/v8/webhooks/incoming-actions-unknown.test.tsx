// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import type { IncomingWebhookDetail } from '@/lib/api'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
import IncomingActions from './incoming-actions'

beforeEach(() => verifiedStaffRole('viewer'))
afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__', 'future'])('未知の操作 %s でも名前を残して表示する', (refKind) => {
  const detail = { id: 'hook-1', version: 1, identityMatching: { methods: [], onNotFound: 'unmatched_box' }, actions: [{ refKind, refId: 'old', refVersionId: null, displayName: '保存済みの操作' }] } as unknown as IncomingWebhookDetail
  render(<IncomingActions detail={detail} accountId="demo" readOnly onSaved={() => {}} onGuardReady={() => {}} />)
  expect(screen.getByText('保存済みの操作')).toBeTruthy()
  expect(screen.getByText('登録済みの操作')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '行うことを保存する' })).toBeNull()
})
