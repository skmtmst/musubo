'use client'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  createName: requiredText("名前を入力してください"),
}

import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import CopyTextButton from '@/components/shared/copy-text-button'
import { useSearchParams } from 'next/navigation'
import { LayoutTemplate, Plus, RefreshCw, Trash2, FlaskConical, Inbox, Copy } from 'lucide-react'
import type { IncomingWebhook } from '@line-crm/shared'
import { api, ApiError, type IncomingWebhookDetail as DetailType, type IncomingWebhookTestResult, type IncomingWebhookUnmatchedItem } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useOnAccountSwitch } from '@/components/shared/list-url-state'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { ListPage } from '@/components/templates'
import Button from '@/components/shared/button'
import StatusBadge from '@/components/shared/status-badge'
import Card from '@/components/shared/card'
import { ActionCell, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { TextField, TextArea } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import EmptyList from '@/components/shared/empty-list'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import AccountRequiredState from '@/components/shared/account-required-state'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import Toggle from '@/components/shared/toggle'
import InlineEdit from '@/components/shared/inline-edit'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { notifyToast } from '@/components/shared/toast'
import { withViewTransition } from '@/components/shared/view-transition'
import { describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import { MANAGE_REASON, ViewerBand, WEBHOOKS_DESCRIPTION, WebhookBand, WebhookTabs, useWebhookOverview } from './shell'
import { MIN_SECRET_LENGTH, generateSecret } from './secret'
import { shortDateTime } from './words'
import { useWebhookWriteAccess, canManageWebhooksNow, captureWebhookWriteAccess } from './write-access'
import styles from './incoming.module.css'
import { useInitialWebhookSource } from './use-initial-source'
import TruncatedText from '@/components/shared/truncated-text'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import IncomingActions from './incoming-actions'
import { formatNumber } from '@/lib/format'

/*
 * ★V8 外部連携「こちらで受け取る」タブ（Pencil 、作る窓 ）。
 *
 * 左に受け取り口の列（上に「受け取り口を作る」）、右に選んだ口の設定カード
 * （どこから受け取るか・だれの出来事か・届いたらすること・人が見つからなかった
 * 届物・届いたつもりで試す）。データの口は 管理画面 と同じ（一覧・詳細・未照合の箱・
 * 試し・作成・動かす/止める・合言葉・名前・削除）。
 * 絵と今の作りが合わない所は BEHAVIOR.md に書いた。
 */

type LoadStatus = 'loading' | 'ready' | 'error'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
const UNMATCHED_PAGE_SIZE = 50

/* 「どこから来るか」の見本（管理画面 と同じ値）。見本に無いものは「その他（自分で書く）」。 */
const SOURCE_PRESETS = [
  { value: 'line', label: 'LINE公式アカウント' },
  { value: 'booking', label: '予約サービス' },
  { value: 'form', label: 'アンケートツール' },
  { value: 'ec', label: 'ECサイト' },
  { value: 'payment', label: '決済サービス' },
] as const
const SOURCE_OTHER = '__other__'

function sourceName(value: string): string {
  return SOURCE_PRESETS.find((preset) => preset.value === value)?.label ?? (value || 'その他')
}

function identityMatchingLabel(detail: DetailType | null): string {
  if (!detail || detail.identityMatching.methods.length === 0) return '照合しない'
  return detail.identityMatching.methods.map((method) => ({
    harness_friend_id: 'LINEの友だちIDで探す',
    external_customer_id: '相手の顧客IDで探す',
    verified_email: 'メールアドレスで探す',
    verified_phone: '電話番号で探す',
  }[method.kind] ?? '決めた値で探す')).join('・')
}

function notFoundLabel(value: DetailType['identityMatching']['onNotFound'] | undefined): string {
  switch (value) {
    case 'unmatched_box': return '未照合の箱に入れる'
    case 'create_candidate': return '友だち候補を作る'
    default: return '何もしない'
  }
}

function identityKindLabel(kind: string): string {
  return {
    harness_friend_id: 'LINEの友だちID',
    external_customer_id: '相手の顧客ID',
    verified_email: 'メールアドレス',
    verified_phone: '電話番号',
  }[kind] ?? kind
}

function incomingActionLabel(kind: string): string {
  return {
    tag: 'タグを付ける',
    scenario: 'シナリオを動かす',
    automation: 'オートメーションを動かす',
    conversion: '成果を記録する',
    template: 'テンプレートを送る',
  }[kind] ?? kind
}

function maskedSampleText(fields: NonNullable<DetailType['latestSample']>['fields']): string {
  return fields.map((field) => `  "${field.path}": (${field.type}・値は隠しています)`).join('\n')
}

export default function WebhooksIncomingV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('外部連携')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId, accounts } = useAccount()
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  const accountScopeRef = useRef({ accountId: selectedAccountId })
  if (accountScopeRef.current.accountId !== selectedAccountId) accountScopeRef.current = { accountId: selectedAccountId }
  const staffRole = useStaffRole()
  const management = useWebhookWriteAccess()
  const ownership = useWebhookWriteAccess(true)
  const canManage = management.allowed
  const canResolveUnmatched = canManageRole(staffRole)
  const searchParams = useSearchParams()

  const overview = useWebhookOverview()
  const { incoming, incomingStatus, loadedAccountId, reload } = overview

  const [error, setError] = useState('')
  const actionsGuard = useRef<((action: () => void) => void) | null>(null)
  const onActionsGuardReady = useCallback((guard: ((action: () => void) => void) | null) => { actionsGuard.current = guard }, [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailType | null>(null)
  const [detailStatus, setDetailStatus] = useState<LoadStatus>('loading')
  const [detailReloadKey, setDetailReloadKey] = useState(0)

  const [unmatched, setUnmatched] = useState<IncomingWebhookUnmatchedItem[]>([])
  const [unmatchedStatus, setUnmatchedStatus] = useState<LoadStatus>('ready')
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [unmatchedActionError, setUnmatchedActionError] = useState<{ id: string; message: string } | null>(null)
  const [unmatchedTotal, setUnmatchedTotal] = useState<number | null>(null)
  const [unmatchedShown, setUnmatchedShown] = useState(UNMATCHED_PAGE_SIZE)
  const [unmatchedMoreBusy, setUnmatchedMoreBusy] = useState(false)
  const [unmatchedReloadKey, setUnmatchedReloadKey] = useState(0)

  const [testOpen, setTestOpen] = useState(false)
  const [testJson, setTestJson] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const [testError, setTestError] = useState('')
  const [testResult, setTestResult] = useState<IncomingWebhookTestResult | null>(null)

  const togglingRef = useRef<Set<string>>(new Set())
  const [togglingIds, setTogglingIds] = useState<string[]>([])
  const [optimisticActive, setOptimisticActive] = useState<Record<string, boolean>>({})

  const requestedSource = searchParams.get('source') ?? ''
  const initialSource = useInitialWebhookSource(requestedSource, SOURCE_PRESETS)
  const [showCreate, setShowCreate] = useState(initialSource !== '')
  const [createName, setCreateName] = useState('')
  const [createSource, setCreateSource] = useState<string>(initialSource || SOURCE_PRESETS[0].value)
  const [createSourceFree, setCreateSourceFree] = useState('')
  const [createSecret, setCreateSecret] = useState('')
  const [createFieldError, setCreateFieldError] = useState<{ name?: string; secret?: string; form?: string }>({})
  const [creating, setCreating] = useState(false)
  const [createdSecret, setCreatedSecret] = useState<{ name: string; secret: string } | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; confirmationRevision?: number; accountId: string; scope: object } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string; confirmationRevision?: number; accountId: string; scope: object } | null>(null)
  const [rotateSecret, setRotateSecret] = useState('')
  const [rotateError, setRotateError] = useState('')
  const [rotating, setRotating] = useState(false)
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const [nameDirty, setNameDirty] = useState(false)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameReset, setNameReset] = useState(0)
  const depth = useContext(OverlayDepthContext)
  const editingBusy = (showCreate && creating) || (rotateTarget !== null && rotating) || nameSaving
  const guard = useUnsavedGuard({
    dirty: Boolean((showCreate && (createName || createSourceFree || createSecret || createSource !== (initialSource || SOURCE_PRESETS[0].value))) || (rotateTarget && rotateSecret) || nameDirty || editingBusy),
    busy: editingBusy,
    subject: '受け取り口の変更',
    onDiscard: () => {
      if (showCreate) { setShowCreate(false); setCreateName(''); setCreateSource(initialSource || SOURCE_PRESETS[0].value); setCreateSourceFree(''); setCreateSecret('') }
      if (rotateTarget) { setRotateTarget(null); setRotateSecret('') }
      setStepUp(null)
      setNameDirty(false)
      setNameReset(value => value + 1)
    },
  })

  // 初回の null → アカウントは見本の選択を保ち、実際に店を替えたときだけ消す。
  useOnAccountSwitch(selectedAccountId, () => {
    setShowCreate(false)
    setNameDirty(false)
    setNameSaving(false)
    setNameReset(value => value + 1)
    setCreateName('')
    setCreateSource(SOURCE_PRESETS[0].value)
    setCreateSourceFree('')
    setCreateSecret('')
    setCreateFieldError({})
    setCreating(false)
    setCreatedSecret(null)
    setDeleteTarget(null)
    setDeleting(false)
    setDeleteError('')
    setRotateTarget(null)
    setRotating(false)
    setRotateSecret('')
    setRotateError('')
    setStepUp(null)
    setOptimisticActive({})
    togglingRef.current.clear()
    setTogglingIds([])
  })

  useEffect(() => {
    if (staffRole !== null && !canManageRole(staffRole)) setShowCreate(false)
  }, [staffRole])

  const displayed = useMemo(() => incoming.map((item) => (
    optimisticActive[item.id] === undefined ? item : { ...item, isActive: optimisticActive[item.id] }
  )), [incoming, optimisticActive])
  const selected = displayed.find((item) => item.id === selectedId) ?? displayed[0] ?? null
  const selectedDetailId = selected?.id ?? null
  const endpointUrl = (id: string) => `${API_BASE}/api/webhooks/incoming/${id}/receive`

  useEffect(() => {
    if (selectedId && !incoming.some((item) => item.id === selectedId)) setSelectedId(null)
  }, [incoming, selectedId])

  /* ===== 選んだ口の詳細 ===== */
  useEffect(() => {
    let cancelled = false
    setDetail(null)
    if (!selectedDetailId || !selectedAccountId) {
      setDetailStatus('ready')
      return () => { cancelled = true }
    }
    setDetailStatus('loading')
    void api.webhooks.incoming.detail(selectedDetailId, selectedAccountId)
      .then((response) => {
        if (cancelled) return
        if (!response.success) {
          setDetailStatus('error')
          return
        }
        setDetail(response.data)
        setDetailStatus('ready')
      })
      .catch(() => { if (!cancelled) setDetailStatus('error') })
    return () => { cancelled = true }
  }, [detailReloadKey, selectedAccountId, selectedDetailId])

  /* ===== 人が見つからなかった届物 ===== */
  useEffect(() => {
    let cancelled = false
    if (!selectedDetailId || !selectedAccountId || detailStatus !== 'ready') return
    if (unmatched.length === 0) setUnmatchedStatus('loading')
    void api.webhooks.incoming.unmatched(selectedDetailId, selectedAccountId, undefined, { limit: unmatchedShown })
      .then((response) => {
        if (cancelled) return
        if (!response.success) {
          setUnmatchedStatus('error')
          return
        }
        setUnmatched(response.data)
        setUnmatchedTotal(response.total ?? null)
        setUnmatchedStatus('ready')
      })
      .catch(() => { if (!cancelled) setUnmatchedStatus('error') })
      .finally(() => { if (!cancelled) setUnmatchedMoreBusy(false) })
    return () => { cancelled = true }
  }, [detailStatus, selectedAccountId, selectedDetailId, unmatchedShown, unmatchedReloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setUnmatched([])
    setUnmatchedTotal(null)
    setUnmatchedShown(UNMATCHED_PAGE_SIZE)
    setUnmatchedActionError(null)
    setUnmatchedStatus('ready')
  }, [selectedAccountId, selectedDetailId])

  const selectInlet = (id: string) => requestUnsavedAction(() => withViewTransition(() => setSelectedId(id)))
  const moveSelection = (delta: -1 | 1) => {
    if (displayed.length === 0) return
    const current = selected ? displayed.findIndex((item) => item.id === selected.id) : -1
    const next = current === -1
      ? (delta === 1 ? 0 : displayed.length - 1)
      : Math.min(displayed.length - 1, Math.max(0, current + delta))
    const target = displayed[next]
    if (target && target.id !== selected?.id) selectInlet(target.id)
  }

  /* 名前のその場の書き換え。失敗したら投げて元に戻す（共通部品の約束）。 */
  const renameInlet = async (next: string) => {
    if (!canManageWebhooksNow()) throw new Error(management.reason ?? '担当者の確認が終わるまでお待ちください。')
    const accountId = selectedAccountId
    const target = selected
    if (!accountId || accountRef.current !== accountId || !target) throw new Error('no target')
    const trimmed = next.trim()
    if (!trimmed) throw new Error('empty name')
    const res = await api.webhooks.incoming.update(target.id, accountId, { name: trimmed })
    if (accountRef.current !== accountId) throw new Error('stale account')
    if (!res.success) throw new Error(res.error)
    await reload()
  }

  /* ===== 動かす・止める（押した瞬間に変え、裏で保存する） ===== */
  const handleToggle = async (item: IncomingWebhook, currentActive: boolean) => {
    if (!canManageWebhooksNow()) { setError(management.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const accountId = selectedAccountId
    const scope = accountScopeRef.current
    const isCurrent = () => accountScopeRef.current === scope
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId) {
      setError('LINEアカウントの一覧を読み直してください')
      return
    }
    if (togglingRef.current.has(item.id)) {
      notifyToast(`「${item.name}」：いま切り替えを送っています。返事が来るまでお待ちください。`)
      return
    }
    togglingRef.current.add(item.id)
    setTogglingIds((current) => [...current, item.id])
    setOptimisticActive((current) => ({ ...current, [item.id]: !currentActive }))
    const clear = () => setOptimisticActive((current) => {
      const next = { ...current }
      delete next[item.id]
      return next
    })
    const fail = (message: string) => {
      clear()
      notifyToast(message, { tone: 'error', actionLabel: 'もう一度', onAction: () => { if (isCurrent()) void handleToggle(item, currentActive) } })
    }
    try {
      const res = await api.webhooks.incoming.update(item.id, accountId, { isActive: !currentActive })
      // 仮の表示は切替時に外してある。前の要求で新しい店の表示を触らない。
      if (!isCurrent()) return
      if (!res.success) {
        fail(`「${item.name}」は切り替えできませんでした。状態は変わっていません。確かめてから、もう一度お試しください。`)
        return
      }
      await reload()
      if (!isCurrent()) return
      clear()
      notifyToast(`「${item.name}」を${!currentActive ? '動かしました' : '止めました'}。`, {
        actionLabel: '元に戻す',
        onAction: () => { if (isCurrent()) void handleToggle(item, !currentActive) },
      })
    } catch (caught) {
      if (!isCurrent()) return
      saveErrors.capture(caught);

      const forbidden = caught instanceof ApiError && caught.status === 403
      fail(forbidden
        ? permissionDeniedMessage('store')
        : `「${item.name}」は切り替えに失敗しました。状態は変わっていません。時間をおいて、もう一度お試しください。`)
    } finally {
      if (isCurrent()) {
        togglingRef.current.delete(item.id)
        setTogglingIds((current) => current.filter((id) => id !== item.id))
      }
    }
  }

  // 409 の後は、確認した相手と版を同じアカウントの最新一覧で置き直す。
  const reloadConfirmedTarget = async (target: { id: string; accountId: string; scope: object }) => {
    try {
      const result = await api.webhooks.incoming.list(target.accountId)
      if (!result.success) throw new Error('reload failed')
      if (accountRef.current !== target.accountId || accountScopeRef.current !== target.scope) return undefined
      const item = result.data.find(entry => entry.id === target.id)
      await reload()
      if (accountRef.current !== target.accountId || accountScopeRef.current !== target.scope) return undefined
      return item ? { id: item.id, name: item.name, confirmationRevision: item.confirmationRevision, accountId: target.accountId, scope: target.scope } : null
    } catch {
      if (accountRef.current !== target.accountId || accountScopeRef.current !== target.scope) return undefined
      return { ...target, name: '', confirmationRevision: undefined }
    }
  }

  /* ===== 削除 ===== */
  const runDelete = async () => {
    if (!canManageWebhooksNow(true)) { setDeleteError(ownership.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    if (!deleteTarget || deleting) return
    if (!deleteTarget.confirmationRevision) { setDeleteError('この受け取り口を削除できませんでした。状態を読み直してから、もう一度お試しください。'); return }
    const accountId = deleteTarget.accountId
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId || accountScopeRef.current !== deleteTarget.scope) {
      setDeleteError('LINEアカウントが切り替わりました。削除する受け取り口を選び直してください。')
      return
    }
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.webhooks.incoming.delete(deleteTarget.id, accountId, deleteTarget.confirmationRevision)
      if (!res.success) throw new Error(res.error)
      if (accountRef.current !== accountId || accountScopeRef.current !== deleteTarget.scope) return
      setDeleteTarget(null)
      await reload()
    } catch (caught) {
      if (accountRef.current !== accountId || accountScopeRef.current !== deleteTarget.scope) return
      if (caught instanceof ApiError && caught.status === 409) {
        const latest = await reloadConfirmedTarget(deleteTarget)
        if (latest === undefined) return
        if (latest === null) { setDeleteTarget(null); notifyToast('受け取り口が見つかりません。一覧を確認してください。', { tone: 'error' }); return }
        setDeleteTarget({ ...latest, name: latest.name || deleteTarget.name })
        setDeleteError(latest.confirmationRevision ? '確認した内容が変わりました。読み直した対象を確認してください。' : '読み直せませんでした。窓を閉じて一覧を読み直してください。')
        return
      }
      const fieldFailure = saveErrors.capture(caught);

      const forbidden = caught instanceof ApiError && caught.status === 403
      { if (!fieldFailure)
      setDeleteError(forbidden
        ? permissionDeniedMessage('store')
        : 'この受け取り口を削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (accountScopeRef.current === deleteTarget.scope) setDeleting(false)
    }
  }

  /* ===== 合言葉を更新する ===== */
  const runRotate = async (stepUpToken?: string) => {
    if (!canManageWebhooksNow(true)) { setRotateError(ownership.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const canContinue = captureWebhookWriteAccess(true)
    if (rotating) return
    setRotateError('')
    if (!rotateTarget) return
    if (!rotateTarget.confirmationRevision) { setRotateError('LINEアカウントの一覧を読み直してください'); return }
    const accountId = rotateTarget.accountId
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId || accountScopeRef.current !== rotateTarget.scope) {
      setRotateError('LINEアカウントの一覧を読み直してください')
      return
    }
    if (rotateSecret.length < MIN_SECRET_LENGTH) {
      setRotateError(`合言葉は${MIN_SECRET_LENGTH}文字以上にしてください`)
      return
    }
    setRotating(true)
    try {
      const res = await api.webhooks.incoming.update(rotateTarget.id, accountId, { secret: rotateSecret, expectedConfirmationRevision: rotateTarget.confirmationRevision }, stepUpToken)
      if (accountRef.current !== accountId || accountScopeRef.current !== rotateTarget.scope) return
      if (!res.success) {
        setRotateError(res.error)
        return
      }
      setRotateTarget(null)
      setRotateSecret('')
      void reload()
    } catch (caught) {
      if (accountRef.current !== accountId || accountScopeRef.current !== rotateTarget.scope) return
      if (caught instanceof ApiError && caught.status === 409) {
        const latest = await reloadConfirmedTarget(rotateTarget)
        if (latest === undefined) return
        if (latest === null) { setRotateTarget(null); setRotateSecret(''); notifyToast('受け取り口が見つかりません。一覧を確認してください。', { tone: 'error' }); return }
        setRotateTarget({ ...latest, name: latest.name || rotateTarget.name })
        setRotateError(latest.confirmationRevision ? '確認した内容が変わりました。読み直した対象を確認してください。' : '読み直せませんでした。窓を閉じて一覧を読み直してください。')
        return
      }
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'webhook.secret', action: 'シークレットを更新する', retry: async (token) => { if (canContinue() && accountRef.current === accountId && accountScopeRef.current === rotateTarget.scope) return runRotate(token); setRotateError('権限やLINEアカウントが変わったため中止しました。') } });

        return
      }
      if (accountRef.current !== accountId) return
      { if (!fieldFailure)
      setRotateError(describeApiFailure(caught, 'シークレットの更新', {
        scope: 'store',
      })) }
    } finally {
      if (accountScopeRef.current === rotateTarget.scope) setRotating(false)
    }
  }

  /* ===== 受け取り口を作る（窓 ） ===== */
  const openCreate = () => guard.guarded(() => {
    if (!canManageWebhooksNow()) return
    setCreateFieldError({})
    if (!createSecret) setCreateSecret(generateSecret())
    setShowCreate(true)
  })
  const runCreate = async (stepUpToken?: string) => {
    if (!canManageWebhooksNow()) { setCreateFieldError({ form: management.reason ?? '担当者の確認が終わるまでお待ちください。' }); return }
    const canContinue = captureWebhookWriteAccess()
    setCreateFieldError({})
    const accountId = selectedAccountId
    if (!accountId || accountRef.current !== accountId) {
      setCreateFieldError({ form: 'LINEアカウントを選択してください' })
      return
    }
    const sourceValue = createSource === SOURCE_OTHER ? createSourceFree.trim() : createSource
    if ((FIELD_REQUIREMENTS.createName.check(createName) !== null)) {
      setCreateFieldError({ name: '名前を入力してください' })
      requestAnimationFrame(() => { const field = document.getElementById('wh-incoming-name'); field?.focus(); field?.scrollIntoView?.({ block: 'center' }) })
      return
    }
    if (createSecret.length < MIN_SECRET_LENGTH) {
      setCreateFieldError({ secret: `シークレットは${MIN_SECRET_LENGTH}文字以上にしてください` })
      requestAnimationFrame(() => { const field = document.getElementById('wh-incoming-secret'); field?.focus(); field?.scrollIntoView?.({ block: 'center' }) })
      return
    }
    setCreating(true)
    try {
      const res = await api.webhooks.incoming.create({
        lineAccountId: accountId,
        name: createName.trim(),
        sourceType: sourceValue || undefined,
        secret: createSecret,
      }, stepUpToken)
      if (accountRef.current !== accountId) return
      if (!res.success) {
        setCreateFieldError({ form: res.error })
        return
      }
      setCreatedSecret({ name: res.data.name, secret: res.data.secret })
      setCreateName('')
      setCreateSource(SOURCE_PRESETS[0].value)
      setCreateSourceFree('')
      setCreateSecret('')
      setShowCreate(false)
      await reload()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'webhook.secret', action: '受け取り口を登録する', retry: async (token) => { if (canContinue() && accountRef.current === accountId) return runCreate(token); setCreateFieldError({ form: '権限やLINEアカウントが変わったため中止しました。' }) } });

        return
      }
      if (accountRef.current !== accountId) return
      { if (!fieldFailure)
      setCreateFieldError({
        form: describeApiFailure(caught, '作成', {
          scope: 'store',
        }),
      }) }
    } finally {
      if (accountRef.current === accountId) setCreating(false)
    }
  }

  /* ===== 届物を結び付ける・確認した ===== */
  const reloadUnmatchedBox = () => {
    setUnmatchedReloadKey((key) => key + 1)
    setDetailReloadKey((key) => key + 1)
  }
  const resolveUnmatched = async (
    item: IncomingWebhookUnmatchedItem,
    payload: { action: 'dismiss' } | { action: 'link'; friendId: string },
  ) => {
    const accountId = selectedAccountId
    if (!accountId || dismissingId !== null) return
    setDismissingId(item.id)
    setUnmatchedActionError(null)
    try {
      const res = await api.webhooks.incoming.resolveUnmatched(item.id, accountId, payload)
      if (!res.success) {
        setUnmatchedActionError({ id: item.id, message: res.error || '保存できませんでした。一覧を読み直してから、もう一度お試しください。' })
        return
      }
      reloadUnmatchedBox()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) {
        reloadUnmatchedBox()
        { if (!fieldFailure)
        setUnmatchedActionError({ id: item.id, message: 'すでに処理済みです。最新の状態を読み直しました。' }) }
        return
      }
      if (caught instanceof ApiError) {
        { if (!fieldFailure)
        setUnmatchedActionError({
          id: item.id,
          message: describeApiFailure(caught, '確認', {
            scope: 'store',
          }),
        }) }
        return
      }
      reloadUnmatchedBox()
      { if (!fieldFailure)
      setUnmatchedActionError({ id: item.id, message: '結果が分かりませんでした。一覧を読み直しました。残っていれば、もう一度お試しください。' }) }
    } finally {
      setDismissingId(null)
    }
  }

  /* ===== 届いたつもりで試す ===== */
  const runTest = async () => {
    const accountId = selectedAccountId
    if (!accountId || !selectedDetailId || testBusy) return
    let payload: unknown
    try {
      payload = JSON.parse(testJson) as unknown
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setTestError('JSONの形が正しくありません。見本を確かめてください。') }
      return
    }
    setTestBusy(true)
    setTestError('')
    try {
      const res = await api.webhooks.incoming.test(selectedDetailId, accountId, payload)
      if (!res.success) {
        setTestError(res.error)
        setTestResult(null)
        return
      }
      setTestResult(res.data)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setTestError(describeApiFailure(caught, '試し', { scope: 'store' })) }
      { if (!fieldFailure)
      setTestResult(null) }
    } finally {
      setTestBusy(false)
    }
  }

  const sampleText = detail?.latestSample
    ? `{\n${maskedSampleText(detail.latestSample.fields)}\n}`
    : '{ "email": "kenta@example.com",\n"フォーム": "体験申込" }'

  /* ===== 左の列 ===== */
  const leftColumn = (
    <div
      className={styles.inletCol}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
        event.preventDefault()
        moveSelection(event.key === 'ArrowUp' ? -1 : 1)
      }}
    >
      <Button variant="primary" disabled={!canManage && !management.reason} lockedReason={management.reason} className={styles.createButton} onClick={openCreate}><Plus size={16} aria-hidden="true" />受け取り口を作る</Button>
      <p className={styles.inletListLabel}>受け取り口</p>
      {incomingStatus === 'loading' && selectedAccountId ? (
        <div aria-busy="true" aria-label="受け取り口を読み込んでいます">
          <DelayedSkeleton
            loading
            skeleton={(
              <div aria-hidden="true">
                {[0, 1, 2].map((row) => (
                  <div key={row} className={styles.inletItem}>
                    <Skeleton className={styles.skeletonName} />
                    <Skeleton className={styles.skeletonSub} />
                  </div>
                ))}
              </div>
            )}
          />
        </div>
      ) : null}
      {incomingStatus === 'error' ? (
        <ListState kind="error" title="受け取り口を読み込めませんでした" onRetry={() => void reload()} />
      ) : null}
      {displayed.map((item) => {
        const isSelected = selected?.id === item.id
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => selectInlet(item.id)}
            className={styles.inletItem}
            data-selected={isSelected || undefined}
            aria-current={isSelected || undefined}
            aria-label={`受け取り口「${item.name}」を見る`}
          >
            <span className={styles.inletRow}>
              <span className={styles.inletName}>{item.name}</span>
              <span className={styles.spacer} aria-hidden="true" />
              <span className={styles.inletState}>{item.isActive ? '有効' : '停止中'}</span>
            </span>
            <span className={styles.inletSub}>{sourceName(item.sourceType)}から</span>
          </button>
        )
      })}
    </div>
  )

  /* ===== 右の設定 ===== */
  let rightColumn
  if (!selectedAccountId) {
    rightColumn = <AccountRequiredState hasAccounts={accounts.length > 0} />
  } else if (incomingStatus === 'ready' && !selected) {
    /* 修正案 D-2：空の一覧。 */
    rightColumn = (
      <EmptyList
        icon={<Inbox aria-hidden="true" />}
        title="まだ受け取り口がありません"
        description="相手のサービスから届く知らせを受け取る URL を作ります。"
        create={{ label: '最初の受け取り口を作る', onClick: openCreate }}
        canCreate={canManage}
        lockedReason={management.reason ?? null}
      />
    )
  } else if (!selected) {
    rightColumn = null
  } else {
    const toggling = togglingIds.includes(selected.id)
    rightColumn = (
      <>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>
            <InlineEdit value={selected.name} label="受け取り口の名前" onSave={renameInlet} canSaveNow={canManageWebhooksNow} lockedReason={management.reason} preserveDirtyOnBlur onDirtyChange={setNameDirty} onSavingChange={setNameSaving} resetToken={nameReset} />
          </h2>
          <StatusBadge tone={toggling ? 'neutral' : selected.isActive ? 'success' : 'neutral'}>{toggling ? '切り替え中' : selected.isActive ? '有効' : '停止中'}</StatusBadge>
          <span className={styles.spacer} aria-hidden="true" />
          {<>
              <span className={styles.toggleLabel}>動かす</span>
              <SaveErrorField names={["isActive","selected.isActive","is_active","selected.is_active"]}><Toggle checked={selected.isActive} label={`${selected.name}を動かす`} disabled={!canManage && !management.reason} lockedReason={management.reason} onChange={() => void handleToggle(selected, selected.isActive)} /></SaveErrorField>
            </>}
        </div>

        <Card spacing="integration" aria-labelledby="wh-in-receive">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle} id="wh-in-receive">どこから受け取るか</h3>
            <p className={styles.cardNote}>相手のサービスで「Webhook（ウェブフック）」の送り先にこの URL を貼ります</p>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>受け取る URL（相手のサービスに貼る）</span>
              <span className={styles.valueBox} ><TruncatedText value={String(endpointUrl(selected.id) ?? '')} url /></span>
            </div>
            <CopyTextButton value={endpointUrl(selected!.id)} label="コピーする" variant="secondary" icon={<Copy size={16} aria-hidden="true" />} aria-label="受け取るURLをコピー" />
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>合言葉（署名）</span>
              <span className={styles.valueBox}>{selected.hasSecret ? '設定済み（再表示しません）' : 'まだ設定していません'}</span>
            </div>
            {<Button disabled={!ownership.allowed && !ownership.reason} lockedReason={ownership.reason} onClick={() => guard.guarded(() => { if (!canManageWebhooksNow(true) || !selectedAccountId || loadedAccountId !== selectedAccountId) return; setRotateError(''); setRotateSecret(''); setRotateTarget({ id: selected.id, name: selected.name, confirmationRevision: selected.confirmationRevision, accountId: selectedAccountId, scope: accountScopeRef.current }) })}>
                <RefreshCw size={16} aria-hidden="true" />合言葉を更新する
              </Button>}
          </div>
          <p className={styles.smallNote}>合言葉は人に見せないでください。知られると、第三者がデータを送れるようになります。</p>
          {selected.previousSecretUsableUntil ? (
            <p className={styles.smallNote}>前の合言葉は {shortDateTime(selected.previousSecretUsableUntil)} まで使えます。</p>
          ) : null}
        </Card>

        <Card spacing="integration" aria-labelledby="wh-in-identity">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle} id="wh-in-identity">だれの出来事か（人の見分けかた）</h3>
            <p className={styles.cardNote}>人が見つからないと何も起きません</p>
          </div>
          <div className={styles.pickGrid}>
            <div className={styles.field}>
              <span className={styles.pickLabel}>見分けに使う値</span>
              <span className={styles.pickBox}>
                {detailStatus === 'loading' ? '読み込んでいます' : detailStatus === 'error' ? '確認できませんでした' : identityMatchingLabel(detail)}
              </span>
            </div>
            <div className={styles.field}>
              <span className={styles.pickLabel}>見つからないとき</span>
              <span className={styles.pickBox}>
                {detailStatus === 'loading' ? '読み込んでいます' : detailStatus === 'error' ? '確認できませんでした' : notFoundLabel(detail?.identityMatching.onNotFound)}
              </span>
            </div>
          </div>
        </Card>

        <Card spacing="integration" aria-labelledby="wh-in-actions">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle} id="wh-in-actions">届いたらすること</h3>
            <p className={styles.cardNote}>上から順に動きます</p>
          </div>
          {detailStatus === 'loading' ? (
            <p className={styles.cardNote}>保存されている処理を読み込んでいます。</p>
          ) : detailStatus === 'error' ? (
            <ListState kind="error" title="届いた後の処理を表示できませんでした" onRetry={() => setDetailReloadKey((key) => key + 1)} />
          ) : detail && selectedAccountId ? (
              <IncomingActions key={`${selectedAccountId}:${detail.id}:${detail.version}`} detail={detail} accountId={selectedAccountId} readOnly={!canManage} onGuardReady={onActionsGuardReady} onSaved={() => setDetailReloadKey(key => key + 1)}/>
            ) :
            <p className={styles.cardNote}>届いた後に動かす処理は、まだ決めていません。</p>}
          {detail?.actionExecution.state === 'needs_attention' && detail.actionExecution.reason ? (
            <p className={styles.smallNote}>{detail.actionExecution.reason}</p>
          ) : null}
        </Card>

        {detail && (detail.identityMatching.onNotFound !== 'do_nothing' || unmatched.length > 0 || (detail.pendingUnmatched ?? 0) > 0 || unmatchedStatus === 'error') ? (
          <Card spacing="integration" aria-labelledby="wh-in-unmatched">
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle} id="wh-in-unmatched">人が見つからなかった届物</h3>
              <p className={styles.cardNote}>
                {(detail.pendingUnmatched ?? 0) > 0 ? `${formatNumber(detail.pendingUnmatched)} 件。` : ''}結び付けると、届いたらすることが動きます
              </p>
            </div>
            {unmatchedStatus === 'loading' ? (
              <p className={styles.cardNote}>届物を読み込んでいます。</p>
            ) : unmatchedStatus === 'error' ? (
              <div>
                <p className={styles.cardNote}>届物を表示できませんでした。確認待ちの届物は消えていません。</p>
                <Button onClick={() => setUnmatchedReloadKey((key) => key + 1)}>届物だけ読み直す</Button>
              </div>
            ) : (unmatchedTotal ?? detail.pendingUnmatched ?? unmatched.length) === 0 ? (
              <p className={styles.cardNote}>いま確認が必要な届物はありません。</p>
            ) : (
              <>
                <DataTable aria-label="人が見つからなかった届物" columnSizing="content">
                  <thead>
                    <TableHeadRow>
                  <Th>届いた日時</Th>
                  <Th grow>届いた値</Th>
                  <Th>候補</Th>
                  <Th showActionLabel>操作</Th>
                </TableHeadRow>
                </thead>
                <tbody>
                {unmatched.map((item) => (
                  <Fragment key={item.id}>
                  <Tr data-row-id={item.id} aria-describedby={unmatchedActionError?.id === item.id ? `wh-unmatched-error-${item.id}` : undefined}>
                    <Td><TruncatedText value={shortDateTime(item.receivedAt)} /></Td>
                    <Td grow title={item.identityAttempts.map((attempt: { kind: string; value: string }) => `${identityKindLabel(attempt.kind)}：${attempt.value}`).join('、')}>
                      <TruncatedText value={item.identityAttempts.length > 0
                        ? item.identityAttempts.map((attempt: { kind: string; value: string }) => attempt.value).join('、')
                        : '照合に使える値が届いていません'} />
                    </Td>
                    <Td>
                      <TruncatedText value={item.kind === 'candidate'
                        ? '1人の友だちに一致'
                        : item.kind === 'ambiguous'
                          ? item.candidates.length > 0 ? `${formatNumber(item.candidates.length)} 人の友だちに一致` : '2人以上に一致'
                          : '一致する友だちがいません'} />
                      {item.kind === 'ambiguous' && canResolveUnmatched ? item.candidates.map((candidate) => (
                        <div key={candidate.friendId}>
                          <TruncatedText value={candidate.displayName ?? candidate.friendId} />
                          <Button disabled={dismissingId !== null} busy={dismissingId === item.id} onClick={() => void resolveUnmatched(item, { action: 'link', friendId: candidate.friendId })}>この人に結び付ける</Button>
                        </div>
                      )) : null}
                    </Td>
                    <ActionCell>
                      {canResolveUnmatched ? (
                        item.kind === 'candidate' && item.candidates[0] ? (
                          <Button disabled={dismissingId !== null} busy={dismissingId === item.id} onClick={() => void resolveUnmatched(item, { action: 'link', friendId: item.candidates[0].friendId })}>結び付ける</Button>
                        ) : (
                          <Button disabled={dismissingId !== null} busy={dismissingId === item.id} onClick={() => void resolveUnmatched(item, { action: 'dismiss' })}>
                            {item.kind === 'ambiguous' ? 'どれでもない' : '確認した'}
                          </Button>
                        )
                      ) : <span className={styles.cardNote}>結び付け・確認は統括または管理者に頼んでください。</span>}
                    </ActionCell>
                  </Tr>
                  {unmatchedActionError?.id === item.id ? <Tr><Td colSpan={4}>
                    <Notice id={`wh-unmatched-error-${item.id}`} tone="danger" role="alert">{unmatchedActionError.message}</Notice>
                  </Td></Tr> : null}
                  </Fragment>
                ))}
                </tbody>
                </DataTable>
                {(unmatchedTotal ?? detail.pendingUnmatched ?? 0) > unmatched.length ? (
                  <div className={styles.moreRow}>
                    <span className={styles.cardNote}>ほか{(unmatchedTotal ?? detail.pendingUnmatched ?? 0) - unmatched.length} 件あります。</span>
                    <Button disabled={unmatchedMoreBusy} busy={unmatchedMoreBusy} onClick={() => { setUnmatchedMoreBusy(true); setUnmatchedShown((shown) => shown + UNMATCHED_PAGE_SIZE) }}>さらに表示</Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        ) : null}

        <Card spacing="integration" aria-labelledby="wh-in-try">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle} id="wh-in-try">届いたつもりで試す</h3>
            <p className={styles.cardNote}>見本の JSON で、どの人に届くかと何が動くかを確かめます。実際の処理は動きません</p>
          </div>
          <pre className={styles.sampleBox} title={detail?.latestSample ? `${shortDateTime(detail.latestSample.receivedAt)}に届いた見本。差し込み：${detail.templateFields.map((field) => field.token).join('、')}${detail.latestSample.truncated ? '。項目が多いため先頭50件まで表示しています' : ''}` : undefined}>{sampleText}</pre>
          <div>
            <Button
              onClick={() => {
                setTestJson(detail?.latestSample ? '{\n  "friendId": "ここに届くデータの形を入れてください"\n}' : '{ "email": "kenta@example.com", "フォーム": "体験申込" }')
                setTestResult(null)
                setTestError('')
                setTestOpen(true)
              }}
            >
              <FlaskConical size={16} aria-hidden="true" />試す
            </Button>
          </div>
        </Card>
        {<div className={styles.dangerRow}>
            <Button variant="text" disabled={!ownership.allowed && !ownership.reason} lockedReason={ownership.reason} onClick={() => { if (!canManageWebhooksNow(true) || !selectedAccountId || loadedAccountId !== selectedAccountId) return; setDeleteError(''); setDeleteTarget({ id: selected.id, name: selected.name, confirmationRevision: selected.confirmationRevision, accountId: selectedAccountId, scope: accountScopeRef.current }) }}>
              <Trash2 size={16} aria-hidden="true" />この受け取り口を削除する
            </Button>
          </div>}
      </>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      boardId="gW0F2"
      headingSize="regular"
      title="外部連携"
      help={WEBHOOKS_DESCRIPTION}
      actions={<Button lockedReason={management.reason} {...(canManage ? { href: "/webhooks?tab=notify" } : { disabled: true })}><LayoutTemplate size={16} aria-hidden="true" />見本から作る</Button>}
      tabs={<WebhookTabs active="incoming" outgoingCount={overview.outgoingCount} incomingCount={overview.incomingCount} />}
      stats={<>
        {management.known && !canManage ? <ViewerBand /> : null}
        <WebhookBand
          cells={[
            { key: 'inlets', title: '受け取り口', icon: <Inbox aria-hidden="true" />, value: overview.incomingCount, unit: '件', detail: '作成した受け取り口' },
            { key: 'received', title: '過去30日 受け取った', icon: <Inbox aria-hidden="true" />, value: overview.summary?.incoming ?? null, unit: '回', detail: overview.summary ? '受け取りの記録' : '集計を読み込めませんでした' },
          ]}
        />
      </>}
      overlays={<>
        <Dialog
          open={showCreate}
          confirmDisabled={!canManage}
          confirmLockedReason={management.reason}
          title="受け取る設定を追加"
          designNode="H031gC"
          designWidth={540}
          designTop={200}
          busy={creating}
          error={createFieldError.form}
          onCancel={() => { if (!creating) setShowCreate(false) }}
          onConfirm={() => runCreate()}
          confirmLabel="作る"
          confirmIcon={<Plus size={16} aria-hidden="true" />}
        >
          <div className={`${styles.form} ${styles.formTight}`}>
            <Field label="名前" htmlFor="wh-incoming-name" error={createFieldError.name} requirement={FIELD_REQUIREMENTS.createName}>
              <SaveErrorField names={["createName","name","create_name"]}><TextField
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="体験申込フォーム（自社サイト）"
                aria-invalid={Boolean(createFieldError.name) || undefined}
              /></SaveErrorField>
              </Field>
            <div className={styles.formField}>
              <span className={styles.pickLabel}>どこから来るか</span>
              <SaveErrorField names={["createSource","create_source"]}><Select
                aria-label="どこから来るか"
                size="full"
                value={createSource}
                onChange={(value) => setCreateSource(value)}
                options={[
                  ...SOURCE_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
                  { value: SOURCE_OTHER, label: 'その他（自分で書く）' },
                ]}
              /></SaveErrorField>
              {createSource === SOURCE_OTHER ? (
                <SaveErrorField names={["createSourceFree","create_source_free"]}><TextField
                  value={createSourceFree}
                  onChange={(event) => setCreateSourceFree(event.target.value)}
                  placeholder="見本に無いものを自由に書けます"
                  aria-label="どこから来るか（自由入力）"
                /></SaveErrorField>
              ) : null}
            </div>
            <div className={styles.fieldRow}>
              <div className={styles.grow}>
                <Field label="シークレット" htmlFor="wh-incoming-secret" error={createFieldError.secret}>
                <SaveErrorField names={["createSecret","secret","create_secret"]}><TextField
                  value={createSecret}
                  onChange={(event) => setCreateSecret(event.target.value)}
                  placeholder="相手と決めた合言葉（32文字以上）"
                  aria-invalid={Boolean(createFieldError.secret) || undefined}
                /></SaveErrorField>
              </Field>
          </div>
              <Button type="button" onClick={() => setCreateSecret(generateSecret())}><RefreshCw size={16} aria-hidden="true" />自動生成</Button>
            </div>
            <p className={styles.noteBox}>作るときに本人確認が出ます。</p>
          </div>
        </Dialog>

        <Dialog
          open={testOpen}
          title="届いたつもりで試す"
          description="見本のJSONで、どの人に届くかと何が動くかを確かめます。実際の処理は動きません。"
          onCancel={() => setTestOpen(false)}
          onConfirm={() => { if (testJson.trim()) void runTest() }}
          busy={testBusy}
          confirmLabel="試す"
        >
          <Field label="届いたつもりのJSON"><SaveErrorField names={["testJson","test_json"]}><TextArea value={testJson} onChange={(event) => setTestJson(event.target.value)} placeholder='{"friendId": "…"}' /></SaveErrorField></Field>
          {testError ? <Notice tone="danger" className={styles.fieldErrorNoticePlacement} >{testError}</Notice> : null}
          {testResult ? (
            <div className={styles.form}>
              <span className={styles.fieldLabel}>だれに届くか</span>
              <p className={styles.cardNote}>
                {testResult.match.status === 'matched'
                  ? '1人の友だちに一致しました'
                  : testResult.match.status === 'ambiguous'
                    ? `同じ値の友だちが${formatNumber(testResult.match.friendIds.length)} 人います。実際に届くと保留になり、人が選びます。`
                    : '一致する友だちがいません'}
              </p>
              <span className={styles.fieldLabel}>動く予定の処理</span>
              {testResult.actions.length > 0 ? testResult.actions.map((action: IncomingWebhookTestResult['actions'][number]) => (
                <div key={action.refIndex} className={styles.actionRow}>
                  <span className={styles.actionName}>{incomingActionLabel(action.refKind)}：{action.displayName}</span>
                  <span className={styles.spacer} aria-hidden="true" />
                  <span className={styles.actionTarget}>{action.ok ? `(${action.plan?.length ?? 0} 件の処理)` : action.error}</span>
                </div>
              )) : <p className={styles.cardNote}>動く処理はまだ決めていません</p>}
            </div>
          ) : null}
        </Dialog>

        <ConfirmDialog
          open={deleteTarget !== null}
          title={`「${deleteTarget?.name ?? ''}」の受け取り口を削除しますか？`}
          description="このURLへの通知を受け取らなくなります。すでに受け取った記録は残ります。この操作は取り消せません。"
          confirmLabel="削除する"
          confirmDisabled={!ownership.allowed}
          confirmLockedReason={ownership.reason}
          destructive
          busy={deleting}
          error={deleteError || undefined}
          onConfirm={() => runDelete()}
          onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteError('') } }}
        >
          {deleteTarget ? <OperationTargetSummary accounts={[{ id: deleteTarget.accountId }]} /> : null}
        </ConfirmDialog>

        <Dialog
          open={rotateTarget !== null}
          busy={rotating}
          title={rotateTarget ? `「${rotateTarget.name}」の合言葉を更新する` : ''}
          description="新しい合言葉を設定します。保存したあとは二度と全部は表示されません。前の合言葉は24時間だけ使えるので、相手側の切り替え中も受け取りは止まりません。"
          error={rotateError || undefined}
          onCancel={() => { setRotateTarget(null); setRotateSecret('') }}
          onConfirm={() => runRotate()}
          confirmLabel="保存する"
          confirmDisabled={!ownership.allowed}
          confirmLockedReason={ownership.reason}
        >
          {rotateTarget ? <OperationTargetSummary accounts={[{ id: rotateTarget.accountId }]} /> : null}
          <div className={styles.fieldRow}>
            <SaveErrorField names={["rotateSecret","secret","rotate_secret"]}><TextField
              value={rotateSecret}
              onChange={(event) => setRotateSecret(event.target.value)}
              placeholder="ランダムな英数字32文字以上"
              aria-label="新しい合言葉"
              autoFocus
            /></SaveErrorField>
            <Button type="button" onClick={() => setRotateSecret(generateSecret())}>自動生成</Button>
          </div>
        </Dialog>

        <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="受け取り口の変更" busy={editingBusy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider>
        {createdSecret ? (
          <Dialog
            open
            title="受け取り口を作りました"
            description="合言葉はこの画面で1回だけ表示します。相手のサービスに書き写してから閉じてください。"
            onCancel={() => setCreatedSecret(null)}
          >
            <span className={styles.fieldLabel}>名前</span>
            <p className={styles.cardNote}>{createdSecret.name}</p>
            <span className={styles.fieldLabel}>合言葉（今回だけ表示）</span>
            <div className={styles.fieldRow}>
              <p className={`${styles.valueBox} ${styles.grow}`}>{createdSecret.secret}</p>
              <CopyTextButton value={createdSecret!.secret} aria-label="合言葉をコピー"  />
            </div>
          </Dialog>
        ) : null}
        {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
      </>}
    >
      {error ? <div className={styles.errorRow}><Notice tone="danger" message={error} onClose={() => setError('')} /></div> : null}
      {!canManage ? <p className={styles.srOnly}>{MANAGE_REASON}</p> : null}
      <div className={styles.body}>
        {leftColumn}
        <div className={styles.main}>{rightColumn}</div>
      </div>
    </ListPage></SaveErrorScope>
  )
}
