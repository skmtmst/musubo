// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { saveBroadcast } from './broadcast-send-actions'
import { api } from '@/lib/api'

describe('実際に送る処理の入口', () => {
  const context = () => ({
    ab: { enabled: false, persist: vi.fn() } as never,
    approvalConfigState: 'ready' as const, approvalCountInput: '', approvalCountMatched: true,
    approvalNote: '', approverId: '', audienceCount: 10, bubbles: [], currentStep: 'confirm' as const,
    needsApproval: false, needsApprovalSingle: false, onSuccess: vi.fn(), persistDraft: vi.fn().mockResolvedValue(null),
    rejectValidation: vi.fn(), saveErrors: { capture: vi.fn() } as never, saving: false,
    scheduledAtIso: () => null, selectedAccountIdRef: { current: 'account' }, sendMode: 'now' as const,
    setConfirmOpen: vi.fn(), setError: vi.fn(), setSaving: vi.fn(), submittingRef: { current: false }, validate: () => '',
  })
  it.each(['unselected', 'optimal'] as const)('%sでは下書きの確定も始めない', async sendMode => {
    const ctx = { ...context(), sendMode }
    await saveBroadcast(ctx)
    expect(ctx.persistDraft).not.toHaveBeenCalled()
    expect(ctx.rejectValidation).toHaveBeenCalledExactlyOnceWith('送る時間を選んでください')
  })
  it.each([
    ['now', null, 'A/Bは送信に使えず、人数も未確定です。③でB案を消し、人数を確認してください。'],
    ['scheduled', null, 'A/Bは送信に使えず、人数も未確定です。③でB案を消し、人数を確認してください。'],
    ['now', 1999, 'A/Bは送信未対応です（条件2,000人以上、現在1,999人）。③でB案を消すとA案を配信できます。'],
    ['scheduled', 1999, 'A/Bは送信未対応です（条件2,000人以上、現在1,999人）。③でB案を消すとA案を配信できます。'],
    ['now', 2000, 'A/Bは送信未対応です。③でB案を消すとA案を配信できます。'],
    ['scheduled', 2000, 'A/Bは送信未対応です。③でB案を消すとA案を配信できます。'],
  ] as const)('A/B有効・%s・対象%s人は保存や送信を始めない', async (sendMode, audienceCount, reason) => {
    const persist = vi.fn()
    const ctx = { ...context(), sendMode, audienceCount, ab: { enabled: true, persist } as never }
    await saveBroadcast(ctx)
    expect(ctx.setError).toHaveBeenCalledWith(reason)
    expect(ctx.persistDraft).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(ctx.onSuccess).not.toHaveBeenCalled()
  })
  it('前に作られた押し口でも最新の日時/分数の不足で止まる', async () => {
    const current = { reason: null as string | null }
    const ctx = { ...context(), sendProblem: () => current.reason }
    const retained = () => saveBroadcast(ctx)
    current.reason = '分散する時間を1〜720の整数で入力してください'
    await retained()
    expect(ctx.persistDraft).not.toHaveBeenCalled()
    expect(ctx.rejectValidation).toHaveBeenCalledWith(current.reason)
    current.reason = null
    await retained()
    expect(ctx.persistDraft).toHaveBeenCalledTimes(1)
  })
  it('1人運用の訂正を送るとき、確認した人数と保存後の版を渡す', async () => {
    const saved = { id: 'correction', correctionOfBroadcastId: 'source', version: 3 } as never
    const send = vi.spyOn(api.broadcasts, 'send').mockResolvedValue({ success: true, data: saved })
    const ctx = { ...context(), approvalCountInput: '10', needsApproval: true, needsApprovalSingle: true,
      persistDraft: vi.fn().mockResolvedValue(saved), ab: { enabled: false, persist: vi.fn().mockResolvedValue(3) } as never }
    try {
      await saveBroadcast(ctx)
      expect(send).toHaveBeenCalledWith('correction', { expectedVersion: 3, confirmedRecipientCount: 10 })
    } finally { send.mockRestore() }
  })

})
