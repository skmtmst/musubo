// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { forgetSessionSnapshot, readSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'

const fixture = vi.hoisted(() => ({ gate: vi.fn(), trust: vi.fn(), session: vi.fn() }))
vi.mock('@/components/step-up-prompt', () => ({ useStepUpGate: () => ({ gate: fixture.gate, prompt: null }) }))
vi.mock('@/lib/api', () => ({ api: { auth: { trustCurrentLogin: fixture.trust, session: fixture.session } } }))
import TrustCurrentLogin from './trust-current-login'

afterEach(() => { cleanup(); forgetSessionSnapshot(); vi.resetAllMocks() })

it('二段階認証の確認後に登録し、最新のセッション状態を反映する', async () => {
  rememberSessionSnapshot({ impersonation: null, unfamiliarAt: '2026-11-25T00:00:00Z', stepUpMethod: 'totp' })
  fixture.gate.mockResolvedValue('grant')
  fixture.trust.mockResolvedValue({ success: true, data: null })
  fixture.session.mockResolvedValue({ success: true, data: { unfamiliarAt: null, stepUpMethod: 'totp' } })
  render(<TrustCurrentLogin />)
  fireEvent.click(screen.getByRole('button', { name: '自分のログインです' }))
  await waitFor(() => expect(readSessionSnapshot()?.unfamiliarAt).toBeNull())
  expect(fixture.gate).toHaveBeenCalledWith('auth.login.trust', expect.any(String))
  expect(fixture.trust).toHaveBeenCalledWith('grant')
})

it('本人確認を閉じたら登録しない', async () => {
  rememberSessionSnapshot({ impersonation: null, unfamiliarAt: '2026-11-25T00:00:00Z', stepUpMethod: 'totp' })
  fixture.gate.mockResolvedValue(null)
  render(<TrustCurrentLogin />)
  fireEvent.click(screen.getByRole('button', { name: '自分のログインです' }))
  await waitFor(() => expect(fixture.gate).toHaveBeenCalled())
  expect(fixture.trust).not.toHaveBeenCalled()
})
