'use client'

import { useStaffRole, canManageRole, loadStaffIdentity } from '@/lib/staff-role'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import CreatePage, { Field, inputClass } from '@/components/shared/create-page'
import { canManageWebhooksNow } from './write-access'
import TargetMissing from '@/components/shared/target-missing'
import { useAccount } from '@/contexts/account-context'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'


/**
 * 送信Webhookの編集（#939 N-363）。
 *
 * 作ったあとに「名前・URL・いつ送るか・送り直す回数」を直せるようにする。
 * 合言葉（シークレット）はここでは触らない。入れ直しは一覧の
 * 「設定 → 合言葉」から行う（値が画面に残らない専用の窓がある）。
 */
function EditWebhookPageInner() {
  const saveErrors = useSaveFormErrors()
  const { selectedAccountId, loading: accountLoading = false } = useAccount()
  const selectedAccountIdRef = useRef(selectedAccountId)
  selectedAccountIdRef.current = selectedAccountId
  const searchParams = useSearchParams()
  const id = searchParams.get('id') ?? ''

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [eventTypes, setEventTypes] = useState('')
  const [maxRetries, setMaxRetries] = useState('0')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'not-found'>('loading')
  /*
   * W159：いま入力欄に入っている中身が、どの送り先（とアカウント）のものか。
   * 別の送り先へ移って読み込み中の間は、前の入力で今の送り先を保存させない。
   */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const currentKey = `${selectedAccountId ?? ''}|${id}`
  /** 失敗したあとの「もう一度読み込む」で取り直すための番号。 */
  const [reloadKey, setReloadKey] = useState(0)
  const staffRole = useStaffRole()
  const [roleRetrying, setRoleRetrying] = useState(false)
  const [roleRetryError, setRoleRetryError] = useState('')
  const roleRetryInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      roleRetryInFlightRef.current = false
    }
  }, [])
  useEffect(() => {
    if (staffRole !== null) setRoleRetryError('')
  }, [staffRole])

  const retryStaffRole = async () => {
    if (roleRetryInFlightRef.current) return
    roleRetryInFlightRef.current = true
    setRoleRetrying(true)
    setRoleRetryError('')
    try {
      const res = await loadStaffIdentity()
      if (!mountedRef.current) return
      if (!res?.success) {
        setRoleRetryError('権限を確認できませんでした。通信状態を確認して、もう一度お試しください。')
      }
    } catch {
      if (mountedRef.current) {
        setRoleRetryError('権限を確認できませんでした。通信状態を確認して、もう一度お試しください。')
      }
    } finally {
      roleRetryInFlightRef.current = false
      if (mountedRef.current) setRoleRetrying(false)
    }
  }


  useEffect(() => {
    let cancelled = false
    if (!id || !selectedAccountId) {
      setLoadState(selectedAccountId === null ? 'loading' : 'error')
      return
    }
    setLoadState('loading')
    void api.webhooks.outgoing.detail(id, selectedAccountId)
      .then((res) => {
        if (cancelled) return
        if (!res.success) {
          setLoadState('error')
          return
        }
        setName(res.data.name)
        setUrl(res.data.url)
        setEventTypes(res.data.eventTypes.join(', '))
        setMaxRetries(String(res.data.maxRetries ?? 0))
        setLoadedKey(`${selectedAccountId}|${id}`)
        setLoadState('ready')
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        if (caught instanceof ApiError && caught.status === 404) setLoadState('not-found')
        else setLoadState('error')
      })
    return () => { cancelled = true }
  }, [id, reloadKey, selectedAccountId])

  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="直す送り先が指定されていません"
        description="外部連携の一覧から「設定 → 直す」で開いてください。"
        backHref="/webhooks"
        backLabel="外部連携の一覧へ戻る"
      />
    )
  }
  if (loadState === 'not-found') {
    return (
      <TargetMissing
        kind="not-found"
        title="この送り先は見つかりません"
        description="消えているか、別のLINEアカウントのものかもしれません。一覧から選び直してください。"
        backHref="/webhooks"
        backLabel="外部連携の一覧へ戻る"
      />
    )
  }
  if (loadState === 'error') {
    return (
      <TargetMissing
        kind="error"
        title="送り先の設定を読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    )
  }

  if (!selectedAccountId && !accountLoading) {
    return (
      <ListState
        kind="empty"
        title="LINEアカウントを選択してください"
        description="画面上部でLINEアカウントを選ぶと、送り先の設定を確認できます。"
      />
    )
  }

  if (!canManageRole(staffRole)) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="info">
          {staffRole === null ? '権限の確認が終わるまで編集できません。確認できないときは、もう一度読み込んでください。' : '送り先の変更はオーナーか管理者だけができます。必要なときは依頼してください。'}
        </Notice>
        {staffRole === null && roleRetryError ? (
          <Notice tone="danger" message={roleRetryError} />
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {staffRole === null ? (
            <Button
              variant="secondary"
              onClick={() => void retryStaffRole()}
              disabled={roleRetrying}
              busy={roleRetrying}
              busyLabel="確認しています"
            >
              もう一度読み込む
            </Button>
          ) : null}
          <Button variant="secondary" href="/webhooks">外部連携の一覧へ戻る</Button>
        </div>
      </div>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      title="送り先を直す"
      help="送り先の設定を直します。合言葉はこの画面では変わりません。"
      parent={['外部連携', '/webhooks']}
      saveLabel="保存する"
      successHref={() => '/webhooks'}
      validate={() => {
        if (!selectedAccountId) return 'LINEアカウントを選択してください'
        if (loadState !== 'ready' || loadedKey !== currentKey) return '送り先の設定を読み込んでいます。読み込みが終わってから保存してください'
        if (!name.trim()) return '名前を入力してください'
        if (!/^https:\/\//.test(url.trim())) return 'URLは https:// で始めてください'
        // d23b R416: 口側と登録画面は0〜7を受け付ける。編集画面だけ狭いと、
        // 7で登録したものが他の項目の変更ごと弾かれてしまう。
        const retries = Number(maxRetries)
        if (!Number.isInteger(retries) || retries < 0 || retries > 7) {
          return '送り直しは0から7の整数にしてください'
        }
        return null
      }}
      onSave={async () => {
        if (!canManageWebhooksNow()) throw new Error('この操作はオーナーか管理者だけができます。')
        const requestAccountId = selectedAccountId
        if (!requestAccountId || selectedAccountIdRef.current !== requestAccountId) throw new Error('LINEアカウントを選択してください')
        try {
          const res = await api.webhooks.outgoing.update(id, requestAccountId, {
            name: name.trim(),
            url: url.trim(),
            eventTypes: eventTypes
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
            maxRetries: Number(maxRetries) || 0,
          })
          if (!res.success) throw new Error(res.error)
        } catch (caught) {
      saveErrors.capture(caught)
          // 保存できない時は、担当者へ依頼する案内を出す。
          if (caught instanceof ApiError && caught.status === 403) {
            throw new Error('送り先の変更はオーナーか管理者だけができます。必要なときは依頼してください。')
          }
          throw caught
        }
        /*
          d23b R422: 保存が返る前にアカウントが切り替わっていたら、切り替え
          先の画面を一覧へ飛ばさない。保存そのものは済んでいるので、完了と
          場所を確かめる案内だけ残す（例外にすると画面遷移を止められる）。
        */
        if (selectedAccountIdRef.current !== requestAccountId) {
          throw new Error('LINEアカウントが切り替わりました。保存は済んでいます。一覧から内容を確かめてください。')
        }
      }}
    >
      {loadState === 'loading' ? (
        <ListState kind="loading" title="送り先の設定を読み込んでいます" />
      ) : (
        <>
          <p className="text-ink text-sm font-semibold">基本の設定</p>

          <Field label="名前" htmlFor="wh-edit-name" required>
            <SaveErrorField names={["name"]}><SharedTextField
              id="wh-edit-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            /></SaveErrorField>
          </Field>

          <Field label="送り先のURL" htmlFor="wh-edit-url" required note="https:// のみです。">
            <SaveErrorField names={["url"]}><SharedTextField
              id="wh-edit-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className={inputClass}
            /></SaveErrorField>
          </Field>

          <Field label="送るイベント" htmlFor="wh-edit-events" note="カンマ区切り。* を入れると全部のイベントを送ります。">
            <SaveErrorField names={["eventTypes","event_types"]}><SharedTextField
              id="wh-edit-events"
              type="text"
              value={eventTypes}
              onChange={(event) => setEventTypes(event.target.value)}
              className={inputClass}
            /></SaveErrorField>
          </Field>

          <Field
            label="失敗したときの送り直し"
            htmlFor="wh-edit-retries"
            note="相手が 5xx を返したときや、つながらなかったときに送り直します。1分・5分・30分…と間隔を空け、上限は7回です。相手が 4xx を返した場合は送り直しません。"
          >
            <div className="flex items-center gap-1.5">
              <SaveErrorField names={["maxRetries","max_retries"]}><SharedTextField
                id="wh-edit-retries"
                type="number"
                min={0}
                max={7}
                value={maxRetries}
                onChange={(event) => setMaxRetries(event.target.value)}
                className={`${inputClass} w-24 tabular-nums`}
              /></SaveErrorField>
              <span className="text-ink-faint text-xs">回まで</span>
            </div>
          </Field>
        </>
      )}
    </CreatePage></SaveErrorScope>
  )
}

export default function EditWebhookPage() {
  return (
    <Suspense fallback={<div className="text-ink-faint p-6 text-sm">読み込み中…</div>}>
      <EditWebhookPageInner />
    </Suspense>
  )
}
