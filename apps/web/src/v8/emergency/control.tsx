'use client'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { useEmergencyTarget } from './control-target'
import { useRunningVersion } from '@/lib/use-running-version'

import { formatMonthDay, stopMinutes } from './control-time'
import { useEmergencyControlAccess } from './use-control-access'

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { GitBranch, OctagonPause, ShieldCheck, Timer } from 'lucide-react'
import type { LineAccount } from '@line-crm/shared'
import { api, ApiError, type OperationCapability, type OperationControl, type OperationHistoryEntry, type OperationImpactPreview, type OperationRestoreDrift } from '@/lib/api'
import { operationImpactText, type EmergencyStopTarget } from '@/lib/operation-impact'
import { formatOperationDate } from '@/lib/operation-status'
import { formatMinutesRough } from '@/lib/format-duration'
import { readSessionSnapshot } from '@/lib/session-snapshot'
import Button from '@/components/shared/button'
import { Tabs } from '@/components/shared/tabs'
import { RowNameButton } from '@/components/shared/table'
import LogEntryDetails, { type LogEntryFacts } from '@/components/shared/log-entry-details'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Checkbox from '@/components/shared/checkbox'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { DialogFormRow } from '@/components/shared/dialog-form-row'
import { TextField } from '@/components/shared/text-field'
import ListState from '@/components/shared/list-state'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import OtpInput from '@/components/shared/otp-input'
import StepUpDialog from '@/components/shared/step-up-dialog'
import { EmergencyControlFeedback } from './control-feedback'
import { emergencySafetyTransition, isEmergencyMutationLocked, runCurrentRequest } from './control-state'
import { CAPABILITY_LABEL, describeRestoreBlockers, describeRestoreDrift, describeRestoreResult } from '@/lib/operation-restore'
import { SendPathCoveragePanel } from './send-path-coverage-panel'
import styles from '../../app/emergency/control-v8.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { FormLeaveGuard } from '@/components/shared/form-leave-guard'
import Card from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'

/* ★V8-B 緊急コントロール（板 ）。停止・復旧・本人確認・冪等キーと
 * 競合後の読み直しは、この現役の部品だけで守る。 */

type StopTarget = 'broadcasts' | 'scenarios' | 'reminders' | 'automations'

/*
 * 画面の並びと、口が返す名前の対応。画面は `broadcasts`、口は
 * `broadcast_dispatch` と呼ぶ。**どちらかに寄せない**（API の契約）。
 */
const IMPACT_KEY: Record<StopTarget, EmergencyStopTarget> = {
  broadcasts: 'broadcast_dispatch',
  scenarios: 'scenario_dispatch',
  reminders: 'reminder_dispatch',
  automations: 'automation_actions',
}

const TARGET_CAPABILITIES: Record<StopTarget, OperationCapability[]> = {
  broadcasts: ['broadcast_dispatch'],
  scenarios: ['scenario_dispatch'],
  reminders: ['reminder_dispatch'],
  automations: ['automation_actions', 'auto_reply_dispatch'],
}

/* 止められない理由の機械コード。口の応答と1対1に対応する。 */
const BLOCKED_CODES = {
  controlForbidden: 'EMERGENCY_CONTROL_FORBIDDEN',
  scopeForbidden: 'EMERGENCY_SCOPE_FORBIDDEN',
} as const

function blockedText(code: string | null | undefined): string | null {
  if (code === BLOCKED_CODES.scopeForbidden) return 'この範囲を操作する権限がありません。対象アカウントを選び直すか、オーナーに確認してください。'
  if (code === BLOCKED_CODES.controlForbidden) return '緊急停止を実行する権限がありません。オーナーに権限付与を依頼してください。'
  return null
}

/*
 * 403・409（版競合）以外で落ちたときの理由。口の `error` は
 * 400/409/422/428 でだけ運用者向け文言として保証される。429・5xx では
 * `ApiError.message` が内部向けの作り置きに落ちるため、固定の案内文へ倒す。
 */
function failureText(error: unknown, fallback: string): string {
  if (japaneseDetailOf(error)) return japaneseDetailOf(error)
  return fallback
}

type Feedback = { tone: 'success' | 'warning' | 'danger'; text: string } | null

const HISTORY_FETCH_LIMIT = 200
/** 記録の表の「何を」は短い言い方（絵 ：一斉配信・シナリオ）。全文は title で見る。 */
const CAPABILITY_SHORT: Partial<Record<keyof typeof CAPABILITY_LABEL, string>> = {
  broadcast_dispatch: '一斉配信',
  scenario_dispatch: 'シナリオ',
  // 上の「何を止めますか」のチェックと同じ短い言い方。
  automation_actions: '自動処理',
}
const capabilityShort = (capability: keyof typeof CAPABILITY_LABEL) => CAPABILITY_SHORT[capability] ?? CAPABILITY_LABEL[capability]
/** 記録の表に出す件数。全部は更新履歴のタブで見る。 */
const RECORD_LIMIT = 10

/** 「8/14 19:02〜19:40」の形。終わりが無ければ始まりだけ出す。 */
function formatStopRange(start: string | null, end: string | null): string {
  if (!start) return '日時不明'
  const from = new Date(start)
  if (!Number.isFinite(from.getTime())) return formatOperationDate(start)
  const time = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const head = `${from.getMonth() + 1}/${from.getDate()} ${time(from)}`
  if (!end) return head
  const to = new Date(end)
  if (!Number.isFinite(to.getTime())) return head
  const sameDay = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth() && from.getDate() === to.getDate()
  return `${head}〜${sameDay ? time(to) : `${to.getMonth() + 1}/${to.getDate()} ${time(to)}`}`
}

export type EmergencyControlV8Handle = { openStop: () => void }
export type EmergencyControlAccess = { allowed: boolean | null; stopDisabled: boolean; lockedReason?: string }
type EmergencyControlProps = { accounts: LineAccount[]; onAccessChange?: (access: EmergencyControlAccess) => void }

const EmergencyControlV8 = (
  { accounts, onAccessChange }: EmergencyControlProps,
  ref: React.Ref<EmergencyControlV8Handle>,
) => {
  const runningVersion = useRunningVersion()
  const { defaultTargetAccountId, targetAccountId, canReadTarget, selectTarget, role: staffRole } = useEmergencyTarget(accounts)
  const [targets, setTargets] = useState<Record<StopTarget, boolean>>({ broadcasts: true, scenarios: true, reminders: true, automations: false })
  const [reason, setReason] = useState('')
  const [reasonDetail, setReasonDetail] = useState('')
  const [stopCode, setStopCode] = useState('')
  const [stopPassword, setStopPassword] = useState('')

  const [impact, setImpact] = useState<OperationImpactPreview | null>(null)
  const [impactFailed, setImpactFailed] = useState(false)
  const [control, setControl] = useState<OperationControl | null>(null)
  const [previewCanControl, setCanControl] = useState(false)
  const [blockedCode, setBlockedCode] = useState<string | null>(null)
  const [calculatedAt, setCalculatedAt] = useState<string | null>(null)

  const [recordFilter, setRecordFilter] = useState('all')
  const [recordEntry, setRecordEntry] = useState<LogEntryFacts | null>(null)
  const [entries, setEntries] = useState<OperationHistoryEntry[]>([])
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading')

  const [feedback, setFeedback] = useState<Feedback>(null)
  const [needsReload, setNeedsReload] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [running, setRunning] = useState(false)

  /* 確認の窓（停止／復旧の言葉）→ 本人確認の窓（6桁かパスワード）の順に進む。 */
  const [confirmMode, setConfirmMode] = useState<'stop' | 'restore' | null>(null)
  const [confirmed, setConfirmed] = useState<{ accountId: string | null; name?: string; version: number; incidentId: string | null; capabilities: OperationCapability[]; isCurrent: () => boolean } | null>(null)
  const [confirmWord, setConfirmWord] = useState('')
  const [stepUpMode, setStepUpMode] = useState<'stop' | 'restore' | null>(null)
  const [stepUpError, setStepUpError] = useState('')
  const [requestKey, setRequestKey] = useState('')

  const [restoreDrift, setRestoreDrift] = useState<OperationRestoreDrift | null>(null)

  /* V-1: 二段階認証を使っている人は6桁、無い人はパスワードで確認する。 */
  const stepUpMethod = readSessionSnapshot()?.stepUpMethod ?? 'totp'

  const previewGeneration = useRef(0)
  const reloadLock = useRef(false)
  const mutationLock = useRef(false)
  const mutationLocked = isEmergencyMutationLocked(needsReload || reloading, running)
  const access = useEmergencyControlAccess({
    ready: impact !== null && control !== null && !impactFailed,
    permitted: previewCanControl,
    accountId: targetAccountId,
  })
  const canControl = access.allowed
  const lockedReason = access.lockedReason
  useEffect(() => { if (!canControl) setStepUpMode(null) }, [canControl])


  const requestPreview = useCallback(async (accountId: string | null) => {
    const response = await api.operations.preview(accountId)
    if (!response.success) throw new Error(response.error)
    if (response.data?.impact && response.data?.control && response.data?.permissions) {
      return response.data
    }
    throw new Error('invalid preview')
  }, [])

  const loadPreview = useCallback(async (accountId: string | null, generation: number) => {
    let loaded = false
    await runCurrentRequest({
      request: () => requestPreview(accountId),
      isCurrent: () => previewGeneration.current === generation,
      onSuccess: (preview) => {
        loaded = true
        setImpact(preview.impact)
        setImpactFailed(false)
        setControl(preview.control)
        setCanControl(preview.permissions.canControl)
        setBlockedCode((preview.permissions as { canControl: boolean; reasonCode?: string | null }).reasonCode ?? null)
        setCalculatedAt(preview.calculatedAt)
      },
      onError: (error) => {
        setImpact(null)
        setImpactFailed(true)
        setControl(null)
        setCanControl(false)
        setBlockedCode(error instanceof ApiError ? (error.code ?? null) : null)
      },
    })
    return loaded
  }, [requestPreview])

  const clearPreview = useCallback(() => {
    previewGeneration.current += 1
    setImpact(null)
    setImpactFailed(false)
    setControl(null)
    setCanControl(false)
    setBlockedCode(null)
    setCalculatedAt(null)
  }, [])

  const applySafety = useCallback((event: Parameters<typeof emergencySafetyTransition>[0]) => {
    const state = emergencySafetyTransition(event)
    // 読み直し失敗は loadPreview が既に値を破棄している。失敗と権限の理由は残す。
    if (state.clearPreview && event !== 'reload-failure') clearPreview()
    if (state.closeDialogs) {
      setConfirmMode(null)
      setStepUpMode(null)
      setConfirmWord('')
      setStopCode('')
      setStopPassword('')
      setStepUpError('')
      setRequestKey('')
    }
    setNeedsReload(state.needsReload)
    setReloading(state.reloading)
    setFeedback(state.message)
  }, [clearPreview])

  useEffect(() => {
    const generation = ++previewGeneration.current
    setNeedsReload(false)
    setReloading(false)
    setConfirmMode(null)
    setConfirmWord('')
    setStepUpMode(null)
    setStepUpError('')
    setRequestKey('')
    if (canReadTarget) void loadPreview(targetAccountId === 'all' ? null : targetAccountId, generation)
    else clearPreview()
    return () => {
      if (previewGeneration.current === generation) previewGeneration.current += 1
    }
  }, [canReadTarget, clearPreview, loadPreview, targetAccountId])

  const reloadControl = useCallback(async () => {
    if (reloadLock.current || !canReadTarget) return
    reloadLock.current = true
    applySafety('reload-start')
    const generation = previewGeneration.current
    try {
      const loaded = await loadPreview(targetAccountId === 'all' ? null : targetAccountId, generation)
      if (previewGeneration.current !== generation) return
      applySafety(loaded ? 'reload-success' : 'reload-failure')
    } finally {
      reloadLock.current = false
    }
  }, [applySafety, canReadTarget, loadPreview, targetAccountId])

  /* 止めた・戻した記録と、いまの版。タブをまたいで同じ口・同じ数え方を使う。 */
  useEffect(() => {
    let cancelled = false
    setHistoryState('loading')
    api.operations.history(HISTORY_FETCH_LIMIT)
      .then((response) => {
        if (cancelled) return
        if (response.success && Array.isArray(response.data)) {
          setEntries(response.data)
          setHistoryState('ready')
        } else {
          setHistoryState('error')
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryState('error')
      })
    return () => { cancelled = true }
  }, [])

  /* 停止中の incident が確定したら復旧前検査を取り、確認画面へ出す。 */
  const activeIncidentId = control?.activeIncidentId ?? null
  useEffect(() => {
    if (!activeIncidentId) {
      setRestoreDrift(null)
      return
    }
    let cancelled = false
    void api.operations.restorePreview(activeIncidentId)
      .then((response) => {
        if (!cancelled && response.success) setRestoreDrift(response.data.drift)
      })
      .catch(() => {
        if (!cancelled) setRestoreDrift(null)
      })
    return () => { cancelled = true }
  }, [activeIncidentId])

  const operations = entries.filter((item) => item.historyKind !== 'incident' || true)
    .filter((item) => item.historyKind !== 'deployment')
  const cutoff90 = Date.now() - 90 * 24 * 60 * 60 * 1000
  const recent90 = operations.filter((item) => Number.isFinite(Date.parse(item.createdAt)) && Date.parse(item.createdAt) >= cutoff90)
  const longest = operations.reduce<{ minutes: number; entry: OperationHistoryEntry | null }>(
    (best, item) => {
      const minutes = stopMinutes(item.stoppedAt, item.resolvedAt)
      return minutes !== null && minutes > best.minutes ? { minutes, entry: item } : best
    },
    { minutes: 0, entry: null },
  )

  const selectedTargets = useMemo(() => (Object.keys(targets) as StopTarget[]).filter((key) => targets[key]), [targets])
  const selectedCapabilities = useMemo(() => selectedTargets.flatMap((key) => TARGET_CAPABILITIES[key]), [selectedTargets])
  const isStopped = Boolean(control?.activeIncidentId)
  const previewSettled = impact !== null || impactFailed

  const targetLabels: Record<StopTarget, { label: string; note: string }> = {
    broadcasts: { label: '予約中の一斉配信', note: '予約を下書きに戻します' },
    scenarios: { label: 'シナリオ', note: '有効のシナリオ配信を止めます' },
    reminders: { label: 'リマインダ', note: '有効のものを止めます' },
    automations: { label: '自動処理', note: 'オートメーションと自動応答を止めます' },
  }

  const impactText = (key: StopTarget) => {
    if (impactFailed) return '影響を確認できません'
    if (key !== 'automations') return operationImpactText(IMPACT_KEY[key], impact)
    return `オートメーション ${operationImpactText('automation_actions', impact)}／自動応答 ${operationImpactText('auto_reply_dispatch', impact)}`
  }

  const openStopConfirm = useCallback(() => {
    if (!access.canRun()) return
    if (mutationLocked) {
      setFeedback({ tone: 'warning', text: '最新の状態を読み直してから、もう一度確認してください。' })
      return
    }
    if (!control || impactFailed || !impact) {
      setFeedback({ tone: 'warning', text: '停止状態と影響を確認できるまで実行できません。' })
      return
    }
    if (!canControl) {
      setFeedback({ tone: 'warning', text: '緊急停止を実行する権限がありません。' })
      return
    }
    if (selectedTargets.length === 0) {
      setFeedback({ tone: 'warning', text: '停止する配信を1つ以上選んでください。' })
      return
    }
    setConfirmWord('')
    setStepUpError('')
    setRequestKey(crypto.randomUUID())
    setConfirmed({ accountId: targetAccountId === 'all' ? null : targetAccountId, name: accounts.find(account => account.id === targetAccountId)?.name, version: control.version, incidentId: control.activeIncidentId, capabilities: selectedCapabilities, isCurrent: access.capture() })
    setConfirmMode('stop')
  }, [access.canRun, access.capture, accounts, canControl, control, impact, impactFailed, mutationLocked, selectedCapabilities, selectedTargets.length, targetAccountId])

  useImperativeHandle(ref, () => ({ openStop: () => openStopConfirm() }), [openStopConfirm])

  const openRestoreConfirm = () => {
    if (!access.canRun()) return
    if (mutationLocked) {
      setFeedback({ tone: 'warning', text: '最新の状態を読み直してから、もう一度確認してください。' })
      return
    }
    if (!control?.activeIncidentId) {
      setFeedback({ tone: 'warning', text: 'いまは止めていません。復旧できるものはありません。' })
      return
    }
    if (!canControl) {
      setFeedback({ tone: 'warning', text: '復旧を実行する権限がありません。' })
      return
    }
    setConfirmWord('')
    setStepUpError('')
    setRequestKey(crypto.randomUUID())
    setConfirmed({ accountId: control.lineAccountId, name: accounts.find(account => account.id === control.lineAccountId)?.name, version: control.version, incidentId: control.activeIncidentId, capabilities: selectedCapabilities, isCurrent: access.capture() })
    setConfirmMode('restore')
  }

  const confirmationCurrent = () => Boolean(confirmed && confirmed.isCurrent() && control && confirmed.version === control.version && confirmed.incidentId === control.activeIncidentId && confirmed.accountId === (targetAccountId === 'all' ? null : targetAccountId) && JSON.stringify(confirmed.capabilities) === JSON.stringify(selectedCapabilities))

  /** 確認の言葉が合ったら本人確認へ進む。二重押しは実行中ロックで止める。 */
  const proceedToStepUp = () => {
    if (!access.canRun() || mutationLocked || !confirmMode || !confirmationCurrent()) return
    if (confirmWord !== (confirmMode === 'stop' ? '停止' : '復旧')) return
    setStepUpMode(confirmMode)
    setConfirmMode(null)
    setConfirmWord('')
  }

  /** 板 （1枚の確認窓）で止められる条件。理由・言葉・番号の1つでも欠けたら止まる。 */
  const stopCodeOk = stepUpMethod === 'none'
    ? true
    : stepUpMethod === 'password'
      ? stopPassword.length > 0
      : /^\d{6}$/.test(stopCode)
  const canRunStop = confirmMode === 'stop'
    && canControl && !mutationLocked && !running
    && reason.trim().length > 0
    && confirmWord === '停止'
    && stopCodeOk

  const closeConfirm = () => {
    if (mutationLocked || running) return
    setConfirmMode(null)
    setConfirmed(null)
    setConfirmWord('')
    setStopCode('')
    setStopPassword('')
  }

  /** 確認の窓の足（右寄せの2ボタン）。2段に書くと直書き扱いが増えるので1つにまとめる。 */
  const ConfirmActions = ({ children }: { children: React.ReactNode }) => (
    <DialogActions>{children}</DialogActions>
  )

  const runStop = async (code: string) => {
    if (!access.canRun() || mutationLock.current || mutationLocked || !control || !confirmed || !requestKey || stepUpMethod === 'none' || !confirmationCurrent()) return
    const isCurrent = access.capture()
    mutationLock.current = true
    setRunning(true)
    setStepUpError('')
    setFeedback(null)
    try {
      const grant = await api.operations.stepUp({ method: stepUpMethod === 'password' ? 'password' : 'totp', value: code })
      if (!isCurrent()) return
      if (!grant.success) throw new Error(grant.error)
      const response = await api.operations.stop({
        lineAccountId: confirmed.accountId,
        capabilities: confirmed.capabilities,
        reason: reason.trim(),
        // WEB313：入力欄の補足をそのまま送る（空なら null）。
        detail: reasonDetail.trim() || null,
        confirmation: '停止',
        expectedVersion: confirmed.version,
      }, grant.data.token, requestKey)
      if (!isCurrent()) return
      if (!response.success) throw new Error(response.error)
      setControl(response.data.control)
      setNeedsReload(false)
      setFeedback({ tone: 'success', text: 'サーバー共通の停止状態を更新しました。別の端末にも同じ状態が表示されます。' })
      setConfirmMode(null)
      setStepUpMode(null)
      setConfirmWord('')
      setStopCode('')
      setStopPassword('')
      setRequestKey('')
      void loadPreview(targetAccountId === 'all' ? null : targetAccountId, ++previewGeneration.current)
    } catch (error) {
      if (!isCurrent()) return
      if (error instanceof ApiError && error.status === 409 && error.code === 'VERSION_CONFLICT') {
        applySafety('conflict')
      } else if (error instanceof ApiError && error.status === 403) {
        applySafety('forbidden')
        setCanControl(false)
        setBlockedCode(error.code ?? null)
        setFeedback({ tone: 'warning', text: blockedText(error.code) ?? 'この操作を行う権限がありません。オーナーに確認してください。' })
      } else {
        applySafety('operation-failed')
        setFeedback({ tone: 'danger', text: failureText(error, '緊急停止を保存できませんでした。最新の停止状態を読み直して、もう一度確認してください。') })
      }
    } finally {
      mutationLock.current = false
      setRunning(false)
    }
  }

  const runRestore = async (code: string) => {
    if (!access.canRun() || mutationLock.current || mutationLocked || !control?.activeIncidentId || !confirmed?.incidentId || !requestKey || stepUpMethod === 'none' || !confirmationCurrent()) return
    const isCurrent = access.capture()
    mutationLock.current = true
    setRunning(true)
    setStepUpError('')
    setFeedback(null)
    try {
      const grant = await api.operations.stepUp({ method: stepUpMethod === 'password' ? 'password' : 'totp', value: code })
      if (!isCurrent()) return
      if (!grant.success) throw new Error(grant.error)
      const response = await api.operations.restore(confirmed.incidentId, {
        confirmation: '復旧',
        expectedVersion: confirmed.version,
      }, grant.data.token, requestKey)
      if (!isCurrent()) return
      if (!response.success) throw new Error(response.error)
      setControl(response.data.control)
      setNeedsReload(false)
      const report = response.data.report
        ? describeRestoreResult(response.data.report)
        : { tone: 'success' as const, text: 'サーバー共通の停止状態を復旧しました。' }
      setFeedback({ tone: report.tone === 'warning' ? 'warning' : 'success', text: report.text })
      setStepUpMode(null)
      setRequestKey('')
      void loadPreview(targetAccountId === 'all' ? null : targetAccountId, ++previewGeneration.current)
    } catch (error) {
      if (!isCurrent()) return
      if (error instanceof ApiError && error.status === 409 && error.code === 'VERSION_CONFLICT') {
        applySafety('conflict')
      } else if (error instanceof ApiError && error.status === 409 && error.code === 'OPERATION_RESTORE_BLOCKED') {
        const report = (error.data as { report?: { drift?: OperationRestoreDrift } } | undefined)?.report
        const reasons = report?.drift ? describeRestoreBlockers(report.drift) : []
        setStepUpMode(null)
        setFeedback({
          tone: 'danger',
          text: [failureText(error, '停止中の変更があるため復旧を止めました。'), ...reasons].join(' '),
        })
      } else if (error instanceof ApiError && error.status === 403) {
        applySafety('forbidden')
        setCanControl(false)
        setBlockedCode(error.code ?? null)
        setFeedback({ tone: 'warning', text: blockedText(error.code) ?? 'この操作を行う権限がありません。オーナーに確認してください。' })
      } else {
        applySafety('operation-failed')
        setFeedback({ tone: 'danger', text: failureText(error, '復旧できませんでした。最新の停止状態を読み直して、もう一度確認してください。') })
      }
    } finally {
      mutationLock.current = false
      setRunning(false)
    }
  }

  /*
   * 止められない理由は黙ってボタンを薄くするだけにしない。理由ごとに
   * 運用者向け文言と次の行動を出す。初回の取得が終わるまでは出さない。
   */
  type StopBlocker = 'unavailable' | 'forbidden' | 'scope' | 'empty' | 'stopped'
  const stopBlockers: StopBlocker[] = []
  if (previewSettled) {
    if (impactFailed) {
      stopBlockers.push(blockedCode === BLOCKED_CODES.scopeForbidden ? 'scope' : 'unavailable')
    } else if (!previewCanControl && blockedCode === BLOCKED_CODES.scopeForbidden) {
      stopBlockers.push('scope')
    }
    if (!impactFailed && selectedTargets.length === 0) stopBlockers.push('empty')
    if (isStopped) stopBlockers.push('stopped')
  }

  const stopIncident = operations.find((item) => item.id === control?.activeIncidentId) ?? null
  const recordRows = operations.filter(entry => recordFilter === 'all' || entry.status === recordFilter)
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECORD_LIMIT)

  const stopDisabled = !canControl || mutationLocked || isStopped || selectedTargets.length === 0
  const reportedAllowed = impact !== null && control !== null && !impactFailed ? canControl : null
  useEffect(() => {
    onAccessChange?.({ allowed: reportedAllowed, stopDisabled, lockedReason })
  }, [onAccessChange, reportedAllowed, stopDisabled, lockedReason])

  return (
    <div data-design-node="OHwbU" className={styles.board}>
      <FormLeaveGuard dirty={!isStopped && Boolean(reason.trim() || reasonDetail.trim() || targetAccountId !== defaultTargetAccountId || JSON.stringify(targets) !== JSON.stringify({ broadcasts: true, scenarios: true, reminders: true, automations: false }))} busy={mutationLocked} />
      {/* 外側がある入口では、題の下のnoticeへ1回だけ渡す。 */}
      {!onAccessChange && lockedReason ? <ReadOnlyNotice need="feature" /> : null}

      <EmergencyControlFeedback message={feedback} needsReload={needsReload} reloading={reloading} stopBlockers={stopBlockers} onReload={() => void reloadControl()} />

      {/* 数の帯。取れていない数字は「—」（0 とは言わない）。 */}
      <KpiBand aria-label="緊急停止の集計">
        <KpiCard title="緊急停止状態" icon={<ShieldCheck size={16} />} value={null} unit=""
          valueText={previewSettled && control ? (isStopped ? '停止中' : '有効') : emptyValue('unknown')}
          valueTone={isStopped ? 'danger' : 'default'}
          detail={impactFailed && !control ? '確認できませんでした' : calculatedAt ? `${formatOperationDate(calculatedAt)}に確認` : '確認中'} />
        <KpiCard title="止めた回数" icon={<OctagonPause size={16} />} value={historyState === 'ready' ? recent90.length : null} unit="回" detail="この90日" />
        <KpiCard title="最長の停止" icon={<Timer size={16} />} value={historyState === 'ready' && longest.entry ? longest.minutes : null} unit="分"
          detail={longest.entry ? `${formatMonthDay(longest.entry.stoppedAt)} ${longest.entry.reason.slice(0, 8)}` : '記録なし'} />
        <KpiCard title="いまの版" icon={<GitBranch size={16} />} value={null} unit="" valueText={runningVersion.detail?.version ?? emptyValue('unknown')}
          detail={runningVersion.statusText} />
      </KpiBand>

      <section className={styles.card} aria-labelledby="emergency-targets-heading">
        <h2 id="emergency-targets-heading" className={styles.cardTitle}>何を止めますか</h2>
        <p className={styles.cardNote}>選んだものだけを止めます。止めると、予約中の一斉配信は下書きに戻ります。</p>
        {/* 絵：止めるものは1行に並べる。何と何人に関わるかは、押す前に確認の窓で実測を見せる（行の上では title）。 */}
        <div className={styles.targetRow} role="group" aria-label="止めるもの">
          {(Object.keys(targetLabels) as StopTarget[]).map((key) => (
            <span key={key} className={styles.targetItem} title={`${targetLabels[key].note}・${impactText(key)}`}>
              <SaveErrorField names={["targets"]}><Checkbox
                checked={targets[key]}
                onCheckedChange={(checked) => { if (access.canRun()) setTargets((current) => ({ ...current, [key]: checked })) }}
                disabled={mutationLocked || isStopped || !canControl}
              >
                {targetLabels[key].label}
              </Checkbox></SaveErrorField>
            </span>
          ))}
        </div>
        <div className={styles.accountRow}>
          <div className={styles.accountField}><Field label="止めるアカウント" htmlFor="emergency-account-v8"><span className={styles.accountSelect}>
            <SaveErrorField names={["targetAccountId","impact","target_account_id"]}><EntitySelect
              size="full"
              id="emergency-account-v8"
              value={targetAccountId}
              onChange={(value) => {
                if (!selectTarget(value)) return
                access.invalidate()
                previewGeneration.current += 1
                setImpact(null)
                setImpactFailed(false)
                setControl(null)
                setCanControl(false)
                setBlockedCode(null)
                setCalculatedAt(null)
              }}
              disabled={mutationLocked || isStopped}
              aria-label="緊急停止の対象アカウント"
              options={[
                { value: 'all', label: 'すべてのアカウント', disabled: staffRole !== 'owner', description: staffRole === 'owner' ? undefined : 'すべてのアカウントの確認と操作はオーナーだけができます。' },
                ...accounts.map((account) => ({ ...entityOptionMetadata(account), value: account.id, label: `${account.name}（いまのアカウント）` })),
              ]}
            /></SaveErrorField>
            </span></Field></div>
          <Button
            type="button"
            variant="danger"
            onClick={openStopConfirm}
            lockedReason={lockedReason}
            disabled={mutationLocked || isStopped || impactFailed || !impact || !control || !canControl}
          >
            選んだものを止める
          </Button>
        </div>

        {isStopped && control ? (
          <Notice tone="warn" role="status" heading={<>止めているとき</>}>
            <div className={styles.stoppedLine}>
              <p className={styles.stoppedText}>
                <span className={styles.stoppedDot}>● </span>
                止めている　{formatStopRange(control.stoppedAt, null)}から・{control.actorId ?? '担当者不明'}・
                {(stopIncident?.capabilities ?? selectedCapabilities).map((capability) => CAPABILITY_LABEL[capability]).join('・')}
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={openRestoreConfirm}
                lockedReason={lockedReason}
                disabled={mutationLocked || !canControl}
              >
                復旧する
              </Button>
            </div>
            <p className={styles.stoppedNote}>
              復旧するとき：止める前に動いていたものだけを戻します。理由を書いて、本人確認（6桁）をしてから戻します。
            </p>
          </Notice>
        ) : (
          /* 絵：止めているときの帯の置き場は、動いているあいだも空けておく（止めると、ここに時刻・担当・止めたものと「復旧する」が出る）。 */
          <div className={styles.stoppedBand}>
            <p className={styles.stoppedTitle}>止めているとき</p>
            <div className={styles.stoppedLine}>
              {control ? (
                <p className={styles.stoppedText}>いまは止めていません。止めると、ここに止めた時刻・担当・止めたものが出ます。</p>
              ) : impactFailed ? (
                <>
                  {/* WEB312：読めていないのに「止めていません」と言わない。読み直しを出す。 */}
                  <p className={styles.stoppedText}>いまの停止状態を確認できませんでした。読み直してください。</p>
                  <Button type="button" variant="secondary" onClick={() => void reloadControl()} busyLabel="読み直しています…" disabled={reloading}>
                    読み直す
                  </Button>
                </>
              ) : (
                <p className={styles.stoppedText}>いまの停止状態を確認しています。</p>
              )}
            </div>
            <p className={styles.stoppedNote}>
              復旧するとき：止める前に動いていたものだけを戻します。理由を書いて、本人確認（6桁）をしてから戻します。
            </p>
          </div>
        )}
      </section>

      <div className={styles.infoGrid}>
        <section className={styles.card} aria-labelledby="emergency-after-stop-heading">
          <h2 id="emergency-after-stop-heading" className={styles.cardTitle}>止めるとどうなるか</h2>
          <ul className={styles.infoList}>
            <li>予約中の一斉配信は下書きに戻ります</li>
            <li>止めているあいだ配信は出せません</li>
            <li>停止前にすでに LINE へ渡したものは取り消せません</li>
            <li>止めたことは、ログインユーザー全員の LINE とメールへ知らせます</li>
          </ul>
        </section>
        <section className={styles.card} aria-labelledby="emergency-next-heading">
          <h2 id="emergency-next-heading" className={styles.cardTitle}>止めたあとにすること</h2>
          <ul className={styles.infoList}>
            <li>止める前に動いていたものだけを戻します</li>
            <li>変更・追加があった配信は再開しません</li>
            <li>期限を過ぎた予約配信は戻りません（下書きへ）</li>
            <li>止めているあいだの時刻ぶんは、戻しても送りません</li>
          </ul>
        </section>
      </div>

      <section aria-labelledby="emergency-records-heading">
        <h2 id="emergency-records-heading" className={styles.cardTitle}>止めた・戻した記録</h2>
        <Tabs size="compact" wrap label="運用記録の種類（取得した直近の記録）" items={[{ key: 'all', label: 'すべて' }, { key: 'failed', label: '失敗' }, { key: 'stopped', label: '停止中' }, { key: 'resolved', label: '戻した' }].map(item => ({ label: item.label, count: historyState === 'ready' ? operations.filter(entry => item.key === 'all' || entry.status === item.key).length : undefined, current: recordFilter === item.key, onClick: () => setRecordFilter(item.key) }))} />
        {historyState === 'loading' ? (
          <div className={styles.card} style={{ marginTop: 12 }} aria-busy="true" aria-label="止めた・戻した記録を読み込んでいます">
            <DelayedSkeleton
              loading
              skeleton={(
                <div aria-hidden="true">
                  <div style={{ display: 'flex', gap: 24, padding: '12px 16px' }}>
                    <Skeleton height={12} width={40} />
                    <Skeleton height={12} width={60} />
                    <Skeleton height={12} width={40} />
                    <Skeleton height={12} width={40} />
                    <Skeleton height={12} width={70} />
                    <Skeleton height={12} width={120} />
                  </div>
                  {[0, 1, 2].map((row) => (
                    <div key={row} style={{ display: 'flex', gap: 16, padding: '12px 16px', borderTop: '1px solid var(--color-hairline)' }}>
                      <Skeleton height={14} width={120} />
                      <Skeleton height={14} width={80} />
                      <Skeleton height={14} width={100} />
                      <Skeleton height={14} width={90} />
                      <Skeleton height={14} width={60} />
                      <Skeleton height={14} width={110} />
                    </div>
                  ))}
                </div>
              )}
            />
          </div>
        ) : historyState === 'error' ? (
          <div className={styles.card} style={{ marginTop: 12 }}>
            <ListState kind="error" title="記録を読み込めませんでした" description="履歴なしとは扱いません。" />
          </div>
        ) : recordRows.length === 0 ? (
          <div className={styles.card} style={{ marginTop: 12 }}>
            <ListState kind="empty" title="この期間の記録はありません" />
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">いつ</th>
                  <th scope="col">だれが</th>
                  <th scope="col">何を</th>
                  <th scope="col">なぜ</th>
                  <th scope="col">止めた時間</th>
                  <th scope="col">下書きに戻った配信</th>
                </tr>
              </thead>
              <tbody>
                {recordRows.map((entry) => {
                  const minutes = stopMinutes(entry.stoppedAt, entry.resolvedAt)
                  return (
                    <tr key={entry.id}>
                      <td title={formatStopRange(entry.stoppedAt, entry.resolvedAt)} className={styles.cellTruncate}>
                        {formatStopRange(entry.stoppedAt, entry.resolvedAt)}
                      </td>
                      {/* 「名前（役割・所属）」は名前だけを出し、全文は title（絵 OHwbU は名前だけ）。 */}
                      <td title={entry.actorId} className={styles.cellTruncate}>{entry.actorId.split('（')[0].trim() || entry.actorId}</td>
                      <td title={entry.capabilities.map((capability) => CAPABILITY_LABEL[capability]).join('・')} className={styles.cellTruncate}>
                        {entry.capabilities.length > 3 ? `${entry.capabilities.slice(0, 3).map(capabilityShort).join('・')} ほか${entry.capabilities.length - 3}` : entry.capabilities.map(capabilityShort).join('・')}
                      </td>
                      <td title={entry.detail ? `${entry.reason}（${entry.detail}）` : entry.reason} className={styles.cellTruncate}>
                        <RowNameButton onClick={() => setRecordEntry({ occurredAt: entry.createdAt, target: entry.lineAccountId ?? 'すべてのアカウント', status: entry.status === 'failed' ? '失敗' : entry.status === 'resolved' ? '戻した' : '停止中', reason: entry.reason })}>{entry.reason || '中身を見る'}</RowNameButton>
                      </td>
                      <td>{minutes === null ? emptyValue('unknown') : formatMinutesRough(minutes)}</td>
                      <td>{emptyValue('unknown')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <Notice tone="info">
          {historyState === 'ready' ? `種類の件数は、取得した直近${formatNumber(operations.length)}件の記録から数えています。` : ''}
          だれが、いつ、何を止めたかが残ります。通常の管理者は消せません。緊急停止はオーナーと許可された人だけが実行できます。

        </Notice>
      </section>

      <LogEntryDetails canCopy entry={recordEntry} onClose={() => setRecordEntry(null)} />
      {/* 送る経路の網羅（止めると止まる経路）。絵の外なので記録の下に置く。 */}
      {canReadTarget ? <SendPathCoveragePanel accountId={targetAccountId === 'all' ? null : targetAccountId} revision={control?.version ?? 0} /> : null}

      {/* 確認の窓：止めるときは板 `EA8rM` の1枚（対象・理由必須・言葉・番号）。戻すときは今までどおり。 */}
      <Dialog
        open={confirmMode !== null}
        busy={mutationLocked}
        designNode={confirmMode === 'stop' ? 'EA8rM' : 'OHwbU-confirm'}
        tone="default" role={confirmMode === 'stop' ? 'alertdialog' : 'dialog'} contentLayout="form" confirmation
        designTop={confirmMode === 'stop' ? 24 : undefined} fitViewport
        title={confirmMode === 'stop' ? '緊急停止を確認' : '止める前の状態に戻しますか？'}
        description={confirmMode === 'stop'
          ? '止める前に、何と何人に関わるかを実測で確かめました。'
          : '停止前に動いていたものだけを戻します。期限を過ぎた予約は自動では送りません。'}
        onCancel={closeConfirm}
        footer={confirmMode === 'stop' ? (
          <ConfirmActions>
            <Button type="button" onClick={closeConfirm} disabled={mutationLocked || running}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => void runStop(stepUpMethod === 'password' ? stopPassword : stopCode)}
              lockedReason={lockedReason}
              disabled={!canRunStop} title={mutationLocked || running ? '処理中です。' : !canRunStop ? '止める理由、確認の言葉、本人確認を入力してください。' : undefined}
            >
              緊急停止する
            </Button>
          </ConfirmActions>
        ) : (
          <ConfirmActions>
            <Button type="button" onClick={closeConfirm} disabled={mutationLocked}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={proceedToStepUp}
              lockedReason={lockedReason}
              disabled={!canControl || mutationLocked || confirmWord !== '復旧'} title={mutationLocked ? '処理中です。' : confirmWord !== '復旧' ? '確認の言葉に「復旧」と入力してください。' : undefined}
            >
              復旧を実行する
            </Button>
          </ConfirmActions>
        )}
      >
        {confirmed ? <OperationTargetSummary accounts={confirmed.accountId === null ? [] : [{ id: confirmed.accountId, name: confirmed.name }]} allAccounts={confirmed.accountId === null} /> : null}
        <div>
          {confirmMode === 'stop' ? (
            <>
              <Card surface="muted" corner="control" contentPadding="var(--polish-space-field)" gap="tight">
                <p>止める対象：{selectedTargets.map((key) => `${targetLabels[key].label} ${impactText(key)}`).join('・')}</p>
              </Card>
              <DialogFormRow><Field label="止める理由" htmlFor="emergency-reason-v8" required><SaveErrorField names={["reason"]}><TextField
                id="emergency-reason-v8"
                aria-label="止める理由"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={!canControl || mutationLocked || running}
                maxLength={200}
                placeholder="例：宛先の絞り込みを間違えた"
              /></SaveErrorField></Field></DialogFormRow>
              <DialogFormRow><Field label="補足" htmlFor="emergency-detail-v8" optional note={`あと${1000 - reasonDetail.length}文字`}>
                <SaveErrorField names={["reasonDetail","detail","reason_detail"]}><SharedTextArea
                  id="emergency-detail-v8"
                  value={reasonDetail}
                  onChange={(event) => setReasonDetail(event.target.value)}
                  disabled={!canControl || mutationLocked || running}
                  rows={2}
                  maxLength={1000}
                  placeholder="発生していることを短く入力"
                  className={styles.detailTextarea}
                /></SaveErrorField>
              </Field></DialogFormRow>
            </>
          ) : (
            <>
              {restoreDrift && describeRestoreDrift(restoreDrift).length > 0 ? (
                  <Notice tone="warn">
                    <p className={styles.dialogLabel}>停止しているあいだに変わったものがあります</p>
                    <ul className={styles.infoList}>
                      {describeRestoreDrift(restoreDrift).map((line) => <li key={line}>{line}</li>)}
                    </ul>
                    <p className={styles.dialogHint}>変更・追加があった配信は再開しません。期限切れの予約は下書きへ戻します。</p>
                  </Notice>
              ) : null}
            </>
          )}
          <DialogFormRow>
            <p>確認のため「{confirmMode === 'stop' ? '停止' : '復旧'}」と入力してください</p>
            <Field label="確認の文字" required><SaveErrorField names={["confirmWord","confirm_word"]}><TextField
              value={confirmWord}
              onChange={(event) => setConfirmWord(event.target.value)}
              disabled={!canControl || mutationLocked || running}
              aria-label="確認の言葉"
            /></SaveErrorField></Field></DialogFormRow>
          {confirmMode === 'stop' && stepUpMethod !== 'none' ? (
            <div className={styles.dialogField}>
              <span className={styles.dialogLabel} id="emergency-stepup-label">
                {stepUpMethod === 'password' ? '本人確認（パスワード）' : '本人確認（認証アプリの6桁）'}
              </span>
              {stepUpMethod === 'password' ? (
                <SaveErrorField names={["stopPassword","stop_password"]}><SharedTextField
                  type="password"
                  aria-label="パスワード"
                  value={stopPassword}
                  onChange={(event) => setStopPassword(event.target.value)}
                  disabled={!canControl || mutationLocked || running}
                  autoComplete="current-password"
                  className={styles.dialogInput}
                  style={{ maxWidth: '100%' }}
                /></SaveErrorField>
              ) : (
                <SaveErrorField names={["stopCode"]}><OtpInput
                  value={stopCode}
                  onChange={setStopCode}
                  labelledBy="emergency-stepup-label"
                  busy={running}
                  disabled={!canControl || mutationLocked}
                /></SaveErrorField>
              )}
            </div>
          ) : null}
          {confirmMode === 'stop' ? <DialogFormRow><Notice tone="warn" appearance="soft" icon={null}>
            停止前にすでに LINE へ渡したものは取り消せません。止めたことはログインユーザー全員に知らせます。
            <span>止まらないもの：{targets.automations ? '受信箱からの手の返信と予約の受付は止まりません。' : '自動処理／受信箱からの手の返信／予約の受付は止まりません。'}</span>
          </Notice></DialogFormRow> : <p className={styles.dialogHint}>この操作は記録に残り、ログインユーザーへ通知されます。</p>}
        </div>
      </Dialog>

      {/* 本人確認の窓：二段階認証の人は6桁、無い人はパスワード。 */}
      <StepUpDialog
        open={stepUpMode !== null}
        action={stepUpMode === 'stop' ? '緊急停止する' : '復旧する'}
        method={stepUpMethod}
        busy={running}
        error={stepUpError || undefined}
        onSubmit={(code) => void (stepUpMode === 'stop' ? runStop(code) : runRestore(code))}
        onCancel={() => {
          if (!running) {
            setStepUpMode(null)
            setStepUpError('')
          }
        }}
      />

    </div>
  )
}

export default forwardRef<EmergencyControlV8Handle, EmergencyControlProps>(EmergencyControlV8)
