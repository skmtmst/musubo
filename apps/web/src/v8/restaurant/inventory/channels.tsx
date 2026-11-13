'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  draft_customerName: requiredText("お客さまのお名前を入れてください。"),
}

import CopyTextButton from '@/components/shared/copy-text-button'
import { useEffect, useRef, useState } from 'react'
import { CircleHelp, Copy, FlaskConical, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { useStaffRole } from '@/lib/staff-role'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { Field } from '@/components/shared/form-controls'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import Card, { CardHeader } from '@/components/shared/card'
import KpiCard from '@/components/shared/kpi-card'
import DateTimeField from '@/components/shared/date-time-field'
import { datetimeLocalJstToUtcIso } from '@/lib/jst-datetime'
import { fetchApi } from '@/lib/api'
import { restaurantTestApi, type RestaurantIntakeAddress } from '@/lib/restaurant-test-api'
import { Status } from '@/v8/restaurant/booking-kit/public/shell/index'
import { DialogNote, RowMore, RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import { dayLabelParen, formatAt } from './format'
import styles from './inventory.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'


/*
 * ★V8 予約枠・在庫「予約経路の連携」タブ（板 `hQQlt`）。
 *
 * 取り込みアドレス（メール転送）と今日の取り込み → 予約経路の表（媒体ごとの受け取り方・状態・
 * 今日の件数・最後に届いた時刻・読めなかった数）→ 読めなかったもの（手で直して取り込む）。
 * 口：/api/restaurant-test/intake-addresses・channels・inbound-emails（・/:id/manual-import）。
 * 検証環境は受信専用。媒体へは書き戻さない。
 */

export type RestaurantChannel = {
  id: string
  code: string
  name: string
  todayCount: number | null
  lastReceivedAt: string | null
  unreadableCount: number | null
  receiveMethod: 'email_forward' | 'direct' | 'manual'
  status: 'receiving' | 'not_receiving' | 'preparing'
  daysWithoutReceipt: number | null
}

type InboundEmail = {
  id: string
  storeId: string
  receivedAt: string
  status: string
  reason: string | null
  mediaCode: string | null
  mediaName: string | null
}

const METHOD_LABEL: Record<RestaurantChannel['receiveMethod'], string> = {
  email_forward: 'メール転送',
  direct: '直接つなぐ',
  manual: '手入力',
}

function channelStatus(channel: RestaurantChannel): { value: string; label: string } {
  if (channel.status === 'preparing') return { value: 'draft-neutral', label: '未設定' }
  if (channel.status === 'not_receiving') return { value: 'warning', label: channel.daysWithoutReceipt === null ? '届いていない' : `${channel.daysWithoutReceipt}日届いていない` }
  if (channel.receiveMethod === 'direct') return { value: 'active', label: 'つながっている' }
  if (channel.receiveMethod === 'manual') return { value: 'active', label: '使っている' }
  return { value: 'active', label: '届いている' }
}

const accountQuery = (accountId: string, storeId: string) =>
  `account_id=${encodeURIComponent(accountId)}&storeId=${encodeURIComponent(storeId)}`

export default function ChannelsBoard({ accountId, storeId, storeName, date, canEdit: allowedByRole, timezone }: {
  accountId: string
  storeId: string
  storeName?: string | null
  timezone?: string
  /** 店舗の今日（YYYY-MM-DD）。「今日の取り込み」の見出しに使う。 */
  date: string
  canEdit: boolean
}) {
  const [addresses, setAddresses] = useState<RestaurantIntakeAddress[] | null>(null)
  const [channels, setChannels] = useState<RestaurantChannel[] | null>(null)
  const [emails, setEmails] = useState<InboundEmail[] | null>(null)
  const [total, setTotal] = useState(0)
  const [failed, setFailed] = useState(false)
  const [howToOpen, setHowToOpen] = useState(false)
  const [preparingChannel, setPreparingChannel] = useState<RestaurantChannel | null>(null)
  const [reissueOpen, setReissueOpen] = useState(false)
  const scope = JSON.stringify([accountId, storeId])
  const [reissueScope, setReissueScope] = useState('')
  const scopeIdentity = useRef({ key: scope })
  if (scopeIdentity.current.key !== scope) scopeIdentity.current = { key: scope }
  const reissueTicket = useRef<object | null>(null)
  const renderedScope = scopeIdentity.current
  const renderedTicket = reissueTicket.current
  useEffect(() => { setReissueOpen(false); setReissueScope(''); reissueTicket.current = null }, [scope])
  useEffect(() => () => { reissueTicket.current = null }, [])
  const role = useStaffRole()
  const lockedReason = usePermissionLockReason(allowedByRole)
  const canEdit = allowedByRole && !lockedReason
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const router = useRouter()
  const [detail, setDetail] = useState<InboundEmail | null>(null)
  const [importing, setImporting] = useState<InboundEmail | null>(null)
  const [draft, setDraft] = useState({ customerName: '', guestCount: '2', startsAt: '' })
  const importRef = useRef<HTMLDivElement>(null)
  const [fieldErrors, setFieldErrors] = useState<{ customerName?: string; guestCount?: string; startsAt?: string }>({})
  const [importError, setImportError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setFailed(false)
    Promise.all([
      /* 取り込みアドレスと読めなかったメールは管理者だけの口。閲覧のみでは空として扱う。 */
      canEdit ? restaurantTestApi.listIntakeAddresses(accountId, storeId).then((res) => res.data) : Promise.resolve([]),
      fetchApi<{ success: true; data: RestaurantChannel[] }>(`/api/restaurant-test/channels?${accountQuery(accountId, storeId)}`).then((res) => res.data),
      canEdit
        ? fetchApi<{ success: true; data: InboundEmail[]; total: number }>(`/api/restaurant-test/inbound-emails?${accountQuery(accountId, storeId)}&status=quarantined`).then((res) => res)
        : Promise.resolve({ data: [] as InboundEmail[], total: 0 }),
    ]).then(([addr, chans, mails]) => {
      if (!alive) return
      setAddresses(Array.isArray(addr) ? addr : [])
      setChannels(Array.isArray(chans) ? chans : [])
      setEmails(Array.isArray(mails.data) ? mails.data : [])
      setTotal(mails.total ?? 0)
    }).catch(() => {
      if (alive) setFailed(true)
    })
    return () => { alive = false }
  }, [accountId, storeId, canEdit, reload])

  const address = addresses?.[0]?.address ?? null


  const issue = () => {
    if (!canEdit || busy) return
    setBusy(true)
    void restaurantTestApi.issueIntakeAddress(accountId, storeId)
      .then(() => { setMessage({ tone: 'success', text: '取り込みアドレスを発行しました。' }); setReload((n) => n + 1) })
      .catch(() => setMessage({ tone: 'error', text: '取り込みアドレスを発行できませんでした。' }))
      .finally(() => setBusy(false))
  }

  const manualImport = () => {
    if (!canEdit || !importing || busy) return
    const errors: typeof fieldErrors = {}
    if ((FIELD_REQUIREMENTS.draft_customerName.check(draft.customerName) !== null)) errors.customerName = 'お客さまのお名前を入れてください。'
    const guests = Number(draft.guestCount)
    if (!Number.isInteger(guests) || guests < 1 || guests > 100) errors.guestCount = '人数は1〜100の整数で入れてください。'
    let startsAt = ''
    try { if (draft.startsAt) startsAt = datetimeLocalJstToUtcIso(draft.startsAt) } catch { /* 日時の入力欄へ理由を出す */ }
    if (!startsAt) errors.startsAt = '来店の日時を入れてください。'
    setFieldErrors(errors); setImportError('')
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => { const field = importRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]'); field?.focus(); field?.scrollIntoView?.({ block: 'center' }) })
      return
    }
    setBusy(true)
    void fetchApi(`/api/restaurant-test/inbound-emails/${encodeURIComponent(importing.id)}/manual-import?account_id=${encodeURIComponent(accountId)}`, {
      method: 'POST',
      body: JSON.stringify({ customerName: draft.customerName.trim(), guestCount: Number(draft.guestCount), startsAt }),
    })
      .then(() => { setImporting(null); setMessage({ tone: 'success', text: '予約台帳へ取り込みました。卓は空いている卓から自動で選びました。' }); setReload((n) => n + 1) })
      .catch((error: unknown) => setImportError(describeApiFailure(error, '取り込み')))
      .finally(() => setBusy(false))
  }

  if (failed) {
    return <ListState kind="error" description="予約経路を読み込めませんでした。" onRetry={() => setReload((n) => n + 1)} />
  }
  if (!addresses || !channels || !emails) return <ListState kind="loading" />

  const automaticChannels = channels.filter((channel) => channel.receiveMethod !== 'manual' && channel.status !== 'preparing')
  const received = automaticChannels.some((channel) => channel.todayCount === null)
    ? null : automaticChannels.reduce((sum, channel) => sum + (channel.todayCount ?? 0), 0)

  const rowItems = (channel: RestaurantChannel) => channel.receiveMethod === 'manual'
    ? [{ id: 'ledger', label: '予約台帳で入れる', onSelect: () => router.push('/restaurant-test/reservations') }]
    : channel.status === 'preparing'
      ? channel.receiveMethod === 'direct'
        ? [{ id: 'start', label: '直接接続の案内を見る', onSelect: () => setPreparingChannel(channel) }]
        : [{ id: 'start', label: '始める（転送の設定のしかた）', onSelect: () => setHowToOpen(true) }]
      : [{ id: 'records', label: '取り込んだ記録を見る', onSelect: () => router.push(`/restaurant-test/reservations?source=${encodeURIComponent(channel.code)}`) }]

  return (
    <div data-design-node="hQQlt" className={styles.channels}>
      {role !== null && !canEdit ? <ReadOnlyNotice /> : null}
      {message ? <Notice role="status" tone={message.tone === 'success' ? 'success' : 'danger'} message={message.text} /> : null}
      {/* 絵 mVUo3：左に取り込みアドレス（欄＋コピー・3つの操作）、右に今日の取り込み（中身の高さ）。 */}
      <div className={styles.channelCards}>
        <Card layout="vertical" padding="default" gap="tight" surface="standard" className={styles.card} aria-labelledby="rs-intake-title">
          <CardHeader size="stacked" titleId="rs-intake-title" title="予約メールの取り込みアドレス" />
          <p className={styles.cardText}>予約サイトから届く予約のお知らせメールを、このアドレスへ転送すると台帳に入ります。</p>
          <Field label="取り込みアドレス" htmlFor="rs-intake-address" optional={false}>
            <div className={styles.addressBox}>
              <TextField id="rs-intake-address" readOnly title={address ?? undefined} value={address ?? (canEdit ? 'まだ発行されていません' : '管理者だけが見られます')} />
              {address ? <CopyTextButton variant="secondary" icon={<Copy size={16} aria-hidden="true" />} value={address} aria-label="取り込みアドレスをコピー" /> : null}
            </div>
          </Field>
          <div className={styles.cardActions}>
            <Button onClick={() => setHowToOpen(true)}><CircleHelp size={16} aria-hidden="true" />転送の設定のしかた</Button>
            <Button href="/restaurant-test/reservations"><FlaskConical size={16} aria-hidden="true" />試しに受け取る（予約台帳へ）</Button>
            {address
              ? <Button lockedReason={lockedReason} onClick={() => { reissueTicket.current = {}; setReissueScope(scope); setReissueOpen(true) }} disabled={!canEdit || busy}><RefreshCw size={16} aria-hidden="true" />発行し直す（旧は 90 日で失効）</Button>
              : <Button lockedReason={lockedReason} variant="primary" disabled={!canEdit || busy} onClick={issue} busy={Boolean(busy)} busyLabel="処理中…">発行する</Button>}
          </div>
        </Card>
        <Card layout="vertical" padding="default" gap="tight" surface="standard" className={styles.todayCard} aria-labelledby="rs-today-title">
          <CardHeader size="stacked" titleId="rs-today-title" title="今日の取り込み" />
          <div className={styles.todayStats} title={`${dayLabelParen(date)}0:00〜いま`}>
            <KpiCard className={styles.todayStat} title="取り込んだ" value={received} unit={received === null ? '' : '件'} detail={null} icon={null} presentation="inline" />
            <KpiCard className={styles.todayStat} title="読めなかった" value={total} unit="件" detail={null} icon={null} presentation="inline" valueTone={total > 0 ? 'danger' : 'default'} />
          </div>
        </Card>
      </div>
      <DataTable presentation="channels">
        <thead>
          <TableHeadRow>
            <Th className={styles.chName}>経路</Th>
            <Th className={styles.chMethod}>受け取り方</Th>
            <Th className={styles.chStatus}>状態</Th>
            <Th className={styles.chToday}>今日</Th>
            <Th className={styles.chLast}>最後に届いた</Th>
            <Th className={styles.chUnread}>読めなかった</Th>
            <Th className={styles.chOps}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {channels.map((channel) => {
            const state = channelStatus(channel)
            const preparing = channel.status === 'preparing'
            return (
              <Tr key={channel.id} data-row-id={channel.id}>
                <Td><TruncatedText value={channel.name} /></Td>
                <Td><TruncatedText value={METHOD_LABEL[channel.receiveMethod]} /></Td>
                <Td><Status value={state.value} label={state.label} /></Td>
                <Td>{preparing || channel.todayCount === null ? emptyValue('unknown') : channel.todayCount}</Td>
                <Td>{preparing ? emptyValue('unknown') : formatAt(channel.lastReceivedAt, timezone)}</Td>
                <Td>{preparing || channel.receiveMethod === 'manual' ? emptyValue('unknown') : channel.unreadableCount ?? emptyValue('unknown')}</Td>
                <Td><RowMore subject={channel.name} items={rowItems(channel)} /></Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
      {canEdit ? (
        <Card layout="vertical" padding="default" gap="tight" surface="standard" className={styles.card} aria-labelledby="rs-unread-title">
          <CardHeader size="stacked" titleId="rs-unread-title" title="読めなかったもの" />
          <p className={styles.cardText}>本文は出さない</p>
          {emails.length === 0 ? (
            <ListState kind="empty" title="いま残っているものはありません" description="読めなかった予約メールは、ここに残ります。" />
          ) : emails.map((mail) => (
            <div key={mail.id} className={styles.unreadRow}>
              <p className={styles.unreadMain}><TruncatedText value={[formatAt(mail.receivedAt, timezone), mail.mediaName ?? mail.mediaCode ?? '媒体不明', mail.reason ?? '読めなかった理由は分かりません'].join('・')} /></p>
              <Button onClick={() => setDetail(mail)}>詳しく見る</Button>
              <Button variant="primary" onClick={() => { setDraft({ customerName: '', guestCount: '2', startsAt: '' }); setFieldErrors({}); setImportError(''); setImporting(mail) }}>手で直して取り込む</Button>
            </div>
          ))}
        </Card>
      ) : null}
      <RsDialog
        open={reissueOpen && reissueScope === scope}
        title="取り込みアドレスを発行し直しますか？"
        width={480}
        top={220}
        busy={busy}
        onCancel={() => { reissueTicket.current = null; setReissueOpen(false) }}
        actions={(
          <>
            <Button type="button" onClick={() => { reissueTicket.current = null; setReissueOpen(false) }} disabled={busy}>キャンセル</Button>
            <Button lockedReason={lockedReason} type="button" variant="primary" disabled={!canEdit || busy} busy={busy} busyLabel="処理中…" onClick={() => { if (!renderedTicket || renderedTicket !== reissueTicket.current || renderedScope !== scopeIdentity.current || !canEditRef.current || reissueScope !== scope) return; reissueTicket.current = null; setReissueOpen(false); issue() }}>発行し直す</Button>
          </>
        )}
      >
        <OperationTargetSummary accounts={[{ id: accountId }]} store={{ id: storeId, name: storeName }} />
        <DialogNote>新しいアドレスを発行します。今のアドレスも 90 日は受け取り、その後は使えなくなります。予約サイトの転送先を新しいアドレスへ変えてください。</DialogNote>
      </RsDialog>
      <RsDialog open={Boolean(preparingChannel)} title="直接接続はまだつなげません" width={520} top={200} onCancel={() => setPreparingChannel(null)} actions={<Button variant="primary" onClick={() => setPreparingChannel(null)}>わかった</Button>}>
        <DialogNote>{preparingChannel?.name}との直接接続は、安定して予約を取り込めるよう準備しています。開始時期は決まり次第お知らせします。</DialogNote>
      </RsDialog>
      <RsDialog
        open={howToOpen}
        title="転送の設定のしかた"
        width={560}
        top={180}
        onCancel={() => setHowToOpen(false)}
        actions={<Button variant="primary" onClick={() => setHowToOpen(false)}>わかった</Button>}
      >
        <ol className={styles.howTo}>
          <li>予約サイトの管理画面で、予約のお知らせメールの送り先を開きます。</li>
          <li>送り先に、上の取り込みアドレス{address ? `（${address}）` : ''}を足します。</li>
          <li>試しに予約を1件入れ、この画面の「今日の取り込み」に数が出るかを確かめます。</li>
        </ol>
        <DialogNote>検証環境は受信専用です。予約サイトへは書き戻しません。</DialogNote>
      </RsDialog>
      <RsDialog
        open={Boolean(detail)}
        title="読めなかったメール"
        width={520}
        top={200}
        onCancel={() => setDetail(null)}
        actions={<Button onClick={() => setDetail(null)}>閉じる</Button>}
      >
        {detail ? (
          <dl className={styles.detailList}>
            <dt>媒体</dt><dd>{detail.mediaName ?? detail.mediaCode ?? '媒体不明'}</dd>
            <dt>受信</dt><dd>{formatAt(detail.receivedAt, timezone)}</dd>
            <dt>読めなかった理由</dt><dd>{detail.reason ?? '分かりません'}</dd>
          </dl>
        ) : null}
        <DialogNote>メールの本文はこの画面には出しません。媒体の管理画面で予約の中身を確かめてから、手で直して取り込んでください。</DialogNote>
      </RsDialog>
      <RsDialog
        open={Boolean(importing)}
        title="手で直して取り込む"
        width={520}
        top={200}
        busy={busy}
        onCancel={() => setImporting(null)}
        noValidate
        onSubmit={manualImport}
        actions={(
          <>
            <Button type="button" onClick={() => setImporting(null)} disabled={busy}>キャンセル</Button>
            <Button lockedReason={lockedReason} type="submit" variant="primary" disabled={!canEdit || busy}>台帳へ取り込む</Button>
          </>
        )}
      >
        <div ref={importRef} className={styles.manualFields}>
        {importError ? <Notice tone="danger" message={importError} /> : null}
        <Field label="お客さまのお名前" htmlFor="rs-import-name" error={fieldErrors.customerName} requirement={FIELD_REQUIREMENTS.draft_customerName}>
          <SaveErrorField names={["customerName","draft.customerName","customer_name","draft.customer_name"]}><TextField id="rs-import-name" required value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} /></SaveErrorField>
        </Field>
        <div className={styles.pair}>
          <Field label="人数" htmlFor="rs-import-guests" error={fieldErrors.guestCount}>
            <SaveErrorField names={["guestCount","draft.guestCount","guest_count","draft.guest_count"]}><NumberInput id="rs-import-guests" type="number" min={1} max={100} required value={draft.guestCount} onChange={(event) => setDraft({ ...draft, guestCount: event.target.value })} /></SaveErrorField>
          </Field>
          <Field label="来店の日時" htmlFor="rs-import-at" error={fieldErrors.startsAt}>
            <SaveErrorField names={["startsAt","draft.startsAt","starts_at","draft.starts_at"]}><DateTimeField id="rs-import-at" invalid={Boolean(fieldErrors.startsAt)} required value={draft.startsAt} onChange={(next) => setDraft({ ...draft, startsAt: next })} /></SaveErrorField>
          </Field>
        </div>
        </div>
        <DialogNote>取り込むと、空いている卓から自動で選んで予約台帳に入れます。</DialogNote>
      </RsDialog>
    </div>
  )
}
