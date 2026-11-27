'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors';
import { api,ApiError,fetchApi } from '@/lib/api';
import { type Folder } from '@line-crm/shared';
import type { Dispatch,RefObject,SetStateAction } from 'react';
import { type Form,type FormFilter,type FormListResponse,type FormSort } from './model';

type LoadFormsPageContext = {
  activeFolderId: string
  clearList: () => void
  fetchQuery: string
  formFilter: FormFilter
  formRequest: RefObject<number>
  formSort: FormSort
  page: number
  pageSize: number
  reviewMode: boolean
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setFolderError: Dispatch<SetStateAction<string>>
  setFolders: Dispatch<SetStateAction<Folder[]>>
  setFolderTotal: Dispatch<SetStateAction<number>>
  setForms: Dispatch<SetStateAction<Form[]>>
  setFormTotal: Dispatch<SetStateAction<number>>
  setLoadError: Dispatch<SetStateAction<string>>
  setLoadFailure: Dispatch<unknown>
  setLoading: Dispatch<SetStateAction<boolean>>
  setReviewForbidden: Dispatch<SetStateAction<boolean>>
  setUnfiledCount: Dispatch<SetStateAction<number | null>>
}

export async function loadFormsPage({ activeFolderId, clearList, fetchQuery, formFilter, formRequest, formSort, page, pageSize, reviewMode, saveErrors, selectedAccountId, setFolderError, setFolders, setFolderTotal, setForms, setFormTotal, setLoadError, setLoadFailure, setLoading, setReviewForbidden, setUnfiledCount }: LoadFormsPageContext) {
    const request = ++formRequest.current
    if (reviewMode && selectedAccountId) {
      setLoading(true)
      setLoadError('')
      setLoadFailure(null)
      setReviewForbidden(false)
      try {
        const account = `account_id=${encodeURIComponent(selectedAccountId)}`
        const res = await fetchApi<{ success: boolean; data: Form[] }>(`/api/forms/unassigned?${account}`)
        if (!res.success) throw new Error('load_failed')
        if (request !== formRequest.current) return
        // 形が違う応答を、確認対象がゼロだった結果として扱わない。
        if (!Array.isArray(res.data)) throw new Error('load_failed')
        const unassigned = res.data
        setForms(unassigned)
        setFolders([])
        setUnfiledCount(null)
        setFormTotal(unassigned.length)
        setFolderTotal(unassigned.length)
      } catch (error) {
        if (request !== formRequest.current) return
        const fieldFailure = saveErrors.capture(error)
        // 権限が無い人は専用口が 403/404 を返す。エラー画面にせず「確認できるものは無い」と伝える。
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          setReviewForbidden(true)
        } else {
          { if (!fieldFailure)
          setLoadFailure(error) }
          { if (!fieldFailure)
          setLoadError('回答フォームを読み込めませんでした。') }
        }
        clearList()
      } finally {
        if (request === formRequest.current) setLoading(false)
      }
      return
    }
    if (!selectedAccountId) {
      clearList()
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    setLoadFailure(null)
    try {
      const account = `account_id=${encodeURIComponent(selectedAccountId)}`
      const folder = `&folder_id=${encodeURIComponent(activeFolderId)}`
      /* 絞り込み・検索・並び替え・ページ切りは Worker に任せる（1ページ分だけ届く）。 */
      const paging = `&with_list_summary=1&page=${page}&limit=${pageSize}`
        + `&filter=${formFilter}&sort=${formSort}`
        + (fetchQuery.trim() ? `&q=${encodeURIComponent(fetchQuery.trim())}` : '')
      /* フォームと箱は別々に回収する。箱だけ失敗しても一覧と件数は残す。 */
      const [formsResult, foldersResult] = await Promise.allSettled([
        fetchApi<{ success: boolean; data: FormListResponse }>(`/api/forms?${account}${folder}${paging}`),
        api.folders.list('form', selectedAccountId),
      ])
      if (request !== formRequest.current) return
      const formsData = formsResult.status === 'fulfilled' && formsResult.value.success
        ? formsResult.value.data
        : null
      if (formsData === null) {
        setLoadFailure(formsResult.status === 'rejected' ? formsResult.reason : new Error('load_failed'))
        setLoadError('回答フォームを読み込めませんでした。')
        clearList()
        return
      }
      const items = Array.isArray(formsData) ? formsData : formsData.items
      setForms(items)
      setFormTotal(Array.isArray(formsData) ? items.length : formsData.total)
      setFolderTotal(Array.isArray(formsData) ? items.length : (formsData.all_total ?? formsData.total))
      const folderResponse = foldersResult.status === 'fulfilled' && foldersResult.value.success
        ? foldersResult.value
        : null
      if (folderResponse === null) {
        setFolders([])
        setUnfiledCount(null)
        setFolderError('フォルダを読み込めませんでした。')
      } else {
        setFolderError('')
        setFolders(folderResponse.data)
        setUnfiledCount(folderResponse.unfiledCount ?? null)
      }
    } catch (error) {
      if (request !== formRequest.current) return
      const fieldFailure = saveErrors.capture(error)
      { if (!fieldFailure)
      setLoadFailure(error) }
      { if (!fieldFailure)
      setLoadError('回答フォームを読み込めませんでした。') }
      clearList()
    } finally {
      if (request === formRequest.current) setLoading(false)
    }
  }
