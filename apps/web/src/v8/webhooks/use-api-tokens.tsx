'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { type ContextMenuItem } from '@/components/shared/context-menu'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import { useAccount } from '@/contexts/account-context'
import { ApiError, api, type IntegrationApiTokenInfo } from '@/lib/api'
import { useWebhookWriteAccess, canManageWebhooksNow, captureWebhookWriteAccess } from './write-access'
import { useActionError } from '@/lib/use-action-error'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useWebhookOverview
} from './shell'



import { SCOPES } from './api-token-words'

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden' | 'disabled'

export function useApiTokens() {

  const saveErrors = useSaveFormErrors()
  usePageTitle('外部連携')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const ownership = useWebhookWriteAccess(true)
  const canManage = ownership.allowed
  const overview = useWebhookOverview()
  const { selectedAccountId } = useAccount()
  const accountScope = useRef({ accountId: selectedAccountId, generation: 0 })
  if (accountScope.current.accountId !== selectedAccountId) accountScope.current = { accountId: selectedAccountId, generation: accountScope.current.generation + 1 }
  const generation = accountScope.current.generation
  const selectedAccountIdRef = useRef(selectedAccountId)
  selectedAccountIdRef.current = selectedAccountId
  const loadGenerationRef = useRef(0)

  const [tokenList, setTokenList] = useState<{ generation: number; rows: IntegrationApiTokenInfo[] }>({ generation, rows: [] })
  const tokens = tokenList.generation === generation ? tokenList.rows : []
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState('')
  const { error: actionError, setError: setActionError } = useActionError(selectedAccountId ?? '')
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [scopesError, setScopesError] = useState('')
  const [scopes, setScopes] = useState<string[]>([...SCOPES])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [issued, setIssued] = useState<{ name: string; token: string; scopes: string[] } | null>(null)
  const [copied, setCopied] = useState(false)
  const [rotateSelection, setRotateSelection] = useState<{ generation: number; token: IntegrationApiTokenInfo } | null>(null)
  const [revokeSelection, setRevokeSelection] = useState<{ generation: number; token: IntegrationApiTokenInfo } | null>(null)
  const rotateTarget = rotateSelection?.generation === generation ? rotateSelection.token : null
  const revokeTarget = revokeSelection?.generation === generation ? revokeSelection.token : null
  const setRotateTarget = (token: IntegrationApiTokenInfo | null) => { if (accountScope.current.generation === generation) setRotateSelection(token ? { generation, token } : null) }
  const setRevokeTarget = (token: IntegrationApiTokenInfo | null) => { if (accountScope.current.generation === generation) setRevokeSelection(token ? { generation, token } : null) }
  const [mutating, setMutating] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  // 右クリックされた行。まだ無ければ先頭の行（Shift+F10 の押し口）。
  const [ctxId, setCtxId] = useState<string | null>(null)
  const ctxToken = tokens.find((token) => token.id === ctxId) ?? tokens[0] ?? null

  // 行の「…」と同じ中身（右クリックでも出す）。止める口しか無いので、名前・できることを変えるは置かない。
  const revokeMenuItemsFor = (token: IntegrationApiTokenInfo): ContextMenuItem[] => [{
    id: 'revoke',
    disabled: !canManage && !ownership.reason,
    lockedReason: ownership.reason,
    label: '止める',
    danger: true,
    onSelect: () => {
      setDialogError('')
      setRevokeTarget(token)
    },
  }]

  const load = useCallback(async () => {
    const requestGeneration = ++loadGenerationRef.current
    const requestAccountId = selectedAccountId
    if (!requestAccountId) {
      setTokenList({ generation, rows: [] })
      setStatus('ready')
      return
    }
    setStatus('loading')
    setLoadError('')
    try {
      const res = await api.webhooks.apiTokens.list(requestAccountId)
      if (loadGenerationRef.current !== requestGeneration || accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId) return
      if (!res.success) {
        setStatus('error')
        setLoadError(res.error)
        return
      }
      // 止めた鍵は「使っている」と出さない（一覧の口は止めた鍵を返さない決まりだが、混ざっても出さない）。
      setTokenList({ generation, rows: res.data.filter((item) => !item.revokedAt) })
      setStatus('ready')
    } catch (caught) {
      if (loadGenerationRef.current !== requestGeneration || accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId) return
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.code === 'FEATURE_DISABLED') {
        setTokenList({ generation, rows: [] });

        setStatus('disabled');

        return
      }
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
        setTokenList({ generation, rows: [] })
        setStatus('forbidden')
        return
      }
      setStatus('error')
      { if (!fieldFailure)
      setLoadError(describeApiFailure(caught, '読み込み'))
    }
  }
  }, [selectedAccountId, generation, saveErrors])

  useEffect(() => {
    void load()
  }, [load])

  // アカウントを替えたら、前のアカウントの鍵や作成中の状態を残さない。
  useEffect(() => {
    setIssued(null)
    setCopied(false)
    setStepUp(null)
    setMutating(false)
    setCreating(false)
    setCreateOpen(false)
    setCreateError('')
    setDialogError('')
    setMenuId(null)
  }, [selectedAccountId])

  const toggleScope = (scope: string) => {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  }

  const openCreate = () => {
    if (!canManageWebhooksNow(true)) return
    setName('')
    setNameError('')
    setCreateError('')
    setScopesError('')
    setScopes([...SCOPES])
    setCreateOpen(true)
  }

  const handleCreate = async (stepUpToken?: string) => {
    if (accountScope.current.generation !== generation) return
    if (!canManageWebhooksNow(true)) { setCreateError(ownership.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const canContinue = captureWebhookWriteAccess(true)
    setCreateError('')
    setNameError('')
    setScopesError('')
    const requestAccountId = selectedAccountId
    if (!requestAccountId || accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId) return
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('名前を入力してください')
      requestAnimationFrame(() => { const field = document.getElementById('wh-token-name'); field?.focus(); field?.scrollIntoView?.({ block: 'center' }) })
      return
    }
    if (scopes.length === 0) {
      setScopesError('できることを1つ以上選んでください')
      requestAnimationFrame(() => { const field = document.getElementById('wh-token-scopes'); field?.focus(); field?.scrollIntoView?.({ block: 'center' }) })
      return
    }
    setCreating(true)
    try {
      const res = await api.webhooks.apiTokens.create(requestAccountId, { name: trimmed, scopes }, stepUpToken)
      if (accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId) return
      if (!res.success) {
        setCreateError(res.error)
        return
      }
      setIssued({ name: res.data.name, token: res.data.token, scopes: res.data.scopes ?? scopes })
      setCopied(false)
      setCreateOpen(false)
      setName('')
      await load()
    } catch (caught) {
      if (accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId) return
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'webhook.api_token', action: 'API接続の鍵を発行する', retry: async (token) => { if (accountScope.current.generation !== generation) return; if (canContinue() && selectedAccountIdRef.current === requestAccountId) return handleCreate(token); setCreateError('権限やLINEアカウントが変わったため中止しました。') } });

        return
      }
      { if (!fieldFailure)
      setCreateError(describeApiFailure(caught, '発行', {
        scope: 'store',
      })) }
    } finally {
      if (accountScope.current.generation === generation && selectedAccountIdRef.current === requestAccountId) setCreating(false)
    }
  }

  const handleRotate = async (stepUpToken?: string) => {
    if (accountScope.current.generation !== generation) return
    if (!canManageWebhooksNow(true)) { setDialogError(ownership.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const canContinue = captureWebhookWriteAccess(true)
    setActionError('')
    setDialogError('')
    const requestAccountId = selectedAccountId
    if (!requestAccountId || accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId || !rotateTarget) return
    setMutating(true)
    try {
      const res = await api.webhooks.apiTokens.rotate(rotateTarget.id, requestAccountId, stepUpToken)
      if (accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId) return
      if (!res.success) {
        setDialogError(res.error)
        return
      }
      setIssued({ name: res.data.name, token: res.data.token, scopes: res.data.scopes ?? rotateTarget.scopes })
      setCopied(false)
      setRotateTarget(null)
      await load()
    } catch (caught) {
      if (accountScope.current.generation !== generation) return
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        const target = rotateTarget
        setStepUp({
          purpose: 'webhook.api_token',
          action: `「${target?.name ?? ''}」の鍵を入れ替える`,
          retry: async (token) => { if (accountScope.current.generation !== generation) return; if (canContinue() && selectedAccountIdRef.current === requestAccountId) return handleRotate(token); setDialogError('権限やLINEアカウントが変わったため中止しました。') },
        })
        return
      }
      if (selectedAccountIdRef.current !== requestAccountId) return
      if (caught instanceof ApiError && caught.code === 'TOKEN_ROTATE_CONFLICT') {
        setRotateTarget(null)
        { if (!fieldFailure)
        setActionError('ほかの操作が先にこの鍵を更新しました。一覧を読み直しました。最新の状態からもう一度お試しください') }
        await load()
        return
      }
      { if (!fieldFailure)
      setDialogError(describeApiFailure(caught, '入れ替え', {
        scope: 'store',
      })) }
    } finally {
      if (accountScope.current.generation === generation && selectedAccountIdRef.current === requestAccountId) setMutating(false)
    }
  }

  const handleRevoke = async (stepUpToken?: string) => {
    if (accountScope.current.generation !== generation) return
    if (!canManageWebhooksNow(true)) { setDialogError(ownership.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const canContinue = captureWebhookWriteAccess(true)
    setDialogError('')
    const requestAccountId = selectedAccountId
    if (!requestAccountId || accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId || !revokeTarget) return
    setMutating(true)
    try {
      const res = await api.webhooks.apiTokens.revoke(revokeTarget.id, requestAccountId, stepUpToken)
      if (accountScope.current.generation !== generation || selectedAccountIdRef.current !== requestAccountId) return
      if (!res.success) {
        setDialogError(res.error)
        return
      }
      setRevokeTarget(null)
      await load()
    } catch (caught) {
      if (accountScope.current.generation !== generation) return
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        const target = revokeTarget
        setStepUp({
          purpose: 'webhook.api_token',
          action: `「${target?.name ?? ''}」の鍵を止める`,
          retry: async (token) => { if (accountScope.current.generation !== generation) return; if (canContinue() && selectedAccountIdRef.current === requestAccountId) return handleRevoke(token); setDialogError('権限やLINEアカウントが変わったため中止しました。') },
        })
        return
      }
      if (selectedAccountIdRef.current !== requestAccountId) return
      { if (!fieldFailure)
      setDialogError(describeApiFailure(caught, '停止', {
        scope: 'store',
      })) }
    } finally {
      if (accountScope.current.generation === generation && selectedAccountIdRef.current === requestAccountId) setMutating(false)
    }
  }


  return { saveErrors, ownership, canManage, overview, tokens, status, loadError, actionError, createOpen, setCreateOpen, name, setName, nameError, scopesError, scopes, creating, createError, issued, setIssued, rotateTarget, setRotateTarget, revokeTarget, setRevokeTarget, targetAccountId: selectedAccountId, mutating, dialogError, setDialogError, stepUp, setStepUp, menuId, setMenuId, setCtxId, ctxToken, revokeMenuItemsFor, load, toggleScope, openCreate, handleCreate, handleRotate, handleRevoke }
}
