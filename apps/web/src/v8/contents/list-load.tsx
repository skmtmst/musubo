'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api,ApiError,type MediaQuota } from '@/lib/api'
import type { Folder,MediaItem } from '@line-crm/shared'
import type { Dispatch,RefObject,SetStateAction } from 'react'
import { MediaSort, usableMediaCounts } from './list-model'


type LoadMediaListContext = {
  folderFilter: string
  kinds: Set<"image" | "video" | "audio" | "file">
  latestAccountRef: RefObject<string | null>
  listSeqRef: RefObject<number>
  page: number
  pageSize: number
  query: string
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setError: Dispatch<SetStateAction<string>>
  setItems: Dispatch<SetStateAction<MediaItem[]>>
  setListKnown: Dispatch<SetStateAction<boolean>>
  setLoadFailed: Dispatch<SetStateAction<boolean>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setTotal: Dispatch<SetStateAction<number>>
  showArchivedOnly: boolean
  showNearLimitOnly: boolean
  showUnusedOnly: boolean
  sort: MediaSort
}

export async function loadMediaList({ folderFilter, kinds, latestAccountRef, listSeqRef, page, pageSize, query, saveErrors, selectedAccountId, setError, setItems, setListKnown, setLoadFailed, setLoading, setTotal, showArchivedOnly, showNearLimitOnly, showUnusedOnly, sort }: LoadMediaListContext) {
    const accountAtRequest = selectedAccountId
    const seq = ++listSeqRef.current
    const isLatest = () => seq === listSeqRef.current && accountAtRequest === latestAccountRef.current
    if (!accountAtRequest) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadFailed(false)
    setError('')
    try {
      const res = await api.media.list(accountAtRequest, {
        kind: kinds.size === 1 ? [...kinds][0] : undefined,
        folderId: folderFilter || undefined,
        query: query.trim() || undefined,
        unusedOnly: showUnusedOnly,
        nearLimitOnly: showNearLimitOnly,
        archived: showArchivedOnly ? 'only' : undefined,
        sort,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }).catch(() => null)
      if (!isLatest()) return
      if (res?.success && res.data && Array.isArray(res.data.items)
        && Number.isInteger(res.data.total) && res.data.total >= 0) {
        setItems(res.data.items)
        setTotal(res.data.total)
        setListKnown(true)
      } else {
        setLoadFailed(true)
        setListKnown(false)
      }
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (isLatest()) {
        setLoadFailed(true)
        setListKnown(false)
      }
    } finally {
      if (isLatest()) setLoading(false)
    }
  }

type LoadMediaSummaryContext = {
  latestAccountRef: RefObject<string | null>
  selectedAccountId: string | null
  setOverallTotal: Dispatch<SetStateAction<number | null>>
  setQuota: Dispatch<SetStateAction<MediaQuota | null>>
  setQuotaFailed: Dispatch<SetStateAction<boolean>>
  showArchivedOnly: boolean
  summarySeqRef: RefObject<number>
}

export async function loadMediaSummary({ latestAccountRef, selectedAccountId, setOverallTotal, setQuota, setQuotaFailed, showArchivedOnly, summarySeqRef }: LoadMediaSummaryContext) {
    const accountAtRequest = selectedAccountId
    const seq = ++summarySeqRef.current
    if (!accountAtRequest) {
      setQuota(null)
      return
    }
    setQuotaFailed(false)
    const [quotaResponse, overallResponse] = await Promise.all([
      api.media.quota(accountAtRequest).catch(() => null),
      // フォルダ欄の総数も数の帯と同じ一括集計を使い、一覧の部分件数にしない。
      api.media.counts(accountAtRequest).catch(() => null),
    ])
    if (seq !== summarySeqRef.current || accountAtRequest !== latestAccountRef.current) return
    const counts = overallResponse?.success ? usableMediaCounts(overallResponse.data) : null
    // 形が違う・失敗のときは「—」のまま。一覧の口を読み直して総数を作らない。
    setOverallTotal(counts ? (showArchivedOnly ? counts.archived : counts.total) : null)
    if (quotaResponse?.success) setQuota(quotaResponse.data)
    else {
      setQuota(null)
      setQuotaFailed(true)
    }
  }

type LoadMediaFoldersContext = {
  latestAccountRef: RefObject<string | null>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setFolderFailure: Dispatch<unknown>
  setFolderReloading: Dispatch<SetStateAction<boolean>>
  setFolders: Dispatch<SetStateAction<Folder[]>>
  setUnfiledCount: Dispatch<SetStateAction<number | null>>
}

export async function loadMediaFolders({ latestAccountRef, saveErrors, selectedAccountId, setFolderFailure, setFolderReloading, setFolders, setUnfiledCount }: LoadMediaFoldersContext) {
    const accountAtRequest = selectedAccountId
    if (!accountAtRequest) {
      setFolders([])
      setUnfiledCount(null)
      setFolderFailure(null)
      return
    }
    setFolderReloading(true)
    setFolderFailure(null)
    try {
      // #730: 選択中の1件に閉じた母集団で数える。
      const folderResponse = await api.folders.list('media', accountAtRequest)
      if (accountAtRequest !== latestAccountRef.current) return
      if (folderResponse.success) {
        setFolders(folderResponse.data)
        setUnfiledCount(folderResponse.unfiledCount ?? null)
      } else {
        setFolderFailure(new ApiError(500, folderResponse.error))
      }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (accountAtRequest === latestAccountRef.current) { if (!fieldFailure) setFolderFailure(caught) }
    } finally {
      if (accountAtRequest === latestAccountRef.current) setFolderReloading(false)
    }
  }
