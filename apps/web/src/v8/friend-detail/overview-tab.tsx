'use client'

import { useEffect, useRef, useState } from 'react'
import StatusPill from '@/components/shared/status-pill'
import {
  Bell,
  CalendarDays,
  Link2,
  MailOpen,
  MessageCircle,
  ShoppingBag,
  Tag as TagIcon,
  Workflow,
} from 'lucide-react'
import type { FriendField, Tag } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import Checkbox from '@/components/shared/checkbox'
import TextLink from '@/components/shared/text-link'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import TagPill from '@/components/shared/tag-pill'
import CustomerInfoPanel, { CustomerInfoRail } from '@/components/shared/customer-info-panel'
import TagOverflow from '@/components/shared/tag-overflow'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { formatDay, formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import type { FriendDetail } from '@/lib/api'
import type { FriendDetailState } from './use-friend-detail'
import type { FriendDetailPermissions } from './permissions'
import { timelineSourceHref, timelineTypeLabel, timelineKey, type FriendTimelineItem } from './timeline'
import { SUPPORT_LABELS, SUPPORT_TONES } from './support'
import styles from './detail.module.css'
import IconRow from '@/components/shared/icon-row'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import Notice from '@/components/shared/notice'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { memberRanksApi } from '@/lib/api/helpers/gap3'
import DeliveryConsentDrawer, { DeliveryConsentSummary, useDeliveryConsents } from './delivery-consent'
import { api } from '@/lib/api'
import { notifyToast } from '@/components/shared/toast'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


/*
 * 概要タブ（・ の 1.）。左に要点 320px、右に数の帯・進行中・同じ人・最近の履歴・行う操作。
 */

function GroupHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className={styles.groupHead}>
      <p className={styles.groupTitle}>{title}</p>
      {action}
    </div>
  )
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.kv}>
      <dt>{label}</dt>
      <dd title={typeof children === 'string' ? children : undefined}>{children}</dd>
    </div>
  )
}

/** 最近の履歴の印。種類ごとに決まった形。 */
function recentIcon(type: string) {
  if (type === 'message_received' || type === 'message_sent') return <MessageCircle size={16} aria-hidden />
  if (type === 'tag_change') return <TagIcon size={16} aria-hidden />
  if (type === 'ec_order') return <ShoppingBag size={16} aria-hidden />
  if (type.includes('booking')) return <CalendarDays size={16} aria-hidden />
  if (type.startsWith('scenario')) return <Workflow size={16} aria-hidden />
  return <MailOpen size={16} aria-hidden />
}

/** 最後のやりとり。履歴の中のいちばん新しいメッセージの時刻（無ければ —）。 */
export function lastContactText(items: FriendTimelineItem[]) {
  const latest = items.find((item) => item.type === 'message_received' || item.type === 'message_sent')
  return latest ? formatRelative(latest.occurredAt) : emptyValue('unknown')
}

/**
 * 友だち詳細の左の要点（顧客情報・対応・タグ・マイル・リッチメニュー・メモ）。
 * 概要タブと情報欄タブで同じ物を出す。
 */
export function FriendSummaryRail({ friend, friendId, data, perms, fields, values, realName, onEditSupport }: {
  friend: FriendDetail
  friendId: string
  data: FriendDetailState
  perms: FriendDetailPermissions
  fields: FriendField[]
  values: Record<string, string>
  realName: string
  onEditSupport: () => void
}) {
  const { selectedAccountId } = useAccount()
  const accountStyle = useAccountStyle(selectedAccountId)
  const saveErrors = useSaveFormErrors()
  const manageLockReason = usePermissionLockReason(perms.manage)
  const starred = fields.filter((f) => f.isStarred)
  const { mileage, mileageStatus, richMenu, richMenuStatus } = data
  const support = friend.support
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [availableTags, setAvailableTags] = useState<Tag[]>([])
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])
  const [tagBusy, setTagBusy] = useState(false)
  const [tagError, setTagError] = useState('')
  const tagRequestRef = useRef(0)
  const tagScopeRef = useRef({ friendId, accountId: selectedAccountId, canEdit: perms.editSupport })
  if (tagScopeRef.current.friendId !== friendId || tagScopeRef.current.accountId !== selectedAccountId || tagScopeRef.current.canEdit !== perms.editSupport) {
    tagRequestRef.current += 1
    tagScopeRef.current = { friendId, accountId: selectedAccountId, canEdit: perms.editSupport }
  }
  const tagScope = tagScopeRef.current
  useEffect(() => {
    tagRequestRef.current += 1
    setTagDialogOpen(false)
    setTagBusy(false)
    setTagError('')
    setAvailableTags([])
    setSelectedTagIds([])
    return () => { tagRequestRef.current += 1 }
  }, [friendId, selectedAccountId, perms.editSupport])
  const openTagEditor = async () => {
    if (!tagScopeRef.current.canEdit || tagScope !== tagScopeRef.current) return
    const request = ++tagRequestRef.current
    const ownerId = friendId
    const ownerAccountId = selectedAccountId
    setTagDialogOpen(true)
    setTagError('')
    setTagBusy(true)
    setSelectedTagIds((friend.tags ?? []).map((tag) => tag.id))
    try {
      const result = await api.tags.list({ accountId: ownerAccountId })
      if (request !== tagRequestRef.current || ownerId !== tagScopeRef.current.friendId || ownerAccountId !== tagScopeRef.current.accountId) return
      if (result.success) setAvailableTags(result.data)
      else setTagError('タグを読み込めませんでした')
    } catch {
      if (request !== tagRequestRef.current) return
      setTagError('タグを読み込めませんでした')
    } finally {
      if (request === tagRequestRef.current) setTagBusy(false)
    }
  }
  const saveTags = async () => {
    if (tagBusy || !tagScopeRef.current.canEdit || tagScope !== tagScopeRef.current) return
    const request = ++tagRequestRef.current
    const ownerId = friendId
    const isCurrent = () => request === tagRequestRef.current && tagScope === tagScopeRef.current && tagScopeRef.current.canEdit
    setTagBusy(true)
    setTagError('')
    const current = new Set((friend.tags ?? []).map((tag) => tag.id))
    const next = new Set(selectedTagIds)
    try {
      const changes = await Promise.all([
        ...[...next].filter((id) => !current.has(id)).map((id) => api.friends.addTag(ownerId, id)),
        ...[...current].filter((id) => !next.has(id)).map((id) => api.friends.removeTag(ownerId, id)),
      ])
      if (!isCurrent()) return
      if (changes.some((result) => !result.success)) {
        await data.loadFriend()
        if (!isCurrent()) return
        setTagError('一部のタグを保存できませんでした。現在の内容を読み直してください')
        return
      }
      await data.loadFriend()
      if (!isCurrent()) return
      setTagDialogOpen(false)
      notifyToast('タグを更新しました')
    } catch (caught) {
      if (!isCurrent()) return
      await data.loadFriend()
      if (!isCurrent()) return
      setTagError(saveErrors.capture(caught) ? '' : 'タグを保存できませんでした。現在の内容を読み直してください')
    } finally {
      if (isCurrent()) setTagBusy(false)
    }
  }
  /* ★V8 mAbif：配信の受け取り（段と右の引き出し）と、会員ランクの1行。 */
  const consents = useDeliveryConsents(friendId)
  const [consentOpen, setConsentOpen] = useState(false)
  const [rankLine, setRankLine] = useState<string | null>(null)
  useEffect(() => {
    if (!selectedAccountId) return
    let alive = true
    void memberRanksApi.friend(selectedAccountId, friendId).then((response) => {
      if (!alive || !response.success) return
      const current = (response.data as { current?: { name?: string } | null } | null)?.current
      setRankLine(current?.name ? `会員ランク：${current.name}` : null)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [selectedAccountId, friendId])
  return (
  <><CustomerInfoRail><aside className={styles.summary} data-design="Left" data-friend-profile-panel>
    <CustomerInfoPanel
      friendId={friendId}
      fields={fields}
      includeDiningFields={accountStyle.status === 'ready' && accountStyle.data?.style === 'restaurant'}
      state={data.fieldsStatus === 'error' ? 'error' : data.fieldsStatus === 'ready' ? 'ready' : 'loading'}
      onRetry={() => void data.loadFields()}
      canEdit={perms.saveFields}
      actionWording
      hiddenPersonalCount={data.hiddenPersonalCount}
      sections={[
        { key: 'support', label: '対応', action: perms.editSupport ? <Button variant="text" size="inline" actionWording onClick={onEditSupport}>編集</Button> : null, content: <><dl className={styles.kvList}>
        <Kv label="状況">{support ? <StatusPill tone={SUPPORT_TONES[support.status]}>{SUPPORT_LABELS[support.status]}</StatusPill> : <span className={styles.faint}>やり取りなし</span>}</Kv>
        <Kv label="担当">{support?.operatorName ?? <span className={styles.faint}>未割り当て</span>}</Kv>
        <Kv label="最後の連絡">{data.historyStatus === 'ready' ? lastContactText(data.historyItems) : emptyValue('unknown')}</Kv>
      </dl></> },
        { key: 'tags', label: 'タグ', action: perms.editSupport ? <Button variant="text" size="inline" actionWording onClick={() => void openTagEditor()}>編集</Button> : null, content: <><div className={styles.tags}>
        {friend.tags?.length
          ? <TagOverflow maxVisible={2}>{friend.tags.map((tag) => <TagPill key={tag.id} name={tag.name} color={tag.color} size="xs" />)}</TagOverflow>
          : <span className={`${styles.memo} ${styles.faint}`}>タグはありません</span>}
        {perms.editSupport ? <Button variant="text" size="inline" actionWording onClick={() => void openTagEditor()}>＋ 追加</Button> : null}
      </div></> },
        { key: 'mileage', label: 'マイル', action: <TextLink inline href={`/mileage/friends/detail?id=${encodeURIComponent(friendId)}`}>詳細を見る</TextLink>, content: <>{mileageStatus === 'error' ? (
        <p className={`${styles.memo} ${styles.faint}`}>
          マイルを読み込めませんでした
          <button type="button" className={styles.retry} onClick={() => void data.loadMileage()}>もう一度読み込む</button>
        </p>
      ) : (
        <div className={styles.mile}>
          <span className={styles.mileNum}>{mileageStatus === 'ready' && mileage?.available != null ? formatNumber(mileage.available) : emptyValue('unknown')}</span>
          <span className={styles.mileUnit}>
            マイル使える{mileage?.balanceSource === 'ec' ? '（ECと同期）' : mileage && mileage.pending > 0 ? `・確定待ち ${formatNumber(mileage.pending)}` : ''}
          </span>
        </div>
      )}{mileageStatus === 'ready' && mileage?.balanceSource === 'ec' ? <p className={styles.memo}>会員ランク：{mileage.ecRank ?? '未設定'}（ECと同期）</p> : mileageStatus === 'ready' && mileage?.balanceSource !== 'ec' && rankLine ? <p className={styles.memo}>{rankLine}</p> : null}</> },
        { key: 'delivery', label: '配信の受け取り', action: <Button variant="text" size="inline" actionWording onClick={() => setConsentOpen(true)}>{perms.manage ? '変える' : '見る'}</Button>, content: <DeliveryConsentSummary status={consents.status} rows={consents.rows} /> },
        { key: 'richMenu', label: 'リッチメニュー', action: perms.manage ? <Button variant="text" size="inline" href="/rich-menus">変える</Button> : <Button variant="text" size="inline" disabled lockedReason={manageLockReason}>変える</Button>, content: <>{richMenuStatus === 'error' ? (
        <p className={`${styles.memo} ${styles.faint}`}>
          読み込めませんでした
          <button type="button" className={styles.retry} onClick={() => void data.loadRichMenu()}>もう一度読み込む</button>
        </p>
      ) : (
        <p className={styles.value} title={richMenu?.name ?? undefined}>
          {richMenuStatus === 'ready'
            ? <>{richMenu?.name ?? '既定のメニュー'}{richMenu?.isDefault ? <span className={styles.faint}>（全員に出しているもの）</span> : null}</>
            : emptyValue('unknown')}
        </p>
      )}</> },
        { key: 'memo', label: 'メモ', action: perms.editSupport ? <Button variant="text" size="inline" actionWording onClick={onEditSupport}>編集</Button> : null, content: <><p className={`${styles.memo} ${support?.notes ? '' : styles.faint}`}>{support?.notes || 'メモはありません'}</p></> }]}
      more={<div className={styles.more}>
        {starred.length > 0 ? (
          <section className={styles.group} aria-label="★つき友だち情報">
            <GroupHead title="★つき友だち情報" action={<TextLink inline href={`/friends/detail?id=${encodeURIComponent(friendId)}&tab=info`}>すべて見る</TextLink>} />
            <dl className={styles.kvList}>
              {starred.map((f) => <Kv key={f.id} label={f.name}>{values[f.id] || <span className={styles.faint}>{emptyValue('unconfigured')}</span>}</Kv>)}
            </dl>
          </section>
        ) : null}
        {data.fieldsStatus === 'error' ? (
          <p className={`${styles.memo} ${styles.faint}`}>
            情報欄を読み込めませんでした
            <button type="button" className={styles.retry} onClick={() => void data.loadFields()}>もう一度読み込む</button>
          </p>
        ) : null}
        <section className={styles.group} aria-label="友だち情報">
          <GroupHead title="友だち情報" />
          <dl className={styles.kvList}>
            <Kv label="システム表示名">{friend.systemDisplayName || <span className={styles.faint}>未設定</span>}</Kv>
            <Kv label="追加日">{friend.createdAt ? formatDay(friend.createdAt) : emptyValue('unknown')}</Kv>
            <Kv label="流入元">{friend.firstTrackedLinkName ?? emptyValue('unknown')}</Kv>
          </dl>
        </section>
        <section className={styles.group} aria-label="フォーム回答">
          <GroupHead title="フォーム回答" action={<TextLink inline href={`/friends/detail?id=${encodeURIComponent(friendId)}&tab=forms`}>すべて見る</TextLink>} />
          <p className={styles.value}>
            {typeof friend.formSubmissionTotal === 'number'
              ? friend.formSubmissionTotal > 0 ? `${formatNumber(friend.formSubmissionTotal)} 件` : '回答はまだありません'
              : friend.formSubmissions?.length ? `${formatNumber(friend.formSubmissions.length)} 件` : '回答はまだありません'}
          </p>
        </section>
      </div>}
    />
  </aside></CustomerInfoRail><DeliveryConsentDrawer open={consentOpen} friendId={friendId} friendName={realName || friend.displayName} friendAccountId={friend.lineAccountId ?? null} selectedAccountId={selectedAccountId} rows={consents.rows} canEdit={perms.manage} onClose={() => setConsentOpen(false)} onSaved={consents.reload} />
    <SaveErrorScope errors={saveErrors}><Dialog open={tagDialogOpen && perms.editSupport} title="タグを編集" designWidth={480} busy={tagBusy} error={tagError} confirmLabel="保存する" onConfirm={() => void saveTags()} onCancel={() => setTagDialogOpen(false)}>
      <div className={styles.dialogBody} data-friend-tag-editor>
        {availableTags.map((tag) => <Checkbox key={tag.id} checked={selectedTagIds.includes(tag.id)} disabled={tagBusy} onCheckedChange={(checked) => setSelectedTagIds((current) => checked ? [...current, tag.id] : current.filter((id) => id !== tag.id))}>{tag.name}</Checkbox>)}
        {!tagBusy && availableTags.length === 0 && !tagError ? <p className={styles.memo}>選べるタグはありません</p> : null}
      </div>
    </Dialog></SaveErrorScope>
  </>
  )
}

export default function OverviewTab({
  friend,
  friendId,
  data,
  perms,
  fields,
  values,
  realName,
  onEditSupport,
  onEnrollScenario,
  scenarioNotice,
}: {
  friend: FriendDetail
  friendId: string
  data: FriendDetailState
  perms: FriendDetailPermissions
  fields: FriendField[]
  values: Record<string, string>
  realName: string
  onEditSupport: () => void
  onEnrollScenario: () => void
  scenarioNotice: string
}) {
  const { upcoming, upcomingStatus, mileageStatus, mileageInsights, mileageConnections } = data
  const nextDelivery = upcoming?.nextAutoDelivery ?? null
  const deliveryFailed = upcomingStatus === 'error' || !!upcoming?.nextAutoDeliveryError
  const bookingFailed = upcomingStatus === 'error' || !!upcoming?.nextBookingError
  const history = data.historyItems.slice(0, 3)

  return (
    <div className={styles.overview}>
      {/* 左：要点（顧客情報 → 対応 → タグ → マイル → リッチメニュー → メモ → すべて表示） */}
      <FriendSummaryRail friend={friend} friendId={friendId} data={data} perms={perms} fields={fields} values={values} realName={realName} onEditSupport={onEditSupport} />

      {/* 右：概要 */}
      <div className={styles.content} data-design="Right">
        <KpiBand className={styles.kpis} gridClassName="grid grid-cols-3">
          <KpiCard
            presentation="band"
            density="compact"
            title="配信を開いた率"
            icon={<MailOpen size={16} aria-hidden />}
            value={null}
            unit="%"
            detail=""
            help="この友だちの開封率を数える口はまだありません。数が出るまで「—」です。"
          />
          <KpiCard
            presentation="band"
            density="compact"
            title="この90日の購入"
            icon={<ShoppingBag size={16} aria-hidden />}
            value={null}
            unit="回"
            detail=""
            help="この友だちの90日間の購入回数を数える口はまだありません。数が出るまで「—」です。"
          />
          <KpiCard
            presentation="band"
            density="compact"
            title="次の予約"
            icon={<CalendarDays size={16} aria-hidden />}
            value={null}
            unit=""
            loading={upcomingStatus === 'loading' || upcomingStatus === 'idle'}
            valueText={upcoming?.nextBooking && !upcoming.nextBookingError ? formatDay(upcoming.nextBooking.startsAt).replace(/（.）$/, '') : undefined}
            detail={bookingFailed ? '読み込めませんでした' : upcoming?.nextBooking ? '' : upcoming ? '予定なし' : ''}
            help={upcoming?.nextBooking && !bookingFailed ? `${upcoming.nextBooking.title}・${formatDay(upcoming.nextBooking.startsAt)}` : undefined}
            onRetry={bookingFailed ? () => void data.loadUpcoming() : undefined}
          />
        </KpiBand>

        <section className={styles.section} aria-labelledby="fdt-running">
          <div className={styles.secHead}>
            <h2 id="fdt-running" className={styles.secTitle}>進行中の配信・自動処理</h2>
            <TextLink href={`/friends/detail?id=${encodeURIComponent(friendId)}&tab=reminders`}>この友だちのリマインダを見る</TextLink>
            <TextLink href={`/friends/detail?id=${encodeURIComponent(friendId)}&tab=scenario`}>すべてを見る</TextLink>
          </div>
          {upcomingStatus === 'loading' || upcomingStatus === 'idle' ? (
            <DetailLoading />
          ) : deliveryFailed ? (
            <Notice tone="danger" className={styles.secNoteNoticePlacement} >配信予定を読み込めませんでした
              <Button variant="text" size="inline" type="button" onClick={() => void data.loadUpcoming()} data-notice-inline-action>もう一度読み込む</Button></Notice>
          ) : nextDelivery ? (
            <IconRow
              surface="card"
              href={nextDelivery.kind === 'scenario' ? `/scenarios/detail?id=${encodeURIComponent(nextDelivery.id)}` : `/reminders/detail?id=${encodeURIComponent(nextDelivery.id)}`}
              icon={nextDelivery.kind === 'scenario' ? <Workflow size={16} aria-hidden /> : <Bell size={16} aria-hidden />}
              title={<TruncatedText value={String(nextDelivery.name ?? '')} />}
              end={`${formatDateTime(nextDelivery.scheduledAt)} に送信予定`}
            />
          ) : (
            <p className={styles.secNote}>確定した配信予定はありません</p>
          )}
        </section>

        {/* NEXT-10: 名寄せの実績（マイル口の応答の統合情報）から出す。 */}
        <IconRow
          surface="pearl"
          icon={<Link2 size={16} aria-hidden />}
          title="同じ人としてつながる情報"
          sub={<>{mileageStatus === 'loading' || mileageStatus === 'idle'
                ? 'つながり情報を読み込んでいます…'
                : mileageStatus === 'error'
                  ? <>つながり情報を読み込めませんでした<button type="button" className={styles.retry} onClick={() => void data.loadMileage()}>もう一度読み込む</button></>
                  : mileageInsights && mileageInsights.accountCount > 1
                    ? `${formatNumber(mileageInsights.accountCount)} 件のLINEアカウントで同じ人としてつながっています${mileageConnections.length ? `（${mileageConnections.map((c) => c.accountName).join('・')}）` : ''}。重複候補が見つかると、根拠と確信度を表示します。`
                    : 'このアカウントのみに登録があります。重複候補が見つかると、根拠と確信度を表示します。'}</>}
          end={<Button href="/duplicates">重複候補を確認</Button>}
        />

        <section className={`${styles.section} ${styles.recent}`} aria-labelledby="fdt-recent">
          <div className={styles.secHead}>
            <h2 id="fdt-recent" className={styles.secTitle}>最近の履歴</h2>
            <TextLink href={`/friends/detail?id=${encodeURIComponent(friendId)}&tab=history`}>すべて見る</TextLink>
          </div>
          {data.historyStatus === 'loading' || data.historyStatus === 'idle' ? (
            <DetailLoading />
          ) : data.historyStatus === 'error' ? (
            <p className={styles.secNote}>
              履歴を読み込めませんでした
              <button type="button" className={styles.retry} onClick={() => void data.loadHistory()}>もう一度読み込む</button>
            </p>
          ) : (
            <div className={styles.recentList}>
              {history.map((item, index) => {
                const src = timelineSourceHref(item, friendId)
                return (
                  <IconRow
                    key={timelineKey(item)}
                    iconShape="round"
                    connect={index < history.length - 1}
                    icon={recentIcon(item.type)}
                    title={src
                      ? <TextLink href={src.href} external={src.external} title={item.summary}>{item.summary}</TextLink>
                      : item.summary}
                    titleAttribute={item.summary}
                    sub={[timelineTypeLabel(item.type), item.lineAccount?.name].filter(Boolean).join('・')}
                    end={formatRelative(item.occurredAt)}
                  />
                )
              })}
              {history.length === 0 ? (
                <IconRow
                  iconShape="round"
                  icon={<MailOpen size={16} aria-hidden />}
                  title="友だちに追加されました"
                  sub={`${friend.firstTrackedLinkName ?? 'システム'}・ほかの活動履歴はまだありません`}
                  end={friend.createdAt ? formatDay(friend.createdAt) : emptyValue('unknown')}
                />
              ) : null}
            </div>
          )}
        </section>

        <div className={styles.ops}>
          <p className={styles.opsTitle}>この友だちに行う操作</p>
          {/* POST /api/scenarios/:id/enroll/:friendId はオーナー・管理者専用。権限が無い人には置かない。 */}
          {perms.manage ? <Button onClick={onEnrollScenario}><Workflow aria-hidden />シナリオに登録する</Button> : null}
          <span className={styles.opsNote}>テンプレートは受信箱で選んで送る</span>
        </div>
        {scenarioNotice ? <p className={styles.success} role="status">{scenarioNotice}</p> : null}
      </div>
    </div>
  )
}
