'use client'

import { RadioGroup } from '@/components/shared/radio'

import { useCallback, useEffect, useState } from 'react'
import Card, { CardHeader } from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import Radio from '@/components/shared/radio'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { bookingCalendarApi } from '@/lib/api/helpers/gap1'
import { fetchApi } from '@/lib/api'
import styles from './meeting-mode.module.css'

/*
 * 予約メニューの「会い方」（B7・絵 ELruS）：オンライン／対面／お客さまが選ぶ と、会議の URL。
 * 会い方は今ある口（styleApi.saveMenu の meetingMode・メニューの版つき）、固定の URL は gap1 の口（版つき）。
 */

export type MeetingMode = 'online' | 'in_person' | 'customer_choice'

export function useMenuMeeting(accountId: string | null, menuId: string | null, initialMode: MeetingMode | null) {
  const [savedMode, setSavedMode] = useState<MeetingMode>(initialMode ?? 'in_person')
  const [mode, setMode] = useState<MeetingMode>(initialMode ?? 'in_person')
  const [url, setUrl] = useState<{ value: string; saved: string; version: number } | null>(null)
  const [issuance, setIssuance] = useState<'manual' | 'automatic'>('manual')
  const [savedIssuance, setSavedIssuance] = useState<'manual' | 'automatic'>('manual')
  useEffect(() => { setSavedMode(initialMode ?? 'in_person'); setMode(initialMode ?? 'in_person') }, [initialMode, menuId])
  useEffect(() => {
    if (!accountId) { setUrl(null); return }
    /* 作る画面：空の URL から始め、メニューができてから同じ口へ送る（版 0）。 */
    if (!menuId) { setUrl({ value: '', saved: '', version: 0 }); setIssuance('manual'); setSavedIssuance('manual'); return }
    setUrl(null)
    let alive = true
    void Promise.resolve().then(() => bookingCalendarApi.getMenuUrl(accountId, menuId))
      .then((response) => { if (alive) { setUrl({ value: response.data.url ?? '', saved: response.data.url ?? '', version: response.data.version }); setIssuance(response.data.issuance ?? 'manual'); setSavedIssuance(response.data.issuance ?? 'manual') } })
      .catch(() => { if (alive) setUrl(null) })
    return () => { alive = false }
  }, [accountId, menuId])
  const urlDirty = url !== null && url.value.trim() !== url.saved
  const dirty = mode !== savedMode || urlDirty || issuance !== savedIssuance
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
    if (url && (urlDirty || issuance !== savedIssuance) && !urlInvalid) {
      const response = await bookingCalendarApi.saveMenuUrl(accountId, id, url.value.trim() || null, version, issuance)
      setUrl({ value: response.data.url ?? '', saved: response.data.url ?? '', version: response.data.version })
      setSavedIssuance(issuance)
      version = response.data.version
    }
    return version
  }, [accountId, mode, savedMode, url, urlDirty, urlInvalid, issuance, savedIssuance])
  return { mode, setMode, url, setUrl, issuance, setIssuance, dirty, urlInvalid, save, reset: () => { setMode(savedMode); setIssuance(savedIssuance); if (url) setUrl({ ...url, value: url.saved }) } }
}
export type MenuMeetingState = ReturnType<typeof useMenuMeeting>

export function MeetingModeCard({ state, readOnly }: { state: MenuMeetingState; readOnly: boolean }) {
  const online = state.mode !== 'in_person'
  if (readOnly) {
    return <Card variant="form" gap="normal"><CardHeader size="stacked" title="会い方" /><p className={styles.readValue}>{state.mode === 'online' ? 'オンライン' : state.mode === 'customer_choice' ? 'お客さまが選ぶ' : '対面'}{state.url ? `・${state.issuance === 'automatic' ? '自動で発行' : '手で入れる'}` : ''}{state.url?.saved ? `・${state.url.saved}` : ''}</p></Card>
  }
  return (
    <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="会い方" help={<HelpTip label="会い方の説明">オンラインのときは、予約が決まったら会議の URL をお客さまに LINE で送ります。確定の前と取り消しのあとは URL を出しません。</HelpTip>} />
      <RadioGroup label="会い方" className={styles.urlChoice}>
        {([
          ['in_person', '対面'],
          ['online', 'オンライン'],
          ['customer_choice', 'お客さまが選ぶ'],
        ] as const).map(([value, title]) => (
          <Radio key={value} name="menu-meeting-mode" value={value} checked={state.mode === value} onChange={() => state.setMode(value)}>{title}</Radio>
        ))}
      </RadioGroup>
      {online ? (
        <>
          <RadioGroup className={styles.urlChoice} label="会議の URL">
            <span className={styles.label}>会議の URL</span>
            <Radio name="menu-meeting-url" disabled={!state.url} checked={state.issuance === 'manual'} onChange={() => state.setIssuance('manual')}>手で入れる</Radio>
            <Radio name="menu-meeting-url" disabled={!state.url} checked={state.issuance === 'automatic'} onChange={() => state.setIssuance('automatic')}>自動で発行</Radio>
          </RadioGroup>
          {state.issuance === 'automatic' ? <><p className={styles.minor}>担当者がつないだ Meet・Zoom・Teams から作成します。</p><p className={styles.minor}>予約が確定した時に発行します。</p></> : null}
          <p className={styles.minor}>固定 URL を使う場合は担当の URL を優先し、なければメニューの URL を使います。</p>
          <Field label={state.issuance === 'automatic' ? '作れなかったときに使う URL' : 'メニューの固定の URL'} optional error={state.urlInvalid ? 'https:// で始まる URL を入れてください' : undefined}>
            <TextField aria-label="メニューの固定の URL" value={state.url?.value ?? ''} placeholder="https://zoom.us/j/…" disabled={state.url === null}
              onChange={(event) => state.url && state.setUrl({ ...state.url, value: event.target.value })} />
          </Field>
        </>
      ) : null}
    </Card>
  )
}
