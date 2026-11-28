'use client'

import { knownValue } from '@/lib/known-value'

import Card, { CardHeader } from '@/components/shared/card'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { RowActions } from '@/components/shared/row-actions'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { emptyValue } from '@/components/shared/empty-value'
import { formatDate, formatNumber } from '@/lib/format'
import type { BookingChannel, BookingChannelStaff, BookingChannelsData } from './lib/booking-channels'
import ch from './channels.module.css'

const TABLE_LAYOUT = { headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--polish-space-card)', padding: '0 var(--polish-space-section)', bodyTextSize: 'var(--polish-text-body)', collapseScope: 'page' as const }
const CHANNEL_LABEL: Record<string, { name: string; sub: string; how: string }> = {
  line: { name: 'LINE（musubo の予約）', sub: '予約ページ・リッチメニュー', how: 'そのまま予約管理へ' },
  manual: { name: '電話・店頭', sub: 'スタッフが入れる', how: '予約管理で手入力' },
  hot_pepper_beauty: { name: 'Hot Pepper Beauty', sub: '予約サイト', how: 'Google に書き出し / メールを読む' },
  epark: { name: 'EPARK', sub: '予約通知メール', how: '予約通知メールを読む' },
}
/*
 * 予約経路の行末には、今ある行き先だけを出す：
 * 入った予約を見る（予約管理）と、Google カレンダー経由の媒体はスタッフのカレンダーの段へ。
 */
function channelMenu(key: string): ActionMenuItem[] {
  return [
    { id: 'bookings', label: '予約管理で見る', href: '/booking/bookings' },
    ...(key === 'hot_pepper_beauty' ? [{ id: 'calendar', label: 'スタッフのカレンダーを確かめる', onSelect: () => document.getElementById('channels-calendar-heading')?.scrollIntoView({ block: 'start' }) }] : []),
  ]
}
export function formatReadAt(value: string | null) { return formatDate(value, { style: 'list' }) }
export function StaffStatusChip({ status }: { status: BookingChannelStaff['status'] }) {
  if (status === 'connected') return <StatusBadge tone="success">つながっている</StatusBadge>
  if (status === 'expired') return <StatusBadge tone="danger">期限切れ</StatusBadge>
  return <StatusBadge tone="neutral">つないでいない</StatusBadge>
}
function ChannelStatusChip({ channel }: { channel: BookingChannel }) {
  if (channel.status === 'active') return <StatusBadge tone="success">使っている</StatusBadge>
  if (channel.status === 'confirm') return <StatusBadge tone="warning">確認中</StatusBadge>
  return <StatusBadge tone="neutral">まだ届いていない</StatusBadge>
}
function OneLine({ text, tone }: { text: string; tone?: 'name' | 'sub' }) {
  return <span className={tone === 'name' ? `${ch.oneLine} ${ch.name}` : tone === 'sub' ? `${ch.oneLine} ${ch.sub}` : ch.oneLine}><TruncatedText value={text} /></span>
}

export default function ChannelsTables({ data, canEdit, roles, calendars, onDetail, onConnect }: {
  data: BookingChannelsData
  canEdit: boolean
  roles: Record<string, string>
  calendars: Record<string, string>
  onDetail: (person: BookingChannelStaff) => void
  onConnect: (person: BookingChannelStaff) => void
}) {
  const editLock = usePermissionLockReason(canEdit)
  const connect = (person: BookingChannelStaff) => { if (canEdit && !editLock) onConnect(person) }
  return <>
    <Card variant="records" aria-labelledby="channels-calendar-heading">
      <CardHeader size="content" titleId="channels-calendar-heading" title="スタッフの Google カレンダー" />
      <p data-card-footer className={ch.cardDesc}>カレンダーの予定は「埋まっている時間」として扱います。LINE で入った予約は、そのスタッフのカレンダーに書き込みます。</p>
      <DataTable aria-label="スタッフの Google カレンダー" columnSizing="content" columnLayout={TABLE_LAYOUT}>
        <thead><TableHeadRow data-table-layout="columns"><Th grow truncate>スタッフ</Th><Th collapseAt="narrow" truncate>カレンダー</Th><Th truncate>状態</Th><Th align="right" truncate>外の予定（今週）</Th><Th collapseAt="narrow" truncate>最後に読んだ</Th><Th showActionLabel>操作</Th></TableHeadRow></thead>
        <tbody>{data.staff.map(person => <Tr key={person.staffId} data-table-layout="columns">
          <Td grow title={`カレンダー：${calendars[person.staffId] || emptyValue('unknown')}・最後に読んだ：${formatReadAt(person.lastReadAt)}`}><span className={ch.nameCell}><OneLine text={person.displayName} tone="name" />{roles[person.staffId] ? <OneLine text={roles[person.staffId]} tone="sub" /> : null}</span></Td>
          <Td collapseAt="narrow"><TruncatedText value={calendars[person.staffId] || emptyValue('unknown')} /></Td>
          <Td><StaffStatusChip status={person.status} /></Td>
          <Td align="right"><TruncatedText value={person.externalEventsThisWeek == null ? emptyValue('unknown') : `${person.externalEventsThisWeek}件`} /></Td>
          <Td collapseAt="narrow"><TruncatedText value={formatReadAt(person.lastReadAt)} /></Td>
          <ActionCell><RowActions
            subjectName={person.displayName}
            detail={person.status === 'connected'
              ? { label: '予定を見る', onClick: () => onDetail(person) }
              : { label: person.status === 'not_connected' ? 'つなぐ' : 'つなぎ直す', onClick: () => connect(person), disabled: !canEdit, lockedReason: editLock }}
            menuItems={[person.status === 'connected'
              ? { id: 'calendar', label: '予定を見る', onSelect: () => onDetail(person) }
              : { id: 'connect', label: person.status === 'not_connected' ? 'つなぐ' : 'つなぎ直す', onSelect: () => connect(person), disabled: !canEdit, lockedReason: editLock }]}
          /></ActionCell>
        </Tr>)}</tbody>
      </DataTable>
    </Card>
    <Card variant="records" aria-labelledby="channels-route-heading">
      <CardHeader size="content" titleId="channels-route-heading" title="予約経路" />
      <p data-card-footer className={ch.cardDesc}>どこから入った予約も「予約管理」に集めます。入り口ごとの受け取り方と、今日の件数です。</p>
      <DataTable aria-label="予約経路" columnSizing="content" columnLayout={TABLE_LAYOUT}>
        <thead><TableHeadRow data-table-layout="columns"><Th grow truncate>予約経路</Th><Th collapseAt="narrow" truncate>受け取り方</Th><Th truncate>状態</Th><Th align="right" truncate>今日の予約</Th><Th collapseAt="narrow" truncate>最後に届いた</Th><Th showActionLabel>操作</Th></TableHeadRow></thead>
        <tbody>{data.channels.filter(channel => channel.key !== 'google_reserve').map(channel => {
          const label = knownValue(CHANNEL_LABEL, channel.key, { name: channel.key, sub: '', how: '' })
          return <Tr key={channel.key} data-table-layout="columns">
            <Td grow title={`受け取り方：${label.how || emptyValue('unknown')}`}><span className={ch.nameCell}><OneLine text={label.name} tone="name" />{label.sub ? <OneLine text={label.sub} tone="sub" /> : null}</span></Td>
            <Td collapseAt="narrow"><TruncatedText value={label.how || emptyValue('unknown')} /></Td>
            <Td><ChannelStatusChip channel={channel} /></Td><Td align="right" data-list-number><TruncatedText value={channel.todayCount == null ? emptyValue('unknown') : `${formatNumber(channel.todayCount)}件`} /></Td>
            <Td collapseAt="narrow">{emptyValue('unknown')}</Td>
            <ActionCell><RowActions
              subjectName={label.name}
              detail={{ label: '予約管理へ', href: '/booking/bookings' }}
              menuItems={channelMenu(channel.key)}
            /></ActionCell>
          </Tr>
        })}</tbody>
      </DataTable>
    </Card>
  </>
}
