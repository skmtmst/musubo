'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { isForbiddenOrRateLimited, loadFailureNotice } from '@/components/shared/api-error-message'
import { isTemplateDetailData, type TemplateDetailData } from '@/v8/template-detail/public/model/index'

/** 一覧のパネルでも使用先と公開前の版を読む。行・アカウントが替わった応答は捨てる。 */
export function useTemplatePanelDetail(id: string | null, accountId: string | null, canPublish: boolean, onChanged: () => Promise<void>) {
  const [snapshot, setSnapshot] = useState<{ id: string; accountId: string | null; detail: TemplateDetailData } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const generation = useRef(0)
  const publishLock = useRef(false)
  const read = useCallback(async (token: number) => {
    if (!id) return
    const res = await api.templates.get(id)
    if (token !== generation.current) return
    if (!res.success || !isTemplateDetailData(res.data) || res.data.id !== id) throw new Error('detail_unavailable')
    if (res.data.accountId != null && res.data.accountId !== accountId) throw new Error('account_mismatch')
    setSnapshot({ id, accountId, detail: res.data })
  }, [id, accountId])

  const reload = useCallback(async () => {
    if (!id) return
    const token = ++generation.current
    setLoading(true)
    setError('')
    try {
      await read(token)
    } catch (caught) {
      if (token === generation.current) {
        setError(isForbiddenOrRateLimited(caught)
          ? loadFailureNotice(caught, 'テンプレートの詳細', 'store')
          : '使用先と公開前の状態を確認できませんでした。もう一度読み込むか、詳細画面で確認してください。')
      }
    } finally {
      if (token === generation.current) setLoading(false)
    }
  }, [id, read])

  useEffect(() => {
    setSnapshot(null)
    if (!id) {
      generation.current += 1
      setError('')
      setLoading(false)
      return
    }
    void reload()
    return () => { generation.current += 1 }
  }, [id, accountId, reload])

  const detail = snapshot?.id === id && snapshot.accountId === accountId ? snapshot.detail : null
  const publish = async () => {
    if (!canPublish || !detail || !detail.hasDraft || publishLock.current) return
    publishLock.current = true
    const token = generation.current
    setPublishing(true)
    setError('')
    try {
      const res = await api.templates.publish(detail.id, {
        expectedVersion: detail.publishedVersion ?? 0,
        expectedDraftRevision: detail.draftRevision ?? 0,
      })
      if (!res.success) throw new Error(res.error)
      if (token !== generation.current) return
      await read(token)
      if (token === generation.current) await onChanged()
    } catch (caught) {
      if (token !== generation.current) return
      setError(caught instanceof ApiError && caught.status === 409
        ? '他の人が先に更新したため、公開を止めました。最新の状態を確認して、もう一度お試しください。'
        : '公開できませんでした。状態を読み直してから、もう一度お試しください。')
      await read(token).catch(() => {})
    } finally {
      publishLock.current = false
      setPublishing(false)
    }
  }
  return { detail, error, loading, publishing, publish, reload }
}
