'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'

/* app/settings/file-scan/use-file-scan.ts から写した（src/v8 は @/app を読めない）。動きは同じ。 */

import { readStaffIdentity } from '@/lib/staff-identity-state'
import { loadStaffIdentity, useStaffRole, canManageRole } from '@/lib/staff-role'
import { notifySaved } from '@/components/shared/toast'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { ApiError, api, type FileScanConfig, type FileScanItem } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useFormErrors } from '@/lib/use-form-errors'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'

/** 一覧の1ページの件数。先頭50件固定だった監査 R132 の名残を残さない。 */
export const FILE_SCAN_PAGE_SIZE = 50

export type FileScanPhase = 'loading' | 'ready' | 'error' | 'forbidden'

/**
 * ファイルの検査の状態と操作。管理画面・V8 のどちらの描画からも同じ口で使う。
 * 権限・一覧・戻す・消す・外の検査の設定はここに1つだけ置く。
 */
export function useFileScan() {
  const canEdit = canManageRole(useStaffRole())
  const { selectedAccountId } = useAccount()
  const scope = useRef({ accountId: selectedAccountId, generation: 0 })
  if (scope.current.accountId !== selectedAccountId) scope.current = { accountId: selectedAccountId, generation: scope.current.generation + 1 }
  const renderedScope = scope.current
  const loadedScope = useRef<typeof renderedScope | null>(null)
  const loadSequence = useRef(0)
  const mounted = useRef(false)
  const canEditRef = useRef(canEdit); canEditRef.current = canEdit
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [phase, setPhase] = useState<FileScanPhase>('loading')
  const [items, setItems] = useState<FileScanItem[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useListUrlValue('statusFilter', 'quarantined')
  /** 板  の札の件数。検索語を含めた今の条件での総数。 */
  const [counts, setCounts] = useState({ quarantined: 0, pending: 0, released: 0 })
  const [query, setQuery] = useListUrlValue('q', '')
  const deferredQuery = useDeferredValue(query)
  const [page, setPage] = useListUrlValue('page', 1)
  const [actionError, setActionError] = useState('')
  const [actionDone, setActionDone] = useState('')
  const [releaseTarget, setReleaseTarget] = useState<FileScanItem | null>(null)
  const [releaseScope, setReleaseScope] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const releaseTicket = useRef<object | null>(null)
  const releaseLock = useRef(false)
  const [releaseReason, setReleaseReason] = useState('')
  const [releaseBusy, setReleaseBusy] = useState(false)
  /* 監査 D017: 確認窓の中で起きた失敗は窓の中に出す。ページ最上部の帯は
   * 暗転の後ろに隠れて読めないため、ConfirmDialog の error へ渡す。 */
  const [releaseError, setReleaseError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<FileScanItem | null>(null)
  const [deleteScope, setDeleteScope] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const deleteLock = useRef(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [config, setConfig] = useState<FileScanConfig | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [secretRef, setSecretRef] = useState('')
  const [configBusy, setConfigBusy] = useState(false)
  const [stopExternal, setStopExternal] = useState(false)
  const [stopScope, setStopScope] = useState<{ scope: typeof renderedScope; ticket: object; revision: number | undefined } | null>(null)
  const stopTicket = useRef<object | null>(null)
  const stopLock = useRef<object | null>(null)
  const configLock = useRef<object | null>(null)
  const [stopError, setStopError] = useState('')
  const configFields = useFormErrors()
  const hasExternalInput = Boolean(provider.trim() || endpoint.trim() || secretRef.trim())
  configFields.define('externalProvider', '提供元', () => hasExternalInput && !provider.trim() ? '提供元を入力してください' : null, { required: hasExternalInput })
  configFields.define('externalEndpointUrl', '送り先（https）', () => {
    if (!hasExternalInput) return null
    if (!endpoint.trim()) return '送り先を入力してください'
    try {
      return new URL(endpoint.trim()).protocol === 'https:' ? null : 'https:// で始まる送り先を入力してください'
    } catch { return '送り先の URL を確かめてください（https:// から）' }
  }, { required: hasExternalInput })
  configFields.define('externalSecretRef', '鍵の名前', () => !hasExternalInput || (/^FILE_SCAN_SECRET_[A-Z0-9_]+$/.test(secretRef.trim()) && secretRef.trim().length <= 120)
    ? null : '鍵の名前は FILE_SCAN_SECRET_ で始まる大文字・数字・下線の120文字以内で指定してください', { required: hasExternalInput })

  // 外の検査の設定が保存前なら離脱の番兵を出す。
  const configDirty = configOpen && (
    (provider.trim() || null) !== (config?.externalProvider ?? null)
    || (endpoint.trim() || null) !== (config?.externalEndpointUrl ?? null)
    || (secretRef.trim() || null) !== (config?.externalSecretRef ?? null)
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty: configDirty, busy: configBusy })

  const load = useCallback(async () => {
    if (!mounted.current || renderedScope !== scope.current) return
    const sequence = ++loadSequence.current
    const current = () => mounted.current && renderedScope === scope.current && sequence === loadSequence.current
    if (!selectedAccountId) {
      setPhase('ready')
      setItems([])
      setTotal(0)
      setCounts({ quarantined: 0, pending: 0, released: 0 })
      return
    }
    setPhase('loading')
    setActionError('')
    try {
      const trimmedQuery = deferredQuery.trim() || undefined
      const [me, list, configRes, quarantinedRes, pendingRes, releasedRes] = await Promise.all([
        loadStaffIdentity(),
        api.fileScan.list(selectedAccountId, {
          status: statusFilter,
          q: trimmedQuery,
          limit: FILE_SCAN_PAGE_SIZE,
          offset: (page - 1) * FILE_SCAN_PAGE_SIZE,
        }),
        api.fileScan.getConfig(selectedAccountId),
        api.fileScan.list(selectedAccountId, { status: 'quarantined', q: trimmedQuery, limit: 1 }),
        api.fileScan.list(selectedAccountId, { status: 'pending', q: trimmedQuery, limit: 1 }),
        api.fileScan.list(selectedAccountId, { status: 'released', q: trimmedQuery, limit: 1 }),
      ])
      if (!current()) return
      if (!me.success || !list.success || !configRes.success) {
        setPhase('error')
        return
      }
      setCounts({
        quarantined: quarantinedRes.success ? quarantinedRes.data.total : 0,
        pending: pendingRes.success ? pendingRes.data.total : 0,
        released: releasedRes.success ? releasedRes.data.total : 0,
      })
      if (!canManageRole(readStaffIdentity()?.role)) {
        setPhase('forbidden')
        return
      }
      setItems(list.data.items)
      loadedScope.current = renderedScope
      setTotal(list.data.total)
      /* 消す・戻すで今のページが空になったら1ページ目へ戻す（監査 R132）。 */
      if (list.data.items.length === 0 && page > 1) setPage(1)
      const latestItems = list.data.items
      setConfig(configRes.data.config)
      setProvider(configRes.data.config?.externalProvider ?? '')
      setEndpoint(configRes.data.config?.externalEndpointUrl ?? '')
      setSecretRef(configRes.data.config?.externalSecretRef ?? '')
      setPhase('ready')
      return latestItems
    } catch {
      if (current()) setPhase('error')
    }
  }, [selectedAccountId, statusFilter, deferredQuery, page, renderedScope])

  useEffect(() => {
    releaseTicket.current = null; deleteTicket.current = null; stopTicket.current = null
    stopLock.current = null; configLock.current = null
    setReleaseTarget(null); setDeleteTarget(null); setStopExternal(false)
    setReleaseBusy(false); setDeleteBusy(false); setConfigBusy(false)
  }, [renderedScope])

  useEffect(() => {
    void load()
  }, [load])

  async function release() {
    if (!canEditRef.current || !selectedAccountId || !releaseTarget || !releaseScope || releaseScope.scope !== scope.current || releaseScope.ticket !== releaseTicket.current || loadedScope.current !== releaseScope.scope || !mounted.current || releaseLock.current) return
    /* 監査 D018: 必須の理由が空なら送らず、窓の中で理由を促す。 */
    if (!releaseReason.trim()) {
      setReleaseError('理由を入力してください')
      return
    }
    if (!releaseTarget.confirmationRevision) { setReleaseError('戻せませんでした。通信状態を確認して、もう一度お試しください。'); return }
    const current = () => mounted.current && canEditRef.current && releaseScope.scope === scope.current && releaseScope.ticket === releaseTicket.current
    releaseLock.current = true; setReleaseBusy(true)
    setReleaseError('')
    try {
      const res = await api.fileScan.release(releaseTarget.id, selectedAccountId, releaseReason.trim(), releaseTarget.confirmationRevision)
      if (!current()) return
      if (!res.success) {
        setReleaseError('戻せませんでした。通信状態を確認して、もう一度お試しください。')
        return
      }
      setReleaseTarget(null)
      releaseTicket.current = null
      setReleaseReason('')
      setReleaseError('')
      setActionDone(`${releaseTarget.filename} を使えるように戻しました。`)
      await load()
    } catch (caught) {
      if (!current()) return
      setReleaseError(caught instanceof ApiError && caught.status === 409
        ? 'しまったファイルだけ戻せます。一覧を読み直してください。'
        : '戻せませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      releaseLock.current = false
      if (mounted.current && releaseScope.scope === scope.current) setReleaseBusy(false)
    }
  }

  async function remove() {
    if (!canEditRef.current || !selectedAccountId || !deleteTarget || !deleteScope || deleteScope.scope !== scope.current || deleteScope.ticket !== deleteTicket.current || loadedScope.current !== deleteScope.scope || !mounted.current || deleteLock.current) return
    if (!deleteTarget.confirmationRevision) { setDeleteError('消せませんでした。通信状態を確認して、もう一度お試しください。'); return }
    const current = () => mounted.current && canEditRef.current && deleteScope.scope === scope.current && deleteScope.ticket === deleteTicket.current
    deleteLock.current = true; setDeleteBusy(true)
    setDeleteError('')
    try {
      const res = await api.fileScan.remove(deleteTarget.id, selectedAccountId, deleteTarget.confirmationRevision)
      if (!current()) return
      if (!res.success) {
        setDeleteError('消せませんでした。通信状態を確認して、もう一度お試しください。')
        return
      }
      setDeleteTarget(null)
      deleteTicket.current = null
      setDeleteError('')
      setActionDone(`${deleteTarget.filename} を消しました。`)
      await load()
    } catch (caught) {
      if (!current()) return
      if (caught instanceof ApiError && caught.status === 409) {
        const latest = await load()
        if (!current()) return
        setDeleteTarget(latest?.find(item => item.id === deleteTarget.id) ?? null)
      }
      setDeleteError(caught instanceof ApiError && caught.status === 409
        ? caught.code === 'file_scan_not_disposable' ? 'しまった・使えないファイルだけ消せます。一覧を読み直してください。' : '確認した内容が変わりました。一覧を読み直してください。'
        : '消せませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      deleteLock.current = false
      if (mounted.current && deleteScope.scope === scope.current) setDeleteBusy(false)
    }
  }

  async function saveConfig() {
    if (!canEdit) return
    if (!selectedAccountId || configBusy || configLock.current || !configDirty) return
    setActionError('')
    if (configFields.submit().length > 0) return
    const lock = {}; configLock.current = lock; setConfigBusy(true)
    const current = () => mounted.current && renderedScope === scope.current && configLock.current === lock
    try {
      const res = await api.fileScan.saveConfig(selectedAccountId, {
        externalProvider: provider.trim() || null,
        externalEndpointUrl: endpoint.trim() || null,
        externalSecretRef: secretRef.trim() || null,
      })
      if (!current()) return
      if (!res.success) {
        setActionError('設定を保存できませんでした。時間をおいて、もう一度お試しください。')
        return
      }
      setConfigOpen(false)
      notifySaved('外の検査の設定を保存しました。')
      await load()
    } catch (caught) {
      if (!current()) return
      const errors = readSaveFieldErrors(caught)
      const count = Object.keys(errors).length
      if (count && configFields.setServerErrors(errors) === count) return
      setActionError(caught instanceof ApiError && caught.status === 400
        ? describeApiFailure(caught, '設定の保存')
        : '設定を保存できませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      if (current()) { configLock.current = null; setConfigBusy(false) }
    }
  }

  /*
   * 監査 R133: 「止める」は表示を畳むのではなく、保存済みの設定を
   * 実際に消す。空に保存すると送信は止まる（部分だけの空はAPIが弾く）。
   */
  async function stopExternalConfig() {
    if (!canEditRef.current || !selectedAccountId || !stopScope || stopScope.scope !== scope.current || stopScope.ticket !== stopTicket.current || loadedScope.current !== stopScope.scope || !mounted.current || stopLock.current || configLock.current) return
    if (!stopScope.revision) { setStopError('設定を消せませんでした。'); return }
    const current = () => mounted.current && canEditRef.current && stopScope.scope === scope.current && stopScope.ticket === stopTicket.current
    const lock = {}; stopLock.current = lock; configLock.current = lock; setConfigBusy(true)
    setStopError('')
    try {
      const res = await api.fileScan.saveConfig(selectedAccountId, {
        externalProvider: null,
        externalEndpointUrl: null,
        externalSecretRef: null,
        expectedConfirmationRevision: stopScope.revision,
      })
      if (!current()) return
      if (!res.success) {
        setStopError('設定を消せませんでした。')
        return
      }
      setStopExternal(false)
      stopTicket.current = null
      setStopError('')
      setConfigOpen(false)
      setActionDone('外の検査サービスへの送信を止めました。内蔵の簡易検査は続きます。')
      await load()
    } catch {
      if (!current()) return
      setStopError('設定を消せませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      if (stopLock.current === lock) stopLock.current = null
      if (configLock.current === lock) { configLock.current = null; if (mounted.current && stopScope.scope === scope.current) setConfigBusy(false) }
    }
  }

  /* 開き直す時は保存済みの値へ戻す。編集中の置き去りを残さない。 */
  function toggleConfigOpen() {
    configFields.reset()
    setActionError('')
    if (!configOpen) {
      setProvider(config?.externalProvider ?? '')
      setEndpoint(config?.externalEndpointUrl ?? '')
      setSecretRef(config?.externalSecretRef ?? '')
    }
    setConfigOpen(!configOpen)
  }

  function changeQuery(next: string) {
    setQuery(next)
    setPage(1)
  }

  function changeStatusFilter(next: string) {
    setStatusFilter(next)
    setPage(1)
  }

  const canOpen = () => mounted.current && canEditRef.current && Boolean(selectedAccountId) && renderedScope === scope.current && loadedScope.current === renderedScope && phase === 'ready'
  const changeReleaseTarget = (item: FileScanItem | null) => {
    if (item) {
      if (!canOpen()) return
      const ticket = {}; releaseTicket.current = ticket; setReleaseScope({ scope: renderedScope, ticket }); setReleaseTarget({ ...item })
    } else if (releaseScope?.ticket === releaseTicket.current) { releaseTicket.current = null; setReleaseTarget(null) }
  }
  const changeDeleteTarget = (item: FileScanItem | null) => {
    if (item) {
      if (!canOpen()) return
      const ticket = {}; deleteTicket.current = ticket; setDeleteScope({ scope: renderedScope, ticket }); setDeleteTarget({ ...item })
    } else if (deleteScope?.ticket === deleteTicket.current) { deleteTicket.current = null; setDeleteTarget(null) }
  }
  const changeStopExternal = (open: boolean) => {
    if (open) {
      if (!canOpen()) return
      const ticket = {}; stopTicket.current = ticket; setStopScope({ scope: renderedScope, ticket, revision: config?.confirmationRevision }); setStopExternal(true)
    } else if (stopScope?.ticket === stopTicket.current) { stopTicket.current = null; setStopExternal(false) }
  }

  return {
    canEdit,
    selectedAccountId,
    phase,
    items,
    total,
    counts,
    statusFilter,
    query,
    page,
    setPage,
    actionError,
    setActionError,
    actionDone,
    releaseTarget: releaseScope?.scope === renderedScope ? releaseTarget : null,
    setReleaseTarget: changeReleaseTarget,
    releaseReason,
    setReleaseReason,
    releaseBusy,
    releaseError,
    setReleaseError,
    deleteTarget: deleteScope?.scope === renderedScope ? deleteTarget : null,
    setDeleteTarget: changeDeleteTarget,
    deleteBusy,
    deleteError,
    setDeleteError,
    config,
    configOpen,
    provider,
    setProvider,
    endpoint,
    setEndpoint,
    secretRef,
    setSecretRef,
    configBusy,
    configDirty,
    configFields,
    stopExternal: stopScope?.scope === renderedScope && stopExternal,
    setStopExternal: changeStopExternal,
    stopError,
    setStopError,
    leaveTarget,
    confirmLeave,
    cancelLeave,
    load,
    release,
    remove,
    saveConfig,
    stopExternalConfig,
    toggleConfigOpen,
    changeQuery,
    changeStatusFilter,
  }
}
