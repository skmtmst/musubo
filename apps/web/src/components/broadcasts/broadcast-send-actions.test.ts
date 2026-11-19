// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { saveBroadcast } from './broadcast-send-actions'

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
  it.each(['now', 'scheduled'] as const)('A/B有効・%sは通常の送信口を通さない', async sendMode => {
    const persist = vi.fn()
    const ctx = { ...context(), sendMode, ab: { enabled: true, persist } as never }
    await saveBroadcast(ctx)
    expect(ctx.setError).toHaveBeenCalledWith('A/B配信は確認画面から開始してください。')
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
})
