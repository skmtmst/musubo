'use client'
import { knownValue } from '@/lib/known-value'

import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { useState } from 'react'
import KpiCard from '@/components/shared/kpi-card'
import Card, { CardHeader } from '@/components/shared/card'
import StatusBadge from '@/components/shared/status-badge'
import Notice from '@/components/shared/notice'
import { Check, Inbox, Undo2 } from 'lucide-react'
import { ApiError } from '@/lib/api'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { DialogFormRow } from '@/components/shared/dialog-form-row'
import ListState from '@/components/shared/list-state'
import { TextArea } from '@/components/shared/text-field'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { useAccount } from '@/contexts/account-context'
import { restaurantTestApi, type RestaurantApproval, type RestaurantSnapshot, type RestaurantStore } from '@/lib/restaurant-test-api'
import { RestaurantFrame, type RestaurantContext } from '@/v8/restaurant/common-a/public/frame/index'
import { formatStamp, StatRow, Status } from '@/v8/restaurant/common-a/public/parts/index'
import styles from './approvals.module.css'
import { Field } from '@/components/shared/form-controls'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'

/*
 * ★V8 承認ワークフロー（Pencil 、閲覧のみ 、差し戻す理由の小窓 ）。
 *
 * 数4 → 承認カード（種類・状態・店舗・申請者・変更内容・差戻しコメント・差戻し／承認する）→ 公開境界。
 * 閲覧のみ（変える権限が無い人）には案内の帯を出し、差戻し・承認するのボタンは置かない
 * （2026-10-06 オーナー決定。場所だけ空けて、下の並びを動かさない）。
 * 承認待ちは共通の状態札で知らせる。動きは BEHAVIOR.md。
 */

const kindLabel: Record<RestaurantApproval['kind'], string> = {
  gbp_post: 'Google投稿',
  line_message: 'LINE配信',
  menu_change: 'メニュー改定',
}

export const approvalKindWord = (kind: string) => knownValue(kindLabel, kind, '種類を確認できません')


function approvalPayload(item: RestaurantApproval): Record<string, unknown> {
  try {
    const parsed = item.payload_json ? JSON.parse(item.payload_json) : {}
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

/** 小窓の太字の行：改定は「前 → 後」、ほかは件名。 */
function approvalSummary(item: RestaurantApproval): string {
  const payload = approvalPayload(item)
  const before = typeof payload.before === 'string' ? payload.before : null
  const after = typeof payload.after === 'string' ? payload.after : null
  if (before || after) return `${before || emptyValue('unknown')} → ${after || emptyValue('unknown')}`
  return item.title
}

/** R105: 承認する中身（投稿文・配信文・改定前後）を見せてから判断できるようにする（今の画面と同じ）。 */
function ApprovalContent({ item, data }: { item: RestaurantApproval; data: RestaurantSnapshot }) {
  const payload = approvalPayload(item)
  if (item.kind === 'gbp_post') {
    const post = typeof payload.postId === 'string' ? data.posts.find((p) => p.id === payload.postId) : null
    const typeLabel = typeof payload.typeLabel === 'string'
      ? payload.typeLabel
      : post ? ({ standard: '通常の投稿', event: 'イベント', offer: 'クーポン' }[post.post_type] || post.post_type) : null
    const title = typeof payload.title === 'string' ? payload.title : post?.title
    const body = typeof payload.body === 'string' ? payload.body : post?.body
    if (!typeLabel && !title && !body) return <p className={styles.muted}>投稿の内容を読み込めませんでした。</p>
    return (
      <>
        {typeLabel ? <p className={styles.payloadMeta}>{`種別：${typeLabel}`}</p> : null}
        {title ? <p className={styles.payloadTitle}>{title}</p> : null}
        {body ? <p className={styles.payloadBody}>{body}</p> : null}
      </>
    )
  }
  if (item.kind === 'line_message') {
    const flow = typeof payload.flowId === 'string' ? data.lineFlows.find((f) => f.id === payload.flowId) : null
    const title = typeof payload.title === 'string' ? payload.title : flow?.title
    const body = typeof payload.body === 'string' ? payload.body : flow?.body
    if (!title && !body) return <p className={styles.muted}>配信の内容を読み込めませんでした。</p>
    return (
      <>
        {title ? <p className={styles.payloadTitle}>{title}</p> : null}
        {body ? <p className={styles.payloadBody}>{body}</p> : null}
      </>
    )
  }
  if (item.kind === 'menu_change') {
    const before = typeof payload.before === 'string' ? payload.before : null
    const after = typeof payload.after === 'string' ? payload.after : null
    if (before === null && after === null) return <p className={styles.muted}>改定の前後が記録されていません。申請者に確認してください。</p>
    return (
      <p className={styles.payloadDiff}>
        <span className={styles.diffKey}>変更前：</span>
        <span className={styles.diffBefore}>{before || emptyValue('unknown')}</span>
        <span className={styles.diffKey}>→</span>
        <span className={styles.diffAfter}>{after || emptyValue('unknown')}</span>
      </p>
    )
  }
  return <p className={styles.muted}>内容の詳細は申請者に確認してください。</p>
}

function ApprovalCard({ item, data, store, busy, readOnly, onApprove, onReturn }: {
  item: RestaurantApproval
  data: RestaurantSnapshot
  store: RestaurantStore | undefined
  busy: boolean
  readOnly: boolean
  onApprove: (item: RestaurantApproval) => void
  onReturn: (item: RestaurantApproval) => void
}) {
  const pending = item.status === 'pending'
  return (
    <Card variant="form">
      <div className={styles.cardHead}>
        <StatusBadge dot={false} tone={Object.prototype.hasOwnProperty.call(kindLabel, item.kind) ? 'success' : 'neutral'}>{approvalKindWord(item.kind)}</StatusBadge>
        <Status value={item.status} />
        <span className={styles.store}>{store?.name || '全店舗'}</span>
        <span className={styles.spacer} aria-hidden="true" />
        {pending && !readOnly ? (
          <>
            {/* 109: 承認は主（右）、差戻しは赤い文字だけ。並びは［差戻し］［承認する］。 */}
            <Button disabled={busy} variant="text" textTone="danger" onClick={() => onReturn(item)}><Undo2 aria-hidden className={styles.buttonIcon} />差戻し</Button>
            <Button disabled={busy} variant="primary" onClick={() => onApprove(item)}><Check aria-hidden className={styles.buttonIcon} />承認する</Button>
          </>
        ) : pending ? (
          /* 閲覧のみ：ボタンは置かず、ボタンの高さだけ空ける（下の並びを動かさない）。 */
          <span className={styles.actionsSpace} aria-hidden="true" />
        ) : null}
      </div>
      <CardHeader size="stacked" headingLevel={3} title={item.title} />
      <p className={styles.requested}>{`申請：${item.requested_by || emptyValue('unknown')}・${formatStamp(item.created_at)}`}</p>
      <Card surface="muted" layout="vertical" padding="compact" gap="var(--polish-space-row)">
        <p className={styles.payloadLabel}>変更内容</p>
        <ApprovalContent item={item} data={data} />
      </Card>
      {item.review_comment ? <Notice tone="warn" appearance="soft" icon={null}>{item.review_comment}</Notice> : null}
    </Card>
  )
}

/** ：対象の要約＋理由（必須）＋注意＋「差し戻す」。 */
function ReturnDialog({ item, store, busy, onCancel, onSubmit }: {
  item: RestaurantApproval | null
  store: RestaurantStore | undefined
  busy: boolean
  onCancel: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog
      open={item !== null}
      title="差し戻しますか？"
      designNode="n4j0Rm"
      contentLayout="form"
      onCancel={onCancel}
      footer={(
        <DialogActions>
          <Button onClick={onCancel} disabled={busy}>キャンセル</Button>
          <Button variant="primary" disabled={busy || !reason.trim()} title={busy ? '処理しています' : !reason.trim() ? '差し戻す理由を入力してください' : undefined} busy={busy} busyLabel="処理中…" onClick={() => onSubmit(reason.trim())}><Undo2 size={16} aria-hidden="true" />差し戻す</Button>
        </DialogActions>
      )}
    >
      {item ? (
        <div className={styles.dialogBody}>
          <div className={styles.dialogSummary}>
            <p className={styles.dialogSummaryMeta}>
              {`${approvalKindWord(item.kind)}・${store?.name || '全店舗'}・申請 ${item.requested_by || emptyValue('unknown')}（${formatStamp(item.created_at)}）`}
            </p>
            <p className={styles.dialogSummaryMain}>{approvalSummary(item)}</p>
          </div>
          <Field label="差し戻す理由（・申請者に届きます）" required><SaveErrorField names={["reason"]}><TextArea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例：原価の根拠（仕入れ値の表）を添えてください"
              rows={3}
              disabled={busy}
            /></SaveErrorField></Field>
          <p className={styles.dialogNote}>差し戻すと、申請は「差戻し」になり、直して出し直すまで公開されません。</p>
        </div>
      ) : null}
    </Dialog>
  )
}

function ApprovalsBoard({ ctx }: { ctx: RestaurantContext }) {
  const { data, selectedStoreId, busy, mutate, reload } = ctx
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  const readOnly = !canManageRole(role)
  const [returnTarget, setReturnTarget] = useState<RestaurantApproval | null>(null)
  const rows = data.approvals.filter((item) => !selectedStoreId || item.store_id === selectedStoreId || item.store_id === null)
  const pending = rows.filter((item) => item.status === 'pending')
  const decide = (id: string, action: 'approve' | 'return', comment?: string) => {
    if (!selectedAccountId || readOnly) return
    void mutate(
      async () => {
        const result = await restaurantTestApi.decideApproval(selectedAccountId, id, action, comment)
        if (result.data.menuChangeStatus === 'failed') {
          await reload()
          throw new ApiError(409, result.data.failureReason || '新価格を反映できませんでした。最新価格を確認して再申請してください。')
        }
      },
      action === 'approve' ? '承認しました。外部公開は行っていません。' : '差し戻しました。',
    )
  }

  return (
    <>
      {readOnly ? (
        <ReadOnlyNotice role="note" />
      ) : null}
      <StatRow>
        <KpiCard title="承認待ち" value={pending.length} unit="対応が必要" valueTone={pending.length > 0 ? 'warning' : 'default'} detail={null} presentation="band" />
        <KpiCard title="Google投稿" value={rows.filter((a) => a.kind === 'gbp_post').length} unit="投稿下書き" detail={null} presentation="band" />
        <KpiCard title="LINE配信" value={rows.filter((a) => a.kind === 'line_message').length} unit="配信下書き" detail={null} presentation="band" />
        <KpiCard title="メニュー改定" value={rows.filter((a) => a.kind === 'menu_change').length} unit="価格・内容変更" detail={null} presentation="band" />
      </StatRow>
      {rows.length === 0 ? (
        <ListState kind="empty" title="承認待ちはありません" />
      ) : (
        rows.map((item) => (
          <ApprovalCard
            key={item.id}
            item={item}
            data={data}
            store={data.stores.find((s) => s.id === item.store_id)}
            busy={busy}
            readOnly={readOnly}
            onApprove={(target) => decide(target.id, 'approve')}
            onReturn={setReturnTarget}
          />
        ))
      )}
      <Card variant="aside">
        <CardHeader size="stacked" title="公開境界" />
        <p className={styles.boundaryText}>承認しても検証中は外部公開しません。状態は「承認済」まで進みます。Google投稿、LINE送信、メニュー媒体反映は、接続承認後に別工程として有効化します。</p>
      </Card>
      <ReturnDialog
        item={returnTarget}
        store={data.stores.find((s) => s.id === returnTarget?.store_id)}
        busy={busy}
        onCancel={() => setReturnTarget(null)}
        onSubmit={(reason) => {
          const target = returnTarget
          if (!target) return
          setReturnTarget(null)
          decide(target.id, 'return', reason)
        }}
      />
    </>
  )
}

export default function ApprovalsV8() {
  return (
    <RestaurantFrame
      boardId="t8WgD8"
      title="承認の流れ"
      description="Google投稿・LINE配信・メニュー改定を公開前に確認します。"
      allStores
    >
      {(ctx) => <ApprovalsBoard ctx={ctx} />}
    </RestaurantFrame>
  )
}
