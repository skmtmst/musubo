'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { DialogFormRow } from '@/components/shared/dialog-form-row'
import { Field } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import SectionHeader from '@/components/shared/section-header'
import StatusBadge from '@/components/shared/status-badge'
import { TextArea } from '@/components/shared/text-field'
import { notifyToast } from '@/components/shared/toast'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { describeApiFailure, isForbiddenOrRateLimited, loadFailureCopy } from '@/components/shared/api-error-message'
import { ApiError, bookingApi } from '@/lib/api'
import { bookingCalendarApi, type BookingExternalCleanupItem } from '@/lib/api/helpers/gap1'
import { formatListTimestamp, formatNumber } from '@/lib/format'
import { canAdministerRole, useStaffRole } from '@/lib/staff-role'
import { onlyWhenVisible } from '@/lib/visible-polling'
import { readPermissionSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import styles from './screen.module.css'

/*
 * 外部の予定・会議の確認（運用状態 › 健全性チェック）。
 *
 * お客さまのデータを削除したあと、相手のサービス（Google カレンダー・Zoom など）の予定や会議を自動で片づけられたか
 * 確かめられなかったものを並べる。一覧は閲覧のみを含めて見られ、記録はオーナーと管理者だけが確認窓から行う
 * （ほかの人と代理ログイン中は灰色のボタンと理由の吹き出し）。理由は任意で、監査の記録に残る。
 * 外部の ID やお客さまの情報は口が返さないので、種類・担当・予定の日時だけを出す。
 * 読めないときは「確認が要るものは無い」と扱わない。
 */

type Provider = NonNullable<BookingExternalCleanupItem['provider']>
type Load = { state: 'loading' } | { state: 'ready'; items: BookingExternalCleanupItem[] } | { state: 'error'; error: unknown }

const KIND_LABEL: Record<Provider, string> = {
  google_calendar: 'Google カレンダーの予定',
  google_meet: 'Google Meet の会議',
  zoom: 'Zoom の会議',
  teams: 'Microsoft Teams の会議',
  outlook: 'Outlook カレンダーの予定',
}
/** 予定が残ると空き枠の計算に入る相手のサービス（会議の URL だけのサービスは空き枠に関わらない）。 */
const CALENDAR_PROVIDERS: ReadonlySet<Provider> = new Set(['google_calendar', 'outlook'])
const RELOAD_EVERY_MS = 5 * 60 * 1000
/** 口が1回に返す上限（古い順）。上限ちょうどのときは、全部の件数だと思わせない。 */
const LIST_LIMIT = 100
/** 記録の理由の上限（口と同じ）。 */
const REASON_MAX = 200
const REASON_FIELD_ID = 'external-cleanup-reason'

function subscribeSession(listener: () => void) {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, listener)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, listener)
}

function kindLabel(item: BookingExternalCleanupItem): string {
  return item.provider ? KIND_LABEL[item.provider] : '種類の分からない外部の予定'
}

/** 一覧の1行と確認窓で同じ言い方にする。分からない値は「—」。種類・担当・日時の全部が無いときは1文にまとめる。 */
function summaryOf(item: BookingExternalCleanupItem, staffNames: ReadonlyMap<string, string> | null): string {
  if (!item.provider && !item.staffId && !item.startsAt) return '種類の分からない外部の予定（担当・日時の記録なし）'
  const staff = (item.staffId && staffNames?.get(item.staffId)) || '—'
  // 日付と時刻は1つのかたまりで読むので、その間では折り返さない。
  const startsAt = formatListTimestamp(item.startsAt).replace(' ', ' ')
  return `${kindLabel(item)}・担当：${staff}・予定：${startsAt}`
}

function confirmDescription(item: BookingExternalCleanupItem, staffNames: ReadonlyMap<string, string> | null): string {
  const base = `${summaryOf(item, staffNames)}。記録すると、この一覧から消えます。`
  if (item.provider && !CALENDAR_PROVIDERS.has(item.provider)) return base
  const past = `${base}終わった予定は、お客さまの名前などを消してあれば記録できます。`
  return item.provider ? `${past}相手のサービスに予定が残っていると、その時間は予約の空きから外れます。` : past
}

/** 理由が長すぎる・文字でないと口が断った（既知のコード表に無いので文言でも見る）。 */
function isReasonRejected(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && (error.code === 'invalid_reason' || error.message === 'invalid_reason')
}

export function ExternalCleanupSection({ accountId, reloadRequest }: { accountId: string | null; reloadRequest: number }) {
  const role = useStaffRole()
  const isAdministrator = canAdministerRole(role)
  const roleLockedReason = usePermissionLockReason(isAdministrator, 'manager')
  // 記録は本人の操作として監査に残すので、代理ログインは閲覧・書込のどちらでも口が断る。
  const session = useSyncExternalStore(subscribeSession, readPermissionSessionSnapshot, () => null)
  const lockedReason = session?.impersonation ? PERMISSION_LOCK_REASON.impersonationAny : roleLockedReason
  const canResolve = isAdministrator && !lockedReason
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [staffNames, setStaffNames] = useState<ReadonlyMap<string, string> | null>(null)
  const [target, setTarget] = useState<BookingExternalCleanupItem | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState('')
  const [busy, setBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  /* アカウントが変わるたびに進め、前のアカウントへの記録の結果を捨てる。 */
  const scope = useRef(0)
  /* 読み込みのたびに進め、古い応答で新しい一覧を上書きしない。 */
  const loadSeq = useRef(0)
  const resolving = useRef(false)

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current
    if (!accountId) return
    try {
      const response = await bookingCalendarApi.listExternalCleanups(accountId)
      const items: unknown = response?.data?.items
      // 形の違う応答を「確認が要るものは無い」と読まない。
      if (!Array.isArray(items)) throw new Error('invalid_response')
      if (seq === loadSeq.current) setLoad({ state: 'ready', items: items as BookingExternalCleanupItem[] })
    } catch (error) {
      if (seq === loadSeq.current) setLoad({ state: 'error', error })
    }
  }, [accountId])
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  useEffect(() => {
    scope.current++
    resolving.current = false
    setLoad({ state: 'loading' }); setStaffNames(null); setTarget(null); setReason(''); setReasonError(''); setBusy(false); setResolveError(''); setNotice(null)
    void reload()
    const timer = window.setInterval(onlyWhenVisible(() => { void reload() }), RELOAD_EVERY_MS)
    return () => { loadSeq.current++; window.clearInterval(timer) }
  }, [reload])
  /* 頭の「いますぐ確かめる」に合わせて読み直す。いま出ている一覧は新しい応答が来るまで残す。 */
  const handledRequest = useRef(reloadRequest)
  useEffect(() => {
    if (handledRequest.current === reloadRequest) return
    handledRequest.current = reloadRequest
    void reloadRef.current()
  }, [reloadRequest])

  const hasItems = load.state === 'ready' && load.items.length > 0
  useEffect(() => {
    if (!hasItems || !accountId || staffNames) return
    let alive = true
    // 担当の名前が読めなくても、一覧と記録は使える。読めない担当は「—」と出す。
    void Promise.resolve().then(() => bookingApi.listStaff(accountId)).then((response) => {
      if (alive) setStaffNames(new Map(response.staff.map((person) => [person.id, person.display_name || person.name])))
    }).catch(() => undefined)
    return () => { alive = false }
  }, [accountId, hasItems, staffNames])

  function open(item: BookingExternalCleanupItem) {
    if (!canResolve) return
    setNotice(null); setResolveError(''); setReason(''); setReasonError(''); setTarget(item)
  }

  function close() {
    if (busy) return
    setTarget(null); setReason(''); setReasonError(''); setResolveError('')
  }

  async function resolve() {
    const item = target
    if (!item || !accountId || !canResolve || resolving.current) return
    const note = reason.trim()
    if (note.length > REASON_MAX) { setReasonError(`理由は ${formatNumber(REASON_MAX)} 文字以内で入力してください。`); return }
    const started = scope.current
    resolving.current = true
    setBusy(true); setResolveError(''); setReasonError('')
    try {
      await bookingCalendarApi.resolveExternalCleanup(accountId, item.id, note || undefined)
      if (started !== scope.current) return
      setLoad((current) => current.state === 'ready' ? { state: 'ready', items: current.items.filter((row) => row.id !== item.id) } : current)
      setTarget(null); setReason('')
      notifyToast('片づけ済みにしました。', { tone: 'success' })
      void reload()
    } catch (error) {
      if (started !== scope.current) return
      if (error instanceof ApiError && error.status === 404) {
        // ほかの人が先に記録した・自動で片づいた。古い行を残さず一覧を読み直す。
        setTarget(null); setReason('')
        setNotice('ほかの人が先に記録したか、状態が変わりました。一覧を読み直しました。')
        void reload()
      } else if (isReasonRejected(error)) {
        setReasonError(`理由は ${formatNumber(REASON_MAX)} 文字以内で入力してください。`)
      } else {
        setResolveError(describeApiFailure(error, '記録'))
      }
    } finally {
      if (started === scope.current) { resolving.current = false; setBusy(false) }
    }
  }

  if (!accountId || load.state === 'loading') return null
  if (load.state === 'error') {
    const copy = isForbiddenOrRateLimited(load.error)
      ? loadFailureCopy(load.error, '外部の予定・会議の確認')
      : { title: '外部の予定・会議の確認を読み込めませんでした', description: '確認が要るものは無いとは扱いません。時間をおいて、もう一度読み込んでください。', retryable: true }
    return (
      <Notice tone="danger" heading={copy.title} action={copy.retryable ? <Button variant="secondary" onClick={() => void reload()}>もう一度読み込む</Button> : undefined}>
        {copy.description}
      </Notice>
    )
  }
  if (!load.items.length && !notice) return null
  // 上限ちょうどなら、まだ続きがあるかもしれない。記録すると次の読み込みで続きが出る。
  const capped = load.items.length >= LIST_LIMIT
  return (
    <section className={styles.alerts} aria-label="外部の予定・会議の確認">
      <SectionHeader
        title={capped ? `外部の予定・会議の確認 ${formatNumber(LIST_LIMIT)} 件以上` : `外部の予定・会議の確認 ${formatNumber(load.items.length)} 件`}
        note={capped ? `古い順に先頭 ${formatNumber(LIST_LIMIT)} 件を表示` : undefined}
        helpLabel="外部の予定・会議の確認の説明"
        help={`お客さまのデータを削除したとき、相手のサービスの予定や会議を自動で片づけられたか確かめられなかったものです。担当者の連携先で削除するか、終わった予定はお客さまの情報を消してから、［片づけ済みにする］で記録してください。一度に出すのは古い順に ${formatNumber(LIST_LIMIT)} 件までで、記録すると続きが出ます。`}
      />
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      {load.items.length ? (
        <div className={styles.alertRows}>
          {load.items.map((item) => {
            const text = summaryOf(item, staffNames)
            return (
              <div key={item.id} className={styles.alertRow}>
                <div className={styles.alertLine}>
                  <StatusBadge tone="caution">要確認</StatusBadge>
                  <p className={styles.alertText} title={text}>{text}</p>
                  {/* 本人が分からない間は理由を出さず押せない形にし、分かってから灰色＋理由の吹き出しにする。 */}
                  <Button variant="secondary" lockedReason={canResolve ? undefined : lockedReason} disabled={busy || (!canResolve && !lockedReason)} onClick={() => open(item)}>片づけ済みにする</Button>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      <ConfirmDialog
        open={target !== null}
        contentLayout="form"
        dirty={reason.trim().length > 0}
        title="相手のサービスで消したことを確かめましたか？"
        description={target ? confirmDescription(target, staffNames) : ''}
        confirmLabel="片づけ済みにする"
        busy={busy}
        busyLabel="記録しています…"
        error={resolveError || undefined}
        onConfirm={() => { void resolve() }}
        onCancel={close}
      >
        <DialogFormRow>
          <Field
            label="理由"
            htmlFor={REASON_FIELD_ID}
            optional
            note="お客さまの名前・連絡先・予約の内容は書かないでください。"
            count={{ value: reason.length, max: REASON_MAX }}
            error={reasonError || undefined}
          >
            <TextArea
              id={REASON_FIELD_ID}
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
              placeholder="例：Zoom の管理画面で会議を削除した"
              disabled={busy}
              onChange={(event) => { setReason(event.target.value); setReasonError('') }}
            />
          </Field>
        </DialogFormRow>
      </ConfirmDialog>
    </section>
  )
}
