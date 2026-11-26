'use client'
import { DetailContent, DetailFields, DetailSectionTitle } from '@/components/shared/detail-content'
import { formatYen, withHonorific } from '@line-crm/shared';

/*
 * ★V8-B ：EC連携 注文の状況（引き出し）。取り込みの記録の行の「…」→「注文の状況を見る」で開く。
 *
 * 絵どおりの4つの段：注文の内容（中身・金額・EC側の注文）／この注文に届いた出来事／
 * 成果・マイル・スコア／発送後に届く案内。各段は「時刻＋1行」の並び。
 * 動きは今の引き出し（app/ec-commerce/order-detail-drawer.tsx）と同じ：
 * 同じ口（注文1件の状況）を読み、権限なし・失敗は分けて出し、止まった段階・失敗の理由・
 * 「もう一度やる」・会員のつき合わせへ・ECの管理画面で開く を同じ場所に残す。
 * 届き済みの出来事は1行に畳み、止まった・失敗したものだけ下に理由を足す。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from '@/components/shared/list-navigation'
import { Link as LinkIcon } from 'lucide-react'
import { ecEventLabel } from '@line-crm/shared'
import Button from '@/components/shared/button'
import SectionHeader from '@/components/shared/section-header'
import ListState from '@/components/shared/list-state'
import TruncatedText from '@/components/shared/truncated-text'
import Drawer from '@/components/shared/drawer'
import { ApiError, api, type EcActionExecution, type EcOrderDetail, type EcOrderDetailEvent } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import {
  DELIVERY_STATUS_TEXT,
  EVENT_STATUS_TEXT,
  FAILURE_KIND_TEXT,
  FOLLOWUP_REASON_TEXT,
  FOLLOWUP_STATUS_TEXT,
  eventStoppedStage,
} from './ec-failure'
import styles from './order-drawer.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'

type DetailState = 'loading' | 'ready' | 'error' | 'forbidden'

/** 日本時間の「10/1 21:02」。 */
function shortTime(value: string | null): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

/** 日本時間の「10/4」。 */
function shortDay(value: string): string {
  return polishFormatDate(value, { style: 'list-day' })
}

function money(currency: string, amount: number | null): string | null {
  if (amount === null) return null
  return currency === 'JPY' ? formatYen(amount) : formatNumber(amount)
}

function signed(amount: number): string {
  return `${amount > 0 ? '+' : '−'}${formatNumber(Math.abs(amount))}`
}

const ORDER_STATUS_TEXT: Record<string, string> = { refunded: '返金済み', cancelled: '取り消し済み' }
const DISPATCH_LABEL: Record<string, string> = { notification: 'お客様への通知', v6: '自動化・スコアへの連携' }
const DISPATCH_STATUS: Record<string, string> = { pending: '処理中', sent: '完了', failed: '失敗' }
const APPROVAL_TEXT: Record<string, string> = { pending: '承認待ち', rejected: '却下' }
const REWARD_ENTRY_STATUS_TEXT: Record<string, string> = { pending: '確定待ち', approved: '承認済み', held: '保留中', payable: '支払い可能', settled: '締めに入った', paid: '支払い済み', reversed: '取り消された' }
const SETTLEMENT_STATE_TEXT: Record<string, string> = { preview: '締めの確認中', closed: '締め済み', exported: '書き出し済み', paid: '支払い済み', partial: '一部だけ支払い済み', failed: '失敗' }
const PAYOUT_BATCH_STATE_TEXT: Record<string, string> = { created: 'CSVを作成した', approved: 'CSVを確認した', exported: 'CSVを書き出した', imported: '支払い結果を取り込んだ' }
const PAYOUT_RESULT_TEXT: Record<string, string> = { paid: '支払い完了', failed: '支払い失敗', returned: '支払いが戻った' }

/** 時刻＋1行。下に足す行（理由・やり直し）があれば続ける。 */
function TimeRow({ time, fullTime, children, extra }: { time: string; fullTime?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <li className={styles.timeRow}>
      <span className={styles.time} title={fullTime}><TruncatedText value={time} /></span>
      <span className={styles.timeBody}>
        <span className={styles.timeText}>{children}</span>
        {extra}
      </span>
    </li>
  )
}

/** 出来事1件。届いて済んだものは1行。止まった・失敗したものは理由と「もう一度やる」を足す。 */
function EventRow({ event, retryingId, onRetry, canEdit }: { event: EcOrderDetailEvent; retryingId: string | null; canEdit: boolean; onRetry: (action: EcActionExecution) => void }) {
  const statusInfo = EVENT_STATUS_TEXT[event.status] ?? { label: event.status, tone: 'muted' as const }
  const stoppedStage = eventStoppedStage(event)
  const troubled = event.actions.filter((action) => action.status !== 'succeeded')
  const failedDispatches = event.dispatches.filter((dispatch) => dispatch.status !== 'sent')
  const failedDeliveries = event.deliveries.filter((delivery) => delivery.status === 'failed' || delivery.status === 'retry_wait')
  const settled = statusInfo.tone === 'good' && !stoppedStage && troubled.length === 0 && failedDispatches.length === 0 && failedDeliveries.length === 0
  return (
    <TimeRow
      time={shortTime(event.receivedAt)}
      extra={settled ? null : (
        <span className={styles.detailBox}>
          <span className={styles.note} data-tone={statusInfo.tone}>{statusInfo.label}{stoppedStage ? `・止まった段階：${stoppedStage}` : ''}</span>
          {troubled.map((action) => {
            const kind = action.failureKind ? FAILURE_KIND_TEXT[action.failureKind] : null
            return (
              <span key={action.id} className={styles.actionLine}>
                <span className={styles.note}>
                  {action.errorMessage
                    ?? (action.status === 'skipped' ? '見送りました'
                      : action.status === 'pending' || action.status === 'processing' ? '処理中です'
                        : '失敗しました。通信を確かめて、もう一度お試しください。')}
                  {kind ? `（${kind.label}）` : ''}
                  {action.attemptCount > 0 ? `・${action.attemptCount}/${action.maxAttempts} 回` : '・まだ試していません'}
                  {action.attempts.length > 1 ? `・手動で戻した ${action.attempts.filter((attempt) => attempt.triggerKind === 'manual').length} 回` : ''}
                </span>
                {kind && (action.status === 'retryable_failed' || action.status === 'permanent_failed' || action.status === 'skipped') ? <span className={styles.hint}>{kind.hint}</span> : null}
                {canEdit && action.retryAvailable ? (
                  <Button type="button" disabled={retryingId === action.id} onClick={() => onRetry(action)} busy={retryingId === action.id} busyLabel="戻しています…">もう一度やる</Button>
                ) : null}
              </span>
            )
          })}
          {failedDispatches.map((dispatch) => (
            <span key={dispatch.subscriber} className={styles.note}>
              {`${DISPATCH_LABEL[dispatch.subscriber] ?? dispatch.subscriber}：${DISPATCH_STATUS[dispatch.status] ?? dispatch.status}${dispatch.failureKind ? `（${FAILURE_KIND_TEXT[dispatch.failureKind].label}）` : ''}`}
            </span>
          ))}
          {failedDeliveries.map((delivery) => (
            <span key={delivery.id} className={styles.note}>
              {`${delivery.audienceType === 'operator' ? '運用者へ' : 'お客様へ'}${delivery.channel === 'email' ? 'メール' : delivery.channel === 'in_app' ? '画面通知' : 'LINE'}：${DELIVERY_STATUS_TEXT[delivery.status] ?? delivery.status}${delivery.errorMessage ? `・${delivery.errorMessage}` : ''}${delivery.failureKind ? `（${FAILURE_KIND_TEXT[delivery.failureKind].label}）` : ''}`}
            </span>
          ))}
        </span>
      )}
    >
      {ecEventLabel(event.eventType, event.eventType)}
    </TimeRow>
  )
}

export default function OrderDrawer({
  orderId,
  accountId,
  onClose,
  onRetryAction,
  retryingId,
  canEdit = true,
}: {
  orderId: string | null
  accountId: string | null
  onClose: () => void
  onRetryAction: (action: EcActionExecution) => Promise<void>
  retryingId: string | null
  canEdit?: boolean
}) {
  const open = orderId !== null
  const [state, setState] = useState<DetailState>('loading')
  const [detail, setDetail] = useState<EcOrderDetail | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async (showLoading = true) => {
    if (!orderId || !accountId) return
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    if (showLoading) setState('loading')
    try {
      const response = await api.ecCommerce.orderDetail(orderId, accountId)
      if (seq !== loadSeq.current) return
      if (!response.success || !response.data) throw new Error('invalid_order_detail')
      setDetail(response.data)
      setState('ready')
    } catch (error) {
      if (seq !== loadSeq.current) return
      setState(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [orderId, accountId])

  useEffect(() => {
    setDetail(null)
    setState('loading')
    void load()
  }, [load])

  /*
   * WEB193：やり直しが終わるまでに別の注文（またはアカウント）へ移っていたら、
   * 前の注文を読み直して今の引き出しを上書きしない。読み直すのは今の注文だけ。
   */
  const targetRef = useRef('')
  targetRef.current = `${accountId ?? ''}|${orderId ?? ''}`
  const loadRef = useRef(load)
  loadRef.current = load
  const retry = async (action: EcActionExecution) => {
    const target = targetRef.current
    await onRetryAction(action)
    if (targetRef.current !== target) return
    await loadRef.current(false)
  }

  if (!open) return null
  const order = detail?.order ?? null
  const friendId = order?.friendId ?? null
  const amount = order
    ? order.status === 'refunded' && order.refundedAmount !== null
      ? `返金 −${money(order.currency, order.refundedAmount)}`
      : money(order.currency, order.totalAmount)
    : null
  const outcomesEmpty = detail
    ? detail.outcomes.conversions.length === 0 && detail.outcomes.mileage.length === 0 && detail.outcomes.scores.length === 0
    : true

  return (
    <Drawer open={open} width="order" heightMode="viewport" title={order ? `注文 ${order.orderNumber}` : '注文の状況'}
      description={order ? <>
        {friendId && order.customerName
          ? <Link className={styles.subLink} href={`/friends/detail?id=${encodeURIComponent(friendId)}`}>{withHonorific(order.customerName)}</Link>
          : order.customerName ? withHonorific(order.customerName) : null}
        {`${order.customerName ? '・' : ''}${friendId ? 'LINE の友だちと結びついています' : 'LINE の友だちと結びついていません'}${ORDER_STATUS_TEXT[order.status] ? `・${ORDER_STATUS_TEXT[order.status]}` : ''}`}
      </> : undefined}
      onClose={onClose}
      actions={{primary: ((order) && (order.detailUrl) ? <Button variant="primary" external href={order.detailUrl}  >ECの管理画面で開く</Button> : null),
secondary: ((order) ? <Button variant="secondary" href="/ec-commerce/identity-candidates"><LinkIcon size={16} aria-hidden="true" />会員のつき合わせへ</Button> : null),
menuItems: []}}
    >
<DetailContent>
          {state === 'loading' ? (
            <ListState kind="loading" title="注文の状況を読み込んでいます" />
          ) : state === 'forbidden' ? (
            <ListState kind="empty" title="この注文の状況を見る権限がありません" />
          ) : state === 'error' || !detail || !order ? (
            <ListState kind="error" title="注文の状況を読み込めませんでした" description="通信の状態を確認して、もう一度お試しください。" onRetry={() => void load()} />
          ) : (
            <>
              <section className={styles.section}>
                <DetailSectionTitle>注文の内容</DetailSectionTitle>
                <DetailFields>
                  <div>
                    <dt>中身</dt>
                    <dd>{order.orderLines.length ? order.orderLines.map((line) => `${line.productName} ×${line.quantity}`).join('・') : '商品明細は未取得'}</dd>
                  </div>
                  <div><dt>金額</dt><dd>{amount ?? emptyValue('unknown')}</dd></div>
                  <div>
                    <dt>EC側の注文</dt>
                    <dd>
                      {`${shortTime(order.orderedAt)} 注文`}
                    </dd>
                  </div>
                </DetailFields>
              </section>

              <section className={styles.section}>
                <SectionHeader title="この注文に届いた出来事" helpLabel="もう一度行うときの説明" help="もう一度行う・再取込では、届き済みの通知や入った成果・マイルは重ねません。" />
                {detail.events.length === 0 ? <p className={styles.empty}>届いた出来事はありません。</p> : (
                  <ul className={styles.timeline}>
                    {detail.events.map((event) => <EventRow key={event.id} canEdit={canEdit} event={event} retryingId={retryingId} onRetry={(action) => void retry(action)} />)}
                  </ul>
                )}
              </section>

              <section className={styles.section}>
                <DetailSectionTitle>成果・マイル・スコア</DetailSectionTitle>
                {outcomesEmpty ? <p className={styles.empty}>この注文に結びついた成果・マイル・スコアはありません。</p> : (
                  <ul className={styles.timeline}>
                    {detail.outcomes.conversions.map((conversion) => {
                      const notes = [
                        conversion.approvalStatus ? APPROVAL_TEXT[conversion.approvalStatus] : undefined,
                        conversion.affiliateName ? `紹介者：${conversion.affiliateName}` : undefined,
                        conversion.affiliateName || conversion.rewardAmount != null ? `報酬：${conversion.rewardAmount != null ? `${formatYen(conversion.rewardAmount)}` : '未確定'}` : undefined,
                        conversion.rewardEntryStatus ? `支払い確定：${REWARD_ENTRY_STATUS_TEXT[conversion.rewardEntryStatus] ?? conversion.rewardEntryStatus}` : undefined,
                        conversion.settlementState ? `締め：${SETTLEMENT_STATE_TEXT[conversion.settlementState] ?? conversion.settlementState}` : undefined,
                        conversion.payoutBatchState ? `支払いCSV：${PAYOUT_BATCH_STATE_TEXT[conversion.payoutBatchState] ?? conversion.payoutBatchState}` : undefined,
                        conversion.payoutResult ? `結果：${PAYOUT_RESULT_TEXT[conversion.payoutResult] ?? conversion.payoutResult}` : undefined,
                        conversion.reversedAmount != null ? `確定後の取消：−${formatYen(conversion.reversedAmount)}（次の支払いで差し引かれます）` : undefined,
                      ].filter(Boolean)
                      return (
                        <TimeRow
                          key={conversion.id}
                          time={shortTime(conversion.createdAt)}
                          extra={notes.length || conversion.duplicateCandidate ? (
                            <span className={styles.detailBox}>
                              {notes.length ? <span className={styles.note}>{notes.join('・')}</span> : null}
                              {conversion.duplicateCandidate ? <span className={styles.note} data-tone="danger">同じ注文・同じ成果地点の成果がほかにもあります。二重に認めないか注文番号で確かめてください。</span> : null}
                            </span>
                          ) : null}
                        >
                          {`成果「${conversion.pointName ?? '計測地点'}」${conversion.value !== null ? `${formatYen(conversion.value)}` : ''}`}
                        </TimeRow>
                      )
                    })}
                    {detail.outcomes.mileage.map((entry) => (
                      <TimeRow key={entry.id} time={shortTime(entry.occurredAt)}>{`マイル ${signed(entry.amount)}${entry.status === 'void' ? '・無効' : ''}`}</TimeRow>
                    ))}
                    {detail.outcomes.scores.map((score) => (
                      <TimeRow key={score.id} time={shortTime(score.occurredAt)}>{`行動スコア ${signed(score.scoreChange)}`}</TimeRow>
                    ))}
                  </ul>
                )}
              </section>

              <section className={styles.section}>
                <DetailSectionTitle>発送後に届く案内</DetailSectionTitle>
                {detail.followUps.length === 0 ? <p className={styles.empty}>予約されている案内はありません。</p> : (
                  <ul className={styles.timeline}>
                    {detail.followUps.map((job) => {
                      const info = FOLLOWUP_STATUS_TEXT[job.status]
                      const reasonText = job.reason ? (Object.prototype.hasOwnProperty.call(FOLLOWUP_REASON_TEXT, job.reason) ? FOLLOWUP_REASON_TEXT[job.reason] : job.reason) : null
                      const notes = [
                        job.sentAt ? `${shortTime(job.sentAt)} に送信` : null,
                        info && ['skipped', 'failed', 'cancelled'].includes(job.status) ? info.label : null,
                        reasonText,
                        job.failureKind ? FAILURE_KIND_TEXT[job.failureKind].label : null,
                      ].filter(Boolean)
                      return (
                        <TimeRow
                          key={job.id}
                          time={`${shortDay(job.scheduledAt)} 予定`}
                          fullTime={`${polishFormatDate(job.scheduledAt, { style: 'detail' })} 予定`}
                          extra={notes.length ? <span className={styles.detailBox}><span className={styles.note} data-tone={info?.tone}>{notes.join('・')}</span></span> : null}
                        >
                          {job.campaignLabel ?? job.campaignKey}
                        </TimeRow>
                      )
                    })}
                  </ul>
                )}
              </section>
            </>
          )}

</DetailContent>
</Drawer>
  )
}
