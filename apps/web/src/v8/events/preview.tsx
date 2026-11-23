'use client'

import { DetailPage } from '@/components/templates'

/*
 * U お客様表示確認（管理画面-29 §5）。
 * 公開条件で申込画面を確認する。運営向けの注記は帯に1本だけ置き、
 * 本文にはお客様に見える内容だけを出す。
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useResponseGate } from '@/lib/use-response-gate'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import Button from '@/components/shared/button'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import FormSection from '@/components/shared/form-section'
import ImageFrame from '@/components/shared/image-frame'
import { DataTable, TableHeadRow, Th, Td } from '@/components/shared/table'
import TargetMissing from '@/components/shared/target-missing'
import {
  eventsApi,
  type EventDetail,
  type EventSlot,
} from '@/lib/api'
import { formatDateTime } from '@/lib/format'

function formatJpRange(startsAt: string, endsAt: string): string {
  const start = Date.parse(startsAt)
  const end = Date.parse(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '日時未取得'
  const format = (time: number) =>
    formatDateTime(time)
  return `${format(start)}〜${formatDateTime(end)}`
}

function PreviewInner({ eventId }: { eventId: string }) {
  const { selectedAccountId } = useAccount()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'not-found'>('loading')
  const [event, setEvent] = useState<EventDetail | null>(null)
  const [slots, setSlots] = useState<EventSlot[]>([])

  /* WEB320：アカウント・イベントを変えたら、前の遅い応答を捨てる。 */
  const gate = useResponseGate()
  const refresh = useCallback(async () => {
    const token = gate.begin()
    if (!selectedAccountId) return
    setStatus('loading')
    try {
      const [detail, slotList] = await Promise.all([
        eventsApi.getEvent(selectedAccountId, eventId),
        eventsApi.listSlots(selectedAccountId, eventId),
      ])
      if (!gate.current(token)) return
      setEvent(detail)
      setSlots(slotList.items.filter((slot) => slot.is_active === 1))
      setStatus('ready')
    } catch (error) {
      if (!gate.current(token)) return
      if ((error as { status?: number }).status === 404) {
        setStatus('not-found')
      } else {
        setStatus('error')
      }
    }
  }, [selectedAccountId, eventId, gate])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!selectedAccountId) {
    return <ListState kind="empty" title="アカウントを選択してください。" />
  }
  if (status === 'loading') return <ListState kind="loading" />
  if (status === 'error') {
    return (
      <ListState
        kind="error"
        description="イベントは消えていません。開き直しても直らない場合はエラー報告へ。"
        action={<Button onClick={() => void refresh()}>開き直す</Button>}
      />
    )
  }
  if (status === 'not-found' || !event) {
    return (
      <TargetMissing
        kind="not-found"
        title="イベントが見つかりません"
        description="削除されたか、別のアカウントのイベントです。一覧から選び直してください。"
        backHref="/events"
        backLabel="イベント一覧へ戻る"
      />
    )
  }

  return (
    <DetailPage title="お客様表示の確認" actions={<Button href={`/events/edit?id=${eventId}`}>編集へ戻る</Button>}>
      <Notice tone="info" message="お客様に見える内容です。オンラインのURLは、確定した申込にだけ見せます。" />
      <FormSection id="event-preview-summary" title={event.name} description={event.description}>
        {event.image_url ? <ImageFrame title="イベント画像" value={event.image_url} readOnly previewAlt="" fit="contain" /> : null}
        {event.venue_name ? <p className="text-body">会場：{event.venue_name}</p> : null}
        {event.venue_url ? <p className="text-body">
          オンラインのURLは確定後に案内します
          <HelpTip label="オンラインのURLの説明">確定前の申込や、申し込んでいない人にはURLを渡しません。確定した人の予約履歴にだけ出ます。</HelpTip>
        </p> : null}
      </FormSection>
      <FormSection id="event-preview-slots" title="時間を選ぶ">
        {slots.length === 0 ? <ListState kind="empty" title="選べる時間がありません。" /> : <DataTable aria-label="選べる時間">
          <thead><TableHeadRow><Th>日時</Th><Th>定員</Th></TableHeadRow></thead>
          <tbody>{slots.map((slot) => <tr key={slot.id}>
            <Td>{formatJpRange(slot.starts_at, slot.ends_at)}</Td>
            <Td>{slot.capacity == null ? '定員なし' : `定員 ${slot.capacity}人`}</Td>
          </tr>)}</tbody>
        </DataTable>}
      </FormSection>
    </DetailPage>
  )
}

function PreviewPageInner() {
  const params = useSearchParams()
  const id = params.get('id')
  const { selectedAccountId } = useAccount()
  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="確認するイベントが指定されていません"
        description="一覧から、表示を確認するイベントを選び直してください。"
        backHref="/events"
        backLabel="イベント一覧へ戻る"
      />
    )
  }
  return <PreviewInner key={JSON.stringify([selectedAccountId, id])} eventId={id} />
}

export default function EventPreviewPage() {
  usePageTitle('お客様表示の確認')
  usePageCrumbs([{ label: 'イベント予約', href: '/events' }, { label: 'お客様表示の確認' }])
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <PreviewPageInner />
    </Suspense>
  )
}
