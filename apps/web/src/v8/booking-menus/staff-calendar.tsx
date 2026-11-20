'use client'
import { DetailContent, DetailField, DetailSection } from '@/components/shared/detail-content'
import { withHonorific } from '@line-crm/shared'

import { FormLeaveGuard } from '@/components/shared/form-leave-guard'

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

import { isConflictResponse, CONFLICT_TEXT } from '@/components/shared/save-conflict'

import { RadioGroup } from '@/components/shared/radio'

import Notice from '@/components/shared/notice'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarCheck, CalendarX2, Unplug } from 'lucide-react'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Drawer from '@/components/shared/drawer'
import Dialog from '@/components/shared/dialog'
import HelpTip from '@/components/shared/help-tip'
import Radio from '@/components/shared/radio'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import StatusBadge from '@/components/shared/status-badge'
import { RowStatusActions } from '@/components/shared/row-actions'
import Toggle from '@/components/shared/toggle'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { notifySaved, notifyToast } from '@/components/shared/toast'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { ApiError, type BookingStaff } from '@/lib/api'
import { bookingCalendarApi } from '@/lib/api/helpers/gap1'
import type { BookingCalendarSwitch } from '@line-crm/shared'
import styles from './staff-calendar.module.css'

/*
 * 担当スタッフのつなぐ先（B7・絵 uRd8A・GcYWx）：カレンダー（読み込み・書き込みを別々にオン・オフ、初めはオフ）と会議の URL。
 * 口は gap1（bookingCalendarApi：スタッフごとの同期の切り替え・固定の会議の URL、どちらも版つき）。
 * 閲覧のみは押せるものを置かず、オン・オフと URL を文字で出す。
 */

type Load = { state: 'loading' } | { state: 'ready'; store: BookingCalendarSwitch | null; mine: BookingCalendarSwitch; url: { value: string; saved: string; version: number } | null } | { state: 'error' }
type Provider = 'google_meet' | 'zoom' | 'teams' | 'outlook'
type Connection = { state: 'ready' | 'refreshing' | 'unknown' | 'missing'; preferred: boolean; mode: 'configured' | 'mock' }
const providers = [['google_meet', 'Google Meet'], ['zoom', 'Zoom'], ['teams', 'Microsoft Teams'], ['outlook', 'Outlook カレンダー']] as const
const onOff = (on: boolean | undefined) => (on ? 'オン' : 'オフ')
const healthMessages: Record<string, string> = {
  outlook_test_staff_required: '担当者本人をテスト送信の相手に登録してください。',
  outlook_disconnected: 'Outlook カレンダーをつなぎ直してください。',
  outlook_unavailable: 'Outlook カレンダーを読み込めません。接続を確認してください。',
}

function saveError(cause: unknown, fallback = '保存できませんでした。もう一度お試しください。'): string {
  if (cause instanceof ApiError) {
    const messages: Record<string, string> = {
      outlook_test_staff_required: '担当者本人がテスト送信の相手に登録されていないため、Outlook を使えません。',
      outlook_reconnect_required: 'Outlook をつなぎ直してください。',
      calendar_read_not_available: 'カレンダーの読み込みを利用できません。',
      calendar_not_connected: 'カレンダーをつないでください。',
      meeting_not_connected: '会議サービスをつないでから選んでください。',
    }
    if (cause.code && messages[cause.code]) return messages[cause.code]
  }
  if (isConflictResponse(cause)) return CONFLICT_TEXT.retry
  if (cause instanceof ApiError && cause.status === 403) return 'この操作をする権限がありません。'
  if (cause instanceof ApiError && cause.status === 400) return 'https:// で始まる URL を入れてください。'
  return fallback
}

export function StaffCalendarPanel({ accountId, person, menuCount, canEdit, onClose }: {
  accountId: string
  person: BookingStaff | null
  menuCount: number
  canEdit: boolean
  onClose: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const preparing = usePreparingDialog()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [writeOff, setWriteOff] = useState<'keep' | 'remove' | null>(null)
  const [connections, setConnections] = useState<Partial<Record<Provider, Connection>>>({})
  const [disconnecting, setDisconnecting] = useState<Provider | null>(null)
  const loadSequence = useRef(0)
  const staffId = person?.id ?? null

  const reload = useCallback(async () => {
    if (!staffId) return
    const sequence = ++loadSequence.current
    setConnections({}); saveErrors.reset()
    setLoad({ state: 'loading' }); setError(null)
    try {
      const [mine, store, url] = await Promise.all([
        bookingCalendarApi.getSwitches(accountId, staffId),
        Promise.resolve().then(() => bookingCalendarApi.getSwitches(accountId)).then((response) => response.data).catch(() => null),
        Promise.resolve().then(() => bookingCalendarApi.getStaffUrl(accountId, staffId)).then((response) => response.data).catch(() => null),
      ])
      if (sequence !== loadSequence.current) return
      setLoad({ state: 'ready', mine: mine.data, store, url: url ? { value: url.url ?? '', saved: url.url ?? '', version: url.version } : null })
      const entries = await Promise.all(providers.map(async ([provider]) => {
        try { return [provider, (await bookingCalendarApi.connection(accountId, staffId, provider)).data] as const } catch { return null }
      }))
      if (sequence === loadSequence.current) setConnections(Object.fromEntries(entries.filter((entry) => entry !== null)))
    } catch {
      if (sequence === loadSequence.current) setLoad({ state: 'error' })
    }
  }, [accountId, staffId, saveErrors])
  useEffect(() => { void reload(); return () => { loadSequence.current++ } }, [reload])
  useEffect(() => {
    if (!staffId) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('staff') !== staffId || url.searchParams.get('account_id') !== accountId) return
    const result = url.searchParams.get('meeting_connection')
    if (result !== 'connected' && result !== 'denied' && result !== 'failed') return
    notifyToast(result === 'connected' ? '接続しました' : result === 'denied' ? '接続は許可されませんでした' : '接続できませんでした。もう一度お試しください。', { tone: result === 'connected' ? 'success' : 'error' })
    url.searchParams.delete('meeting_connection')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [accountId, staffId])

  async function connect(provider: Provider) {
    if (!staffId || !canEdit || busy) return
    setBusy(true); setError(null); saveErrors.reset()
    try {
      const response = await bookingCalendarApi.connect(accountId, staffId, provider)
      if (response.data.authorizationUrl) window.location.assign(response.data.authorizationUrl)
      else setError('接続の準備ができていません。管理者にお問い合わせください。')
    } catch (cause) {
      saveErrors.capture(cause)
      setError(saveError(cause, '接続を開始できませんでした。もう一度お試しください。'))
    } finally { setBusy(false) }
  }

  async function disconnect(provider: Provider) {
    if (!staffId || !canEdit || busy) return
    setBusy(true); setError(null); saveErrors.reset()
    try { await bookingCalendarApi.disconnect(accountId, staffId, provider); setDisconnecting(null); await reload() }
    catch (cause) { saveErrors.capture(cause); setError(saveError(cause)) } finally { setBusy(false) }
  }

  async function prefer(provider: Exclude<Provider, 'outlook'>) {
    if (!staffId || !canEdit || busy) return
    setBusy(true); setError(null); saveErrors.reset()
    try { await bookingCalendarApi.prefer(accountId, staffId, provider); await reload() }
    catch (cause) { saveErrors.capture(cause); setError(saveError(cause)) } finally { setBusy(false) }
  }

  async function saveSwitch(next: { readEnabled: boolean; writeEnabled: boolean }, extra?: { removeFutureEvents: boolean }) {
    if (load.state !== 'ready' || !staffId) return
    setBusy(true); setError(null); saveErrors.reset()
    try {
      const response = await bookingCalendarApi.saveSwitches(accountId, { ...next, expectedVersion: load.mine.version, ...(extra ? { confirmed: true, removeFutureEvents: extra.removeFutureEvents } : {}) }, staffId)
      setLoad({ ...load, mine: response.data })
      setWriteOff(null)
      notifySaved(extra ? '書き込みをオフにしました' : 'カレンダーの設定を保存しました')
    } catch (cause) {
      saveErrors.capture(cause)
      setError(saveError(cause))
    } finally {
      setBusy(false)
    }
  }

  async function saveUrl() {
    if (!canEdit || busy || urlInvalid || load.state !== 'ready' || !load.url || !staffId) return
    setBusy(true); setError(null); saveErrors.reset()
    try {
      const response = await bookingCalendarApi.saveStaffUrl(accountId, staffId, load.url.value.trim() || null, load.url.version)
      setLoad({ ...load, url: { value: response.data.url ?? '', saved: response.data.url ?? '', version: response.data.version } })
      notifySaved('会議の URL を保存しました')
    } catch (cause) {
      saveErrors.capture(cause)
      setError(saveError(cause))
    } finally {
      setBusy(false)
    }
  }

  const ready = load.state === 'ready' ? load : null
  const mine = ready?.mine
  const connected = mine?.connected !== false
  const urlInvalid = Boolean(ready?.url && ready.url.value.trim() !== '' && !/^https:\/\/\S+$/.test(ready.url.value.trim()))
  const urlDirty = Boolean(ready?.url && ready.url.value.trim() !== ready.url.saved)

  return (
    <SaveErrorScope errors={saveErrors}>
    <FormLeaveGuard dirty={person !== null && urlDirty} busy={busy} />
    {/* 共通の引き出し（幅は決まりの 540・後ろに暗い幕）。幅は画面で上書きしない。 */}
    <Drawer open={person !== null} title={person?.name ?? ''} description={person ? `${person.role ? `${person.role}・` : ''}担当メニュー ${menuCount} つ` : undefined}
      width="editor" heightMode="viewport" contentSpacing="sections" onClose={onClose} busy={busy} dirty={urlDirty} actions={urlDirty ? { primary: <Button variant="primary" busy={busy} disabled={urlInvalid} disabledReason="https:// で始まる URL を入れてください" onClick={() => void saveUrl()}>保存する</Button>, primaryAllowed: canEdit } : {}}>
<DetailContent>
      {load.state === 'loading' ? <p className={styles.minor}>読み込んでいます…</p> : null}
      {load.state === 'error' ? <div className={styles.card}><p className={styles.minor}>カレンダーの設定を読み込めませんでした。</p><Button size="compact" onClick={() => void reload()}>もう一度読み込む</Button></div> : null}
      {ready && mine ? (
        <>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <DetailSection title="カレンダー">
            {ready.store ? <p className={styles.minor}>{`店全体の同期：読み込み ${onOff(ready.store.readEnabled)}・書き込み ${onOff(ready.store.writeEnabled)}（予約設定 › 担当スタッフの上で変えます）`}</p> : null}
            <div className={`${styles.row} ${styles.providerRow} ${styles.outlookSection}`}>
              <span>Outlook カレンダー</span>
              <RowStatusActions status={<StatusBadge tone={connections.outlook?.state === 'ready' || connections.outlook?.state === 'refreshing' ? 'success' : connections.outlook?.state === 'unknown' ? 'danger' : 'neutral'} size="compact">{connections.outlook?.state === 'ready' || connections.outlook?.state === 'refreshing' ? 'つながっている' : connections.outlook?.state === 'unknown' ? '切れています' : connections.outlook ? 'つないでいない' : '確認できません'}</StatusBadge>}>
                  {canEdit && connections.outlook && (connections.outlook.state === 'ready' || connections.outlook.state === 'refreshing' ? <Button size="compact" disabled={busy} onClick={() => setDisconnecting('outlook')}>切る</Button> : <Button size="compact" disabled={busy} onClick={() => void connect('outlook')}>{connections.outlook.state === 'unknown' ? 'つなぎ直す' : 'つなぐ'}</Button>)}
              </RowStatusActions>
            </div>
            <DetailField label="予定を読み込み、空き枠から外す">{canEdit ? <Toggle label="カレンダーの読み込み" checked={mine.readEnabled} disabled={busy} onChange={(on) => void saveSwitch({ readEnabled: on, writeEnabled: mine.writeEnabled })} /> : onOff(mine.readEnabled)}</DetailField>
            <DetailField label="確定した予約をカレンダーに書く">{canEdit ? <Toggle label="カレンダーの書き込み" checked={mine.writeEnabled} disabled={busy}
              onChange={(on) => { if (on) void saveSwitch({ readEnabled: mine.readEnabled, writeEnabled: true }); else { setError(null); setWriteOff('keep') } }} /> : onOff(mine.writeEnabled)}</DetailField>
            {connections.outlook?.state === 'unknown' ? <Notice tone="danger" role="status">Outlook カレンダーをつなぎ直してください。{mine.readEnabled && ready.store?.readEnabled ? '読み込みを使っているため、この担当の新しい空き枠を閉じています。' : ''}</Notice> : null}
            {mine.health?.error_code && healthMessages[mine.health.error_code] && !(connections.outlook?.state === 'unknown' && mine.health.error_code === 'outlook_disconnected') ? <Notice tone="danger" role="status">{healthMessages[mine.health.error_code]}</Notice> : null}
            <p className={styles.minor}>初めはどちらもオフです。オフにしても予約はそのまま残ります。</p>
          </DetailSection>

          <DetailSection title="会議の URL" help={<HelpTip label="会議の URL の説明">オンラインのメニューで、予約が決まったらお客さまに LINE で送る URL です。担当の固定の URL を先に使い、無いときはメニューの URL を使います。</HelpTip>}>
            {canEdit ? (
              <>
                <RadioGroup label="自動で発行するときの会議">
                  {providers.filter(([provider]) => provider !== 'outlook').map(([provider, label]) => (
                    <div key={provider} className={`${styles.row} ${styles.providerRow}`}>
                      <span title={connections[provider]?.state !== 'ready' ? 'つなぐと選べます' : undefined}><Radio name={`staff-meeting-provider-${person?.id}`} checked={connections[provider]?.preferred ?? false} aria-disabled={busy || connections[provider]?.state !== 'ready'} aria-description={connections[provider]?.state !== 'ready' ? 'つなぐと選べます' : undefined} onClick={event => { if (busy || connections[provider]?.state !== 'ready') event.preventDefault() }} onChange={() => { if (!busy && connections[provider]?.state === 'ready' && provider !== 'outlook') void prefer(provider) }}>{label}</Radio></span>
                      <RowStatusActions status={<StatusBadge tone={connections[provider]?.state === 'ready' || connections[provider]?.state === 'refreshing' ? 'success' : connections[provider]?.state === 'unknown' ? 'danger' : 'neutral'} size="compact">{connections[provider]?.state === 'ready' || connections[provider]?.state === 'refreshing' ? 'つながっている' : connections[provider]?.state === 'unknown' ? '切れています' : connections[provider] ? 'つないでいない' : '確認できません'}</StatusBadge>}>
                        {connections[provider] && (connections[provider]?.state === 'ready' || connections[provider]?.state === 'refreshing' ? <Button size="compact" disabled={busy} onClick={() => setDisconnecting(provider)}>切る</Button> : <Button size="compact" disabled={busy} onClick={() => void connect(provider)}>{connections[provider]?.state === 'unknown' ? 'つなぎ直す' : 'つなぐ'}</Button>)}
                      </RowStatusActions>
                    </div>
                  ))}
                </RadioGroup>
                <div className={styles.fixedUrl}><Field label="固定の会議の URL" optional error={urlInvalid ? 'https:// で始まる URL を入れてください' : undefined}>
                  <div className={styles.urlLine}>
                    <SaveErrorField names={["url","fixedMeetingUrl"]}><TextField aria-label="固定の会議の URL" value={ready.url?.value ?? ''} placeholder="https://meet.google.com/…" disabled={ready.url === null}
                      onChange={(event) => ready.url && setLoad({ ...ready, url: { ...ready.url, value: event.target.value } })} /></SaveErrorField>

                  </div>
                </Field></div>
                <p className={styles.minor}>自動で作れないときにも、この URL を使います。</p>
              </>
            ) : <p className={styles.readValue}>{ready.url?.saved || '固定の URL はありません'}</p>}
          </DetailSection>

          {!connected ? (
              <Notice tone="danger" role="status" icon={<Unplug size={20} aria-hidden="true" />} action={<>
                {<PermissionGatedButton allowed={canEdit} size="compact" onClick={() => preparing.open('カレンダーのつなぎ直し')}>つなぎ直す</PermissionGatedButton>}
              </>}>
                <span><strong>カレンダーの接続を確認してください</strong><span className={styles.minor}>読み込みを使っている場合は、つなぎ直すまでこの担当の枠は予約できません。</span></span>
              </Notice>
          ) : null}

          {/* 書き込みをオフにする確かめ（GcYWx）：書いた予定を残すか、これから先の予定を消すか。 */}
          <Dialog open={writeOff !== null} title="書き込みをオフにしますか？" titleNote={`${person?.name ?? ''}・カレンダー`} size="medium" contentLayout="form"
            busy={busy} error={error ?? undefined} cancelLabel="やめる" onCancel={() => { if (!busy) setWriteOff(null) }}
            confirmLabel="書き込みをオフにする" onConfirm={() => void saveSwitch({ readEnabled: mine.readEnabled, writeEnabled: false }, { removeFutureEvents: writeOff === 'remove' })}>
            <p className={styles.body}>{`これからの予約は、${withHonorific(person?.name ?? '')}のカレンダーに書きません。予約はそのまま残ります。`}</p>
            <RadioCardGroup legend="これまでに書いた予定をどうしますか" legendVisible>
              <RadioCard name="calendar-write-off" value="keep" icon={<CalendarCheck size={16} />} title="カレンダーの予定は残す" note="いま書いてある予定はそのまま" checked={writeOff === 'keep'} onChange={() => setWriteOff('keep')} />
              <RadioCard name="calendar-write-off" value="remove" icon={<CalendarX2 size={16} />} title={`これから先の予約の予定を消す${mine.futureEventCount !== undefined ? `（${mine.futureEventCount} 件）` : ''}`} note="今日より後の予定だけ。過去の予定は消しません" checked={writeOff === 'remove'} onChange={() => setWriteOff('remove')} />
            </RadioCardGroup>
          </Dialog>
          <Dialog open={disconnecting !== null} title="接続を切りますか？" size="medium" busy={busy} error={error ?? undefined}
            cancelLabel="やめる" onCancel={() => setDisconnecting(null)} confirmLabel="接続を切る" onConfirm={() => { if (disconnecting) void disconnect(disconnecting) }}>
            <p>接続を切ると、このサービスとの同期や会議の発行はできなくなります。作成済みの会議は相手先での確認が必要になることがあります。</p>
          </Dialog>
        </>
      ) : null}
      {preparing.dialog}

</DetailContent>
</Drawer>
    </SaveErrorScope>
  )
}
