'use client'

import Notice from '@/components/shared/notice'
import { api,type ApiBroadcast,type BroadcastBubble } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { broadcastAbApi } from '@/v8/broadcast-ab/public/api/index'
import type { SendConfirmationPreview } from '@line-crm/shared'
import type { Dispatch,SetStateAction } from 'react'

/** A/B の試験で今すぐ送る人数。半々のときはテスト宛先の全員、それ以外は A・B 同数に切りそろえる。 */
export function abTrialRecipients(testRecipientCount: number | null, testRatioPct: number): number | null {
  if (testRecipientCount === null) return null
  if (testRatioPct === 50) return testRecipientCount
  return 2 * Math.max(1, Math.floor(testRecipientCount * testRatioPct / 200))
}

/** 最終確認に出す、テスト宛先と今すぐ送る人数の案内。 */
export function BroadcastAbTrialNotice({ testRecipientCount, trialCount }: { testRecipientCount: number | null; trialCount: number | null }) {
  return <Notice tone={testRecipientCount !== null && testRecipientCount >= 2 ? 'info' : 'warn'}>{testRecipientCount === null ? '検証環境の設定とテスト宛先を確認できません。' : `テスト宛先 ${formatNumber(testRecipientCount)} 人のうち、今すぐ A・B に ${formatNumber(trialCount)} 人へ送ります。残り ${formatNumber(testRecipientCount - (trialCount ?? 0))} 人には人数不足なら自動送信しません。`}</Notice>
}

type PrepareAbConfirmationContext = {
  ab: { persist: (broadcastId: string, version: number, aBubbles: BroadcastBubble[]) => Promise<number> }
  alreadyApproved: boolean
  alive: () => boolean
  bubbles: BroadcastBubble[]
  onVersion: (version: number) => void
}

/**
 * 最終確認を開いたとき、B 案を下書きへ保存してからテスト宛先の人数を読む。
 * 承認済みの下書きは内容を変えないので保存しない。途中で閉じられたら null を返す。
 */
export async function prepareBroadcastAbConfirmation(saved: ApiBroadcast, { ab, alreadyApproved, alive, bubbles, onVersion }: PrepareAbConfirmationContext): Promise<{ saved: ApiBroadcast; testRecipientCount: number | null } | null> {
  let current = saved
  if (!alreadyApproved) {
    const version = await ab.persist(current.id, Number(current.version ?? 0), bubbles)
    if (!alive()) return null
    onVersion(version)
    current = { ...current, version }
  }
  const info = await broadcastAbApi.result(current.id)
  if (!alive()) return null
  return { saved: current, testRecipientCount: info.data.liveTestRecipientCount ?? null }
}

type StartBroadcastAbContext = {
  abEnabled: boolean
  approvalCountMatched: boolean
  approvalNote: string
  approverId: string
  needsApproval: boolean
  needsApprovalSingle: boolean
  onSuccess: (broadcast: ApiBroadcast) => void
  saveErrors: { capture: (caught: unknown) => boolean }
  saving: boolean
  selectedAccountIdRef: { readonly current: string | null }
  sendPreview: { data: SendConfirmationPreview | null; broadcast: ApiBroadcast | null }
  setConfirmOpen: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  setSaving: Dispatch<SetStateAction<boolean>>
  startKey: string | null
  submittingRef: { current: boolean }
  testRecipientCount: number | null
}

/** A/B の試験送信を始める。承認が要るときは送らずに承認を依頼する。 */
export async function startBroadcastAb({ abEnabled, approvalCountMatched, approvalNote, approverId, needsApproval, needsApprovalSingle, onSuccess, saveErrors, saving, selectedAccountIdRef, sendPreview, setConfirmOpen, setError, setSaving, startKey, submittingRef, testRecipientCount }: StartBroadcastAbContext) {
  if (!abEnabled || !sendPreview.data || !sendPreview.broadcast || testRecipientCount === null || testRecipientCount < 2 || !startKey || saving || submittingRef.current) return
  if (needsApprovalSingle && !approvalCountMatched) { setError('人数を入れて一致させてください'); return }
  if (needsApproval && !needsApprovalSingle && !approverId) { setError('承認をお願いする人を選んでください'); return }
  const account = selectedAccountIdRef.current
  submittingRef.current = true; setSaving(true); setError('')
  try {
    if (needsApproval && !needsApprovalSingle) {
      const requested = await api.broadcasts.approval.request(sendPreview.broadcast.id, { approverStaffId: approverId, note: approvalNote.trim() || undefined })
      if (!requested.success) { setError(requested.error); return }
    } else {
      const started = await broadcastAbApi.startLive(sendPreview.broadcast.id, Number(sendPreview.data.expectedVersion), sendPreview.data.recipients, testRecipientCount, startKey)
      if (!started.success || started.data.status !== 'live_testing') { setError('試しの送信を停止しました。結果を確認してください。'); return }
    }
    if (account !== selectedAccountIdRef.current) return
    setConfirmOpen(false); onSuccess(sendPreview.broadcast)
  } catch (caught) {
    if (account === selectedAccountIdRef.current && !saveErrors.capture(caught)) setError('A/B 配信を開始できませんでした。内容を確認してください。')
  } finally { submittingRef.current = false; setSaving(false) }
}
