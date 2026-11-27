'use client'

/* app/settings/manual-links/use-manual-links.ts から写した（src/v8 は @/app を読めない）。動きは同じ。 */

import { describeApiFailure } from '@/components/shared/api-error-message'
import { loadStaffIdentity, useStaffIdentity } from '@/lib/staff-role'
import { canViewManualLinks } from '@/lib/manual-link-access'
import { lockReason } from '@/components/shared/permission-lock'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { notifySaved } from '@/components/shared/toast'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { ApiError, api, type ManualLink } from '@/lib/api'
import {
  STATUS_FILTERS,
  brokenNotice,
  canEditTable,
  manualLinkRow,
  matchesQuery,
  matchesStatus,
  type StatusFilter,
} from './manual-link-view'

/**
 * マニュアルの正本表の状態と操作。管理画面・V8 のどちらの描画からも同じ口で使う。
 * 権限の判定・確かめる・直す・保存はここに1つだけ置く。
 */
export function useManualLinks() {
  const staff = useStaffIdentity()
  const permissionReason = usePermissionLockReason(canEditTable(staff), 'ops')
  const [links, setLinks] = useState<ManualLink[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [checking, setChecking] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingUrl, setEditingUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<StatusFilter>('filter', 'all')
  /** 「確かめる」「保存」の失敗。無言にせず、やり直しの手がかりと一緒に残す。 */
  const [actionError, setActionError] = useState('')
  const mountedRef = useRef(true)
  const loadGenRef = useRef(0)
  const checkingRef = useRef(false)
  const savingRef = useRef(false)

  /*
   * #975 U071: 初回の読み込み失敗にも再試行を付ける。
   * useEffect からもエラー状態のボタンからも同じ入口で読み直す。
   */
  const loadInitial = useCallback(async (alive: () => boolean) => {
    const gen = ++loadGenRef.current
    const isCurrent = () => mountedRef.current && loadGenRef.current === gen && alive()
    setStatus('loading')
    try {
      const [staffResponse, manualLinks] = await Promise.all([loadStaffIdentity(), api.manualLinks.list()])
      if (!isCurrent()) return
      if (!staffResponse.success || !manualLinks.success) {
        setStatus('error')
        return
      }
      setLinks(manualLinks.data.items)
      setTotal(manualLinks.data.total)
      setStatus('ready')
    } catch {
      if (isCurrent()) setStatus('error')
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    let alive = true
    void loadInitial(() => alive)
    return () => {
      alive = false
      mountedRef.current = false
      loadGenRef.current += 1
    }
  }, [loadInitial])

  const rows = useMemo(() => links.map(manualLinkRow), [links])
  const shown = rows.filter((r) => matchesStatus(r, filter) && matchesQuery(r, query))
  const notice = brokenNotice(rows)

  const checkAll = async () => {
    if (!canEditTable(staff) || lockReason(canEditTable(staff), 'ops') || checking || checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    setActionError('')
    try {
      const result = await api.manualLinks.check()
      if (!mountedRef.current) return
      if (!result.success) {
        setActionError(result.error)
        return
      }
      const refreshed = await api.manualLinks.list()
      if (!mountedRef.current) return
      if (refreshed.success) {
        setLinks(refreshed.data.items)
        setTotal(refreshed.data.total)
      } else {
        setActionError(refreshed.error)
      }
    } catch (error) {
      if (!mountedRef.current) return
      if (error instanceof ApiError && (error.status === 403 || error.status === 429)) {
        setActionError(describeApiFailure(error, '確認', { scope: 'hq' }))
        return
      }
      setActionError('確かめられませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      checkingRef.current = false
      if (mountedRef.current) setChecking(false)
    }
  }

  const dirty = editingKey !== null && editingUrl.trim() !== (links.find((item) => item.key === editingKey)?.url ?? '')
  const guard = useUnsavedGuard({ dirty, busy: saving })
  const startEdit = (key: string) => guard.guarded(() => {
    if (!canEditTable(staff) || lockReason(canEditTable(staff), 'ops')) return
    const link = links.find((item) => item.key === key)
    if (!link) return
    setEditingKey(key)
    setEditingUrl(link.url ?? '')
  })

  const saveEdit = async () => {
    if (!canEditTable(staff) || lockReason(canEditTable(staff), 'ops') || !editingKey || saving || savingRef.current || !dirty) return
    const current = links.find((item) => item.key === editingKey)
    if (!current) return
    savingRef.current = true
    setSaving(true)
    setActionError('')
    try {
      const result = await api.manualLinks.update(editingKey, {
        url: editingUrl.trim() || null,
        expectedVersion: current.version,
      })
      if (!mountedRef.current) return
      if (!result.success) {
        setActionError(result.error)
        return
      }
      setLinks((items) => items.map((item) => item.key === editingKey ? result.data : item))
      setEditingKey(null)
      notifySaved('マニュアルの行き先を保存しました。')
    } catch (error) {
      if (!mountedRef.current) return
      // ほかの人が先に変えたときは編集中身を残し、最新を読み直す。
      if (error instanceof ApiError && error.status === 409) {
        let reloaded = false
        try {
          const refreshed = await api.manualLinks.list()
          if (!mountedRef.current) return
          if (refreshed.success) {
            setLinks(refreshed.data.items)
            setTotal(refreshed.data.total)
            reloaded = true
          }
        } catch {
          if (!mountedRef.current) return
        }
        setActionError(
          reloaded
            ? 'ほかの人が先に変更しました。最新の内容を読み直したので、確認してもう一度保存してください。'
            : 'ほかの人が先に変更しましたが、最新の内容を読み直せませんでした。画面を読み直してから、もう一度保存してください。',
        )
        return
      }
      if (error instanceof ApiError && error.status === 403) {
        setActionError('この表を直す権限がありません。運営に依頼してください。')
        return
      }
      if (error instanceof ApiError && error.status === 429) {
        setActionError(describeApiFailure(error, '保存', { scope: 'hq' }))
        return
      }
      setActionError('保存できませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  return {
    guard,
    dirty,
    staff,
    permissionReason,
    rows,
    shown,
    total,
    status,
    checking,
    editingKey,
    editingUrl,
    setEditingUrl,
    saving,
    query,
    setQuery,
    filter,
    setFilter,
    actionError,
    notice,
    canEdit: canEditTable(staff) && !permissionReason,
    canView: canViewManualLinks(staff),
    loadInitial,
    checkAll,
    startEdit,
    cancelEdit: () => guard.guarded(() => setEditingKey(null)),
    saveEdit,
    statusFilters: STATUS_FILTERS,
  }
}
