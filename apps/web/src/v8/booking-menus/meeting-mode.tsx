'use client'

import { RadioGroup } from '@/components/shared/radio'

import { useCallback, useEffect, useState } from 'react'
import { Video } from 'lucide-react'
import Card, { CardHeader } from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import Radio from '@/components/shared/radio'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { bookingCalendarApi } from '@/lib/api/helpers/gap1'
import { fetchApi } from '@/lib/api'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'
import styles from './meeting-mode.module.css'

/*
 * 予約メニューの「会い方」（B7・絵 ELruS）：オンライン／対面／お客さまが選ぶ と、会議の URL。
 * 会い方は今ある口（styleApi.saveMenu の meetingMode・メニューの版つき）、固定の URL は gap1 の口（版つき）。
 * 会議の自動発行（Meet・Zoom・Teams）は次の段（口が 409 automatic_meeting_not_available）→ 押すと共通の準備中。
 */

export type MeetingMode = 'online' | 'in_person' | 'customer_choice'

export function useMenuMeeting(accountId: string | null, menuId: string | null, initialMode: MeetingMode | null) {
  const [savedMode, setSavedMode] = useState<MeetingMode>(initialMode ?? 'in_person')
  const [mode, setMode] = useState<MeetingMode>(initialMode ?? 'in_person')
  const [url, setUrl] = useState<{ value: string; saved: string; version: number } | null>(null)
  const [urlStatus, setUrlStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [urlAttempt, setUrlAttempt] = useState(0)
  useEffect(() => { setSavedMode(initialMode ?? 'in_person'); setMode(initialMode ?? 'in_person') }, [initialMode, menuId])
  useEffect(() => {
    if (!accountId) { setUrl(null); setUrlStatus('loading'); return }
    /* 作る画面：空の URL から始め、メニューができてから同じ口へ送る（版 0）。 */
    if (!menuId) { setUrl({ value: '', saved: '', version: 0 }); setUrlStatus('ready'); return }
    let alive = true
    setUrl(null)
    setUrlStatus('loading')
    void Promise.resolve().then(() => bookingCalendarApi.getMenuUrl(accountId, menuId))
      .then((response) => { if (alive) { setUrl({ value: response.data.url ?? '', saved: response.data.url ?? '', version: response.data.version }); setUrlStatus('ready') } })
      .catch(() => { if (alive) { setUrl(null); setUrlStatus('error') } })
    return () => { alive = false }
  }, [accountId, menuId, urlAttempt])
  const urlDirty = url !== null && url.value.trim() !== url.saved
  const dirty = mode !== savedMode || urlDirty
  const urlInvalid = url !== null && url.value.trim() !== '' && !/^https:\/\/\S+$/.test(url.value.trim())
  /** メニューを保存したあとに呼ぶ（メニューの版を受け取り、新しい版を返す）。 */
  const save = useCallback(async (id: string, menuVersion: number): Promise<number> => {
    if (!accountId) return menuVersion
    let version = menuVersion
    if (mode !== savedMode) {
      /* styleApi.saveMenu と同じ口（PATCH /api/dashboard/style/menus/:id）。api-styles は .js 付きの読み込みで開発サーバーが読めないので直に呼ぶ。 */
      const response = await fetchApi<{ success: true; data: { version: number } }>(`/api/dashboard/style/menus/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: menuVersion, meetingMode: mode }) })
      version = response.data.version
      setSavedMode(mode)
    }
    if (url && urlDirty && !urlInvalid) {
      const response = await bookingCalendarApi.saveMenuUrl(accountId, id, url.value.trim() || null, url.version)
      setUrl({ value: response.data.url ?? '', saved: response.data.url ?? '', version: response.data.version })
    }
    return version
  }, [accountId, mode, savedMode, url, urlDirty, urlInvalid])
  return { mode, setMode, url, setUrl, urlStatus, retryUrl: () => setUrlAttempt(value => value + 1), dirty, urlInvalid, save, reset: () => { setMode(savedMode); if (url) setUrl({ ...url, value: url.saved }) } }
}
export type MenuMeetingState = ReturnType<typeof useMenuMeeting>

export function MeetingModeCard({ state, readOnly }: { state: MenuMeetingState; readOnly: boolean }) {
  const preparing = usePreparingDialog()
  const online = state.mode !== 'in_person'
  const urlNotice = online && state.urlStatus !== 'ready' ? <Notice tone={state.urlStatus === 'error' ? 'danger' : 'info'}>{state.urlStatus === 'error' ? '会議の URL を読み込めませんでした。' : '会議の URL を読み込んでいます。'}</Notice> : null
  const retry = online && state.urlStatus === 'error' ? <Button type="button" variant="secondary" onClick={state.retryUrl}>会議の URL を読み直す</Button> : null
  if (readOnly) {
    return <Card variant="form" gap="normal"><CardHeader size="stacked" title="会い方" /><p className={styles.readValue}>{state.mode === 'online' ? 'オンライン' : state.mode === 'customer_choice' ? 'お客さまが選ぶ' : '対面'}{state.url?.saved ? `・${state.url.saved}` : ''}</p>{urlNotice}{retry}</Card>
  }
  return (
    <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="会い方" help={<HelpTip label="会い方の説明">オンラインのときは、予約が決まったら会議の URL をお客さまに LINE で送ります。確定の前と取り消しのあとは URL を出しません。</HelpTip>} />
      <RadioCardGroup legend="会い方" columns={3}>
        {([
          ['online', 'オンライン', '会議の URL を送る'],
          ['in_person', '対面', 'お店・部屋で会う'],
          ['customer_choice', 'お客さまが選ぶ', '予約のときに選んでもらう'],
        ] as const).map(([value, title, note]) => (
          <RadioCard key={value} name="menu-meeting-mode" value={value} title={title} note={note} checked={state.mode === value} onChange={() => state.setMode(value)} />
        ))}
      </RadioCardGroup>
      {online ? (
        <>
          <RadioGroup className={styles.urlChoice} label="会議の URL">
            <span className={styles.label}>会議の URL</span>
            <Radio name="menu-meeting-url" checked onChange={() => undefined}>手で入れる（決まった URL）</Radio>
            <Radio name="menu-meeting-url" checked={false} onChange={() => preparing.open('会議の自動発行')}>自動で発行（予約が決まったら作る）</Radio>
          </RadioGroup>
          <div className={styles.infoBox}><Video size={16} aria-hidden="true" /><span><strong>担当の固定の URL を先に使います</strong><span className={styles.minor}>担当に URL が無いときは、このメニューの URL を使います。</span></span></div>
          {urlNotice}{retry}
          <Field label="メニューの固定の URL（担当に固定の URL が無いとき・作れなかったときに使います）" optional error={state.urlInvalid ? 'https:// で始まる URL を入れてください' : undefined}>
            <TextField aria-label="メニューの固定の URL" value={state.url?.value ?? ''} placeholder="https://zoom.us/j/…" disabled={state.url === null}
              onChange={(event) => state.url && state.setUrl({ ...state.url, value: event.target.value })} />
          </Field>
          <p className={styles.minor}>作れなかったときも予約は受けます。固定の URL も無いときは、予約の詳細に「未発行」と出て、お客さまには「前日までにお送りします」と伝えます。日時を変えたら作り直し、取り消したら消します。</p>
          <p className={styles.sample}>リマインドの見本： 明日 13:00 からです。参加はこちら → <span className={styles.token}>会議の URL</span></p>
        </>
      ) : null}
      {preparing.dialog}
    </Card>
  )
}
