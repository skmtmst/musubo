'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'

import { useGooglePermission } from './use-google-permission'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SectionHeader from '@/components/shared/section-header'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import StickyBar from '@/components/shared/sticky-bar'
import { ApiError } from '@/lib/api'
import { restaurantGoogleApi, type GoogleChange, type GoogleChangeStatus, type GoogleDayHours, type GoogleProfileAddress, type GoogleWeeklyHours } from '@/lib/restaurant-google-api'
import { errorMessage, formatYmdShort, formatPeriods, WEEKDAYS, WEEKDAY_JA } from './format'
import type { GoogleNav } from './navigation-types'
import styles from './google.module.css'
import { formatNumber } from '@/lib/format'

// Missing profile workflows use the current shared V8 parts; ordinary profile board stays intact.
const formatYmdJa = (date: string, _withYear = false) => formatYmdShort(date)

const STATUS_LABEL: Record<GoogleChangeStatus, { label: string; tone: StatusBadgeTone }> = {
  draft: { label: 'まだ反映していません', tone: 'warning' },
  pending_confirm: { label: '反映確認中', tone: 'warning' },
  accepted: { label: '反映確認中', tone: 'warning' },
  applied: { label: '反映済み', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  conflict: { label: '変更競合', tone: 'danger' },
  cancelled: { label: '取り消し', tone: 'neutral' },
}

const FIELD_LABEL: Record<string, string> = { title: '店舗名', phone: '電話番号', websiteUri: 'ウェブサイト', description: '店舗紹介文', address: '住所', photo: '写真' }

function addressText(a: GoogleProfileAddress | null | undefined): string {
  if (!a) return '—'
  return [a.postalCode ? `〒${a.postalCode}` : '', a.administrativeArea ?? '', a.locality ?? '', ...a.addressLines].filter(Boolean).join(' ') || '—'
}

function describeHours(value: unknown, kind: GoogleChange['kind']): ReactNode {
  if (kind === 'special_hours') {
    const days = (value as GoogleDayHours[] | null) ?? []
    return days.map((d) => (
      <div key={d.date}>
        {days.length > 1 ? <p>{formatYmdShort(d.date)}</p> : null}
        {d.remove ? <p>特別営業時間を外す</p> : null}
        {d.remove ? <p><span>通常</span>{d.closed ? '定休日' : d.periods.map((p) => `${p.open}–${p.close === '00:00' ? '24:00' : p.close}`).join(' ／ ')}</p> : d.closed ? <p>休業</p> : d.periods.map((p, i) => <p key={i}>{p.open}–{p.close === '00:00' ? '24:00' : p.close}</p>)}
      </div>
    ))
  }
  const weekly = (value as Partial<GoogleWeeklyHours> | null) ?? {}
  return WEEKDAYS.filter((d) => weekly[d] !== undefined).map((d) => <p key={d}><span>{WEEKDAY_JA[d]}曜</span>{formatPeriods(weekly[d] ?? [], '定休日')}</p>)
}

function describeProfileValue(field: string, value: unknown): string {
  if (field === 'address') return addressText(value as GoogleProfileAddress | null)
  if (field === 'photo') {
    const v = value as { action?: string; filename?: string; mediaName?: string } | null
    return v?.action === 'add' ? `写真を追加（${v.filename ?? ''}）` : v?.action === 'delete' ? '写真を削除' : '—'
  }
  if (value === null || value === undefined || value === '') return '（未設定）'
  return String(value)
}

export function ChangeConfirmScreen({ accountId, ids, go }: { accountId: string; ids: string[]; go: GoogleNav }) {
  const operationLock = useRef(false)
  const [index, setIndex] = useState(0)
  const id = ids[index] ?? ids[0]
  const [change, setChange] = useState<GoogleChange | null>(null)
  const [store, setStore] = useState<{ id: string; name: string; timeZone: string } | null>(null)
  const [writeEnabled, setWriteEnabled] = useState(true)
  const [canSend, setCanSend] = useState(false)
  const { allowed: canEdit, lockedReason } = useGooglePermission('manager')
  const { allowed: canPublish, lockedReason: sendReason } = useGooglePermission('manager', canSend)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [conflict, setConflict] = useState<unknown>(null)
  const [sent, setSent] = useState<{ alreadyApplied: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    setChecked(false)
    setConflict(null)
    setSent(null)
    setActionError('')
    try {
      const response = await restaurantGoogleApi.change(accountId, id)
      setChange(response.change)
      setStore({ id: response.store.id, name: response.store.name, timeZone: response.store.timeZone })
      setWriteEnabled(response.writeEnabled)
      setCanSend(response.canSend)
    } catch (err) {
      setLoadError(errorMessage(err, '変更案を読み込めませんでした。'))
    } finally {
      setLoading(false)
    }
  }, [accountId, id])

  useEffect(() => { void load() }, [load])

  const send = async () => {
    if (!canPublish || operationLock.current || !checked || !writeEnabled) return
    operationLock.current = true
    setBusy(true)
    setActionError('')
    try {
      const response = await restaurantGoogleApi.sendChange(accountId, id)
      setChange(response.change)
      setSent({ alreadyApplied: response.alreadyApplied })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        const data = err.data as { current?: unknown; change?: GoogleChange } | undefined
        setConflict(data?.current ?? null)
        if (data?.change) setChange(data.change)
      } else if (err instanceof ApiError && err.status === 502) {
        await load()
        setActionError('Googleへの送信結果を確認できませんでした。重複を防ぐため、次に「Googleに変更を送信する」を押したときはGoogle側の状態を照合してから送ります。')
      } else {
        setActionError(errorMessage(err, 'Googleへの送信に失敗しました。'))
        if (err instanceof ApiError && (err.data as { change?: GoogleChange } | undefined)?.change) setChange((err.data as { change: GoogleChange }).change)
      }
    } finally {
      operationLock.current = false
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!canEdit || operationLock.current) return
    operationLock.current = true
    setBusy(true)
    try {
      await restaurantGoogleApi.cancelChange(accountId, id)
      go({ tab: 'profile' })
    } catch (err) {
      setActionError(errorMessage(err, '取り消せませんでした。'))
    } finally {
      operationLock.current = false
      setBusy(false)
    }
  }

  if (loading) return <ListState kind="loading" title="変更内容を読み込んでいます" />
  if (loadError || !change || !store) return <ListState kind="error" title="変更内容を表示できませんでした" description={loadError} onRetry={() => void load()} />

  const isHours = change.kind === 'special_hours' || change.kind === 'regular_hours'
  const field = 'field' in change.target ? change.target.field : null
  const status = STATUS_LABEL[change.status]
  const done = change.status === 'applied' || change.status === 'accepted'
  const backTo = () => (isHours ? go({ tab: 'profile', view: 'hours', mode: change.source === 'weekly' ? 'weekly' : change.source === 'calendar' ? 'calendar' : 'text' }) : go({ tab: 'profile', view: 'edit' }))
  const title = isHours
    ? change.kind === 'special_hours'
      ? `${(change.after as GoogleDayHours[]).map((d) => formatYmdJa(d.date, true)).join('・')}のみ`
      : `毎週 ${('weekdays' in change.target ? change.target.weekdays : []).map((d) => `${WEEKDAY_JA[d]}曜`).join('・')}`
    : FIELD_LABEL[field ?? ''] ?? 'プロフィール'
  const kindText = change.kind === 'special_hours' ? '特別営業時間（1日だけ）' : change.kind === 'regular_hours' ? '通常の営業時間（毎週）' : change.kind === 'photo' ? 'プロフィール（写真）' : `プロフィール（${FIELD_LABEL[field ?? ''] ?? ''}）`
  const scopeText = change.kind === 'special_hours'
    ? '通常の営業時間・ほかの日付の営業時間は変更しません。'
    : change.kind === 'regular_hours'
      ? '変えていない曜日・特別営業時間は変更しません。特別営業時間が設定されている日は、そちらが優先されます。'
      : `${['店舗名', '住所', '電話', '営業時間', '写真'].filter((x) => x !== FIELD_LABEL[field ?? '']).join('・')}は変更しません。${field === 'address' ? '住所を変えた場合は、Googleが本人確認（はがきの郵送など）を求めることがあります。' : ''}`
  const afterNote = change.kind === 'special_hours'
    ? (() => { const days = change.after as GoogleDayHours[]; const before = (change.before as GoogleDayHours[] | null) ?? []; return days.every((d) => d.remove) ? `${days.length === 1 ? 'この日' : `${days.length}日分`}の特別営業時間をGoogleから外します。以後はその曜日の通常の営業時間になります。` : days.length === 1 && before[0] ? (days[0].closed ? `この日の${before[0].periods.length}枠をすべて外し、休業にします。` : `この日の${before[0].closed ? '休業' : `${before[0].periods.length}枠`}を、上記の${days[0].periods.length}枠に置き換えます。`) : `${days.length}日分の特別営業時間を置き換えます。` })()
    : change.kind === 'regular_hours'
      ? '対象の曜日だけを置き換え、毎週この時間になります。'
      : field === 'description'
        ? `文字数 ${String((change.before as string | null) ?? '').length} → ${String((change.after as string | null) ?? '').length}（上限 750）。改行はそのまま反映されます。`
        : field === 'photo'
          ? '写真はGoogleの審査後に反映されます。'
          : 'Googleの審査後に反映されることがあります。'
  const beforeNode = isHours ? describeHours(change.before, change.kind) : <p className={styles.factValue}>{describeProfileValue(field ?? '', change.before)}</p>
  const afterNode = isHours ? describeHours(change.after, change.kind) : <p className={styles.factValue}>{describeProfileValue(field ?? '', change.after)}</p>
  const canPress = canPublish && writeEnabled && checked && !busy && !done && change.status !== 'cancelled' && conflict === null

  return (
    <>
      <SectionHeader title={done ? (isHours ? '営業時間の変更をGoogleに送信しました' : 'プロフィールの変更をGoogleに送信しました') : isHours ? 'この内容で営業時間を変更しますか？' : 'この内容でプロフィールを変更しますか？'}
        note={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
        help={isHours ? '反映直前にGoogleの最新情報を再確認します。他の担当者が変更していた場合は、差分を表示して止めます。' : '反映直前にGoogleの最新情報を再確認します。他の担当者が同じ項目を変更していた場合は、差分を表示して止めます。'}
        helpLabel="変更の確かめ方の説明" />
      <OperationTargetSummary accounts={[{ id: accountId }]} store={store} />
      <p className={styles.muted}>{`対象店舗：${store.name} / ${isHours ? store.timeZone : `変更する項目：${FIELD_LABEL[field ?? ''] ?? ''}`}`}</p>
      {ids.length > 1 ? <p className={styles.muted}>{index + 1} / {formatNumber(ids.length)}件目</p> : null}
      {sent ? <Notice tone="success">{sent.alreadyApplied ? 'この内容はすでにGoogleに反映されていました。送信はしていません。' : change.status === 'applied' ? 'Googleに変更を送信し、反映を確認しました。' : 'Googleに変更を送信しました。反映を確認できるまで「反映確認中」と表示します。審査・同期に時間がかかることがあります。'}</Notice> : null}
      {conflict !== null ? <Notice tone="warn" role="alert" action={<Button variant="text" onClick={() => go({ tab: 'profile' })}>最新の内容を確認する</Button>}>
        別の担当者が{isHours ? '営業時間' : 'この項目'}を変更しました。古い値で上書きしないため送信を止めました。Google側の現在の値：{isHours ? describeHours(conflict, change.kind) : describeProfileValue(field ?? '', conflict)}
      </Notice> : null}
      {change.status === 'pending_confirm' && !sent ? <Notice tone="warn">前回の送信結果を確認できていません。{canPublish && writeEnabled ? '「Googleに変更を送信する」を押すと、先にGoogle側の状態を照合してから送信します。' : 'Google側の状態を確認してください。'}</Notice> : null}
      {change.status === 'failed' && !sent ? <Notice tone="danger">前回の送信は失敗しました{change.error ? `（${change.error}）` : ''}。{canPublish && writeEnabled ? '内容を確認して、もう一度送信できます。' : 'Google側の状態を確認してください。'}</Notice> : null}
      {change.status === 'cancelled' ? <Notice tone="warn">この変更は取り消されています。</Notice> : null}
      {!writeEnabled ? <Notice tone="warn">この環境ではGoogleへの送信が許可されていません。変更案の作成と確認まではできます。</Notice> : null}
      {writeEnabled && !canSend ? <Notice tone="warn">Googleへの送信は店舗管理者以上が行います。この変更案は保存されているので、管理者が「変更履歴」から確認して送信できます。</Notice> : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
        <SectionHeader size="small" title={title} />
        <dl className={styles.facts}>
          <div className={styles.factRow}><dt className={styles.factKey}>現在</dt><dd className={styles.factValue}>{beforeNode}</dd></div>
          <div className={styles.factRow}><dt className={styles.factKey}>変更後</dt><dd className={styles.factValue}>{afterNode}</dd></div>
        </dl>
        <p className={styles.muted}>{afterNote}</p>
        <p className={styles.fieldLabel}>変更の種類：{kindText}</p>
        <p className={styles.muted}>{scopeText}</p>
        {isHours ? <p className={styles.muted}>{change.reservationImpactCount > 0 ? `予約への影響：変更後の営業時間の外に始まる予約が ${formatNumber(change.reservationImpactCount)}件 あります（予約台帳で確認してください）` : '予約への影響はありません'}</p> : null}
        {change.inputText ? <p className={styles.muted}>入力した文章：「{change.inputText}」</p> : null}
      </Card>
      {/* 決まり2: 確かめ方の説明は帯にせず、題の横の「？」へ入れる。 */}
      {!done && change.status !== 'cancelled' ? <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
        <Checkbox checked={checked} onCheckedChange={setChecked} description={null}>
          {isHours ? '店舗・日付・時間を確認しました' : '店舗・項目・内容を確認しました'}
        </Checkbox>
        <p className={styles.muted}>反映後にGoogleから再取得して確認します。審査・同期に時間がかかる場合は「反映確認中」と表示します。</p>
        <p className={styles.muted}>送信した担当者・対象項目・日時を記録します。失敗時も同じ変更を重複して送信しません。</p>
      </Card> : null}
      <StickyBar actions={done || change.status === 'cancelled' ? <>
        {ids.length > 1 && index < ids.length - 1 ? <Button variant="primary" onClick={() => setIndex(index + 1)}>次の変更へ</Button> : null}
        <Button onClick={() => go({ tab: 'profile', view: 'history' })}>変更履歴を見る</Button>
      </> : <>
        <Button lockedReason={lockedReason} onClick={() => { if (canEdit) backTo() }} disabled={!canEdit || busy}>修正する</Button>
        {change.status === 'failed' || change.status === 'conflict' ? <Button lockedReason={lockedReason} onClick={() => void cancel()} disabled={!canEdit || busy}>キャンセル</Button> : null}
        {writeEnabled ? <Button variant="primary" lockedReason={sendReason} onClick={() => void send()} disabled={!canPress} busy={busy} busyLabel="送信中…">Googleに変更を送信する</Button> : null}
      </>} />
    </>
  )
}
