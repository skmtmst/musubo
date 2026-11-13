'use client'
import { DetailContent, DetailSection } from '@/components/shared/detail-content'
import { withHonorific } from '@line-crm/shared'

import { FormLeaveGuard } from '@/components/shared/form-leave-guard'

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

import { isConflictResponse, CONFLICT_TEXT } from '@/components/shared/save-conflict'

import { DataTable, Tr, Th, Td, TableHeadRow } from '@/components/shared/table'

import { RadioGroup } from '@/components/shared/radio'

import Notice from '@/components/shared/notice'

import { useCallback, useEffect, useState } from 'react'
import { CalendarCheck, CalendarX2, Link2, Unplug, Wand2 } from 'lucide-react'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Drawer from '@/components/shared/drawer'
import Dialog from '@/components/shared/dialog'
import HelpTip from '@/components/shared/help-tip'
import Radio from '@/components/shared/radio'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import StatusBadge from '@/components/shared/status-badge'
import Toggle from '@/components/shared/toggle'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { notifySaved } from '@/components/shared/toast'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { ApiError, type BookingStaff } from '@/lib/api'
import { bookingCalendarApi } from '@/lib/api/helpers/gap1'
import type { BookingCalendarSwitch } from '@line-crm/shared'
import styles from './staff-calendar.module.css'

/*
 * 担当スタッフのつなぐ先（B7・絵 uRd8A・GcYWx）：カレンダー（読み込み・書き込みを別々にオン・オフ、初めはオフ）と会議の URL。
 * 口は gap1（bookingCalendarApi：スタッフごとの同期の切り替え・固定の会議の URL、どちらも版つき）。
 * Outlook・会議の自動発行（Meet・Zoom・Teams）・つなぎ直しは次の段 → 押すと共通の案内の窓。
 * 閲覧のみは押せるものを置かず、オン・オフと URL を文字で出す。
 */

type Load = { state: 'loading' } | { state: 'ready'; store: BookingCalendarSwitch | null; mine: BookingCalendarSwitch; url: { value: string; saved: string; version: number } | null } | { state: 'error' }
const onOff = (on: boolean | undefined) => (on ? 'オン' : 'オフ')

function saveError(cause: unknown): string {
  if (isConflictResponse(cause)) return CONFLICT_TEXT.retry
  if (cause instanceof ApiError && cause.status === 403) return 'この操作をする権限がありません。'
  if (cause instanceof ApiError && cause.status === 400) return 'https:// で始まる URL を入れてください。'
  return '保存できませんでした。もう一度お試しください。'
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
  const staffId = person?.id ?? null

  const reload = useCallback(async () => {
    if (!staffId) return
    setLoad({ state: 'loading' }); setError(null)
    try {
      const [mine, store, url] = await Promise.all([
        bookingCalendarApi.getSwitches(accountId, staffId),
        Promise.resolve().then(() => bookingCalendarApi.getSwitches(accountId)).then((response) => response.data).catch(() => null),
        Promise.resolve().then(() => bookingCalendarApi.getStaffUrl(accountId, staffId)).then((response) => response.data).catch(() => null),
      ])
      setLoad({ state: 'ready', mine: mine.data, store, url: url ? { value: url.url ?? '', saved: url.url ?? '', version: url.version } : null })
    } catch {
      setLoad({ state: 'error' })
    }
  }, [accountId, staffId])
  useEffect(() => { void reload() }, [reload])

  async function saveSwitch(next: { readEnabled: boolean; writeEnabled: boolean }, extra?: { removeFutureEvents: boolean }) {
    if (load.state !== 'ready' || !staffId) return
    setBusy(true); setError(null)
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
    setBusy(true); setError(null)
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
            <DataTable aria-label="つなぐカレンダー">
              <thead><TableHeadRow><Th>カレンダー</Th><Th>状態</Th><Th>読み込み</Th><Th>書き込み</Th></TableHeadRow></thead><tbody>
              <Tr>
                <Td><strong>Google カレンダー</strong></Td>
                <Td><StatusBadge tone={connected ? 'success' : 'danger'} size="compact">{connected ? 'つながっている' : '切れている'}</StatusBadge></Td>
                <Td>{canEdit ? <Toggle label="Google カレンダーの読み込み" checked={mine.readEnabled} disabled={busy} onChange={(on) => void saveSwitch({ readEnabled: on, writeEnabled: mine.writeEnabled })} /> : onOff(mine.readEnabled)}</Td>
                <Td>{canEdit ? <Toggle label="Google カレンダーの書き込み" checked={mine.writeEnabled} disabled={busy}
                  onChange={(on) => { if (on) void saveSwitch({ readEnabled: mine.readEnabled, writeEnabled: true }); else { setError(null); setWriteOff('keep') } }} /> : onOff(mine.writeEnabled)}</Td>
              </Tr>
              <Tr>
                <Td><strong>Outlook</strong><span className={styles.minor}>まだつないでいません</span></Td>
                <Td><StatusBadge tone="neutral" size="compact">つないでいない</StatusBadge></Td>
                <Td>{<PermissionGatedButton allowed={canEdit} size="compact" onClick={() => preparing.open('Outlook をつなぐ')}>つなぐ</PermissionGatedButton>}</Td>
              </Tr>
            </tbody></DataTable>
            <p className={styles.minor}>初めはどちらもオフです。オフにしても予約はそのまま残ります。</p>
          </DetailSection>

          <DetailSection title="会議の URL" help={<HelpTip label="会議の URL の説明">オンラインのメニューで、予約が決まったらお客さまに LINE で送る URL です。担当の固定の URL を先に使い、無いときはメニューの URL を使います。</HelpTip>}>
            {canEdit ? (
              <>
                <RadioCardGroup legend="会議の URL の出し方" columns={2}>
                  <RadioCard name={`staff-meeting-${person?.id}`} value="manual" icon={<Link2 size={20} />} title="手で入れる" note="決まった URL を毎回使う" checked onChange={() => undefined} />
                  <RadioCard name={`staff-meeting-${person?.id}`} value="auto" icon={<Wand2 size={20} />} title="自動で発行" note="予約が決まったら会議を作る" checked={false} onChange={() => preparing.open('会議の自動発行')} />
                </RadioCardGroup>
                <RadioGroup label="自動で発行するときの会議">
                  {['Google Meet', 'Zoom', 'Microsoft Teams'].map((provider) => (
                    <div key={provider} className={`${styles.row} ${styles.providerRow}`}>
                      <Radio name={`staff-meeting-provider-${person?.id}`} checked={false} onChange={() => preparing.open('会議の自動発行')}>{provider}</Radio>
                      <StatusBadge tone="neutral" size="compact">つないでいない</StatusBadge>
                      <Button size="compact" onClick={() => preparing.open(`${provider} をつなぐ`)}>つなぐ</Button>
                    </div>
                  ))}
                </RadioGroup>
                <Field label="固定の会議の URL" optional error={urlInvalid ? 'https:// で始まる URL を入れてください' : undefined}>
                  <div className={styles.urlLine}>
                    <SaveErrorField names={["url","fixedMeetingUrl"]}><TextField aria-label="固定の会議の URL" value={ready.url?.value ?? ''} placeholder="https://meet.google.com/…" disabled={ready.url === null}
                      onChange={(event) => ready.url && setLoad({ ...ready, url: { ...ready.url, value: event.target.value } })} /></SaveErrorField>

                  </div>
                </Field>
                <p className={styles.minor}>自動で作れないときにも、この URL を使います。</p>
              </>
            ) : <p className={styles.readValue}>{ready.url?.saved || '固定の URL はありません'}</p>}
          </DetailSection>

          {!connected ? (
              <Notice tone="danger" role="status" icon={<Unplug size={20} aria-hidden="true" />} action={<>
                {<PermissionGatedButton allowed={canEdit} size="compact" onClick={() => preparing.open('カレンダーのつなぎ直し')}>つなぎ直す</PermissionGatedButton>}
              </>}>
                <span><strong>この人の空きは閉じています</strong><span className={styles.minor}>Google の接続が切れました。つなぎ直すまで、この人の枠は予約できません。</span></span>
              </Notice>
          ) : null}

          {/* 書き込みをオフにする確かめ（GcYWx）：書いた予定を残すか、これから先の予定を消すか。 */}
          <Dialog open={writeOff !== null} title="書き込みをオフにしますか？" titleNote={`${person?.name ?? ''}・Google カレンダー`} size="medium" contentLayout="form"
            busy={busy} error={error ?? undefined} cancelLabel="やめる" onCancel={() => { if (!busy) setWriteOff(null) }}
            confirmLabel="書き込みをオフにする" onConfirm={() => void saveSwitch({ readEnabled: mine.readEnabled, writeEnabled: false }, { removeFutureEvents: writeOff === 'remove' })}>
            <p className={styles.body}>{`これからの予約は、${withHonorific(person?.name ?? '')}のカレンダーに書きません。予約はそのまま残ります。`}</p>
            <RadioCardGroup legend="これまでに書いた予定をどうしますか" legendVisible>
              <RadioCard name="calendar-write-off" value="keep" icon={<CalendarCheck size={16} />} title="カレンダーの予定は残す" note="いま書いてある予定はそのまま" checked={writeOff === 'keep'} onChange={() => setWriteOff('keep')} />
              <RadioCard name="calendar-write-off" value="remove" icon={<CalendarX2 size={16} />} title={`これから先の予約の予定を消す${mine.futureEventCount !== undefined ? `（${mine.futureEventCount} 件）` : ''}`} note="今日より後の予定だけ。過去の予定は消しません" checked={writeOff === 'remove'} onChange={() => setWriteOff('remove')} />
            </RadioCardGroup>
          </Dialog>
        </>
      ) : null}
      {preparing.dialog}

</DetailContent>
</Drawer>
    </SaveErrorScope>
  )
}
