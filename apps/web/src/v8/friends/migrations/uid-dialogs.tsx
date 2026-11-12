'use client'

import { Undo2 } from 'lucide-react'
import OperationTargetSummary from '@/components/shared/operation-target-summary'


/*
 * ★V8 UID移行の確認窓（app/accounts/migration.tsx の MigrationItemDialog・ExecuteConfirmDialog・
 * RollbackConfirmDialog と runStatusView の写し。src/v8 は @/app を読めない）。
 * 文言・権限の言い分け・確定ボタンだけが実行する決まりは同じ。見た目のクラスだけ V8 の画面 CSS に替えた。
 */
import type { LineAccount } from '@line-crm/shared'
import { isOwnerRole } from '@/lib/staff-role'
import type { UidMigrationItem } from '@/lib/api'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import { formatNumber } from '@/lib/format'
import { classLabel, decisionLabel, type UidMigrationDetail } from './use-uid-migration'
import styles from './migrations.module.css'
import { emptyValue } from '@/components/shared/empty-value'

interface RunStatusView {
  description: string
  badgeTone: StatusBadgeTone
  badgeLabel: string
}

/** 見出し・説明・札は run.status だけで決める（完了した履歴へ「まだ変更していません」と出さない）。 */
export function runStatusView(run: UidMigrationDetail, unresolved: number | null): RunStatusView {
  switch (run.status) {
    case 'completed':
      return { description: '本移行と照合が完了しています。必要な場合はこの履歴から切り戻せます。', badgeTone: 'success', badgeLabel: '本移行済み' }
    case 'rolled_back':
      return { description: '切り戻し済みです。反映した内容は移行前の状態へ戻しています。', badgeTone: 'neutral', badgeLabel: '切り戻し済み' }
    case 'executing':
      return { description: '本移行を実行しています。結果が出るまで操作をお待ちください。', badgeTone: 'info', badgeLabel: '実行中' }
    case 'failed':
      return run.counts.applied > 0
        ? {
            description: `一部だけ反映されました（反映 ${formatNumber(run.counts.applied)} 件・失敗 ${formatNumber(run.counts.failed)} 件）。失敗した行を確認して再実行するか、反映済みの分だけ切り戻せます。`,
            badgeTone: 'danger',
            badgeLabel: '一部失敗',
          }
        : { description: '本移行は失敗しました。実データは変更されていません。', badgeTone: 'danger', badgeLabel: '失敗' }
    default:
      return {
        description: '実データはまだ変更していません。',
        badgeTone: unresolved === 0 ? 'success' : 'warning',
        badgeLabel: unresolved === 0 ? '確認完了' : `要確認 ${unresolved ?? emptyValue('unknown')}件`,
      }
  }
}

const EVIDENCE = { same_provider: '同一提供者', line_login: 'LINEログイン', signed_customer_id: '署名済み顧客ID', verified_contact: '確認済み連絡先', operator_csv: '運用者のCSV', manual: '手作業' } as const
const RESULT = { pending: '未実行', applied: '反映済み', skipped: '除外', failed: '失敗', rolled_back: '切り戻し済み' } as const

export function MigrationItemDialog({
  detailItem,
  active,
  canDecide,
  lockedReason,
  busy,
  detailError,
  onClose,
  decide,
}: {
  detailItem: UidMigrationItem | null
  active: UidMigrationDetail | null
  canDecide: boolean
  lockedReason?: string
  busy: boolean
  detailError: string | null
  onClose: () => void
  decide: (item: UidMigrationItem, decision: 'link' | 'create' | 'exclude') => void
}) {
  return (
    <Dialog
      open={detailItem !== null}
      title="移行内容の確認"
      description="内容の確認だけでは保存されません。承認・除外は下のボタンで確定します。"
      busy={busy}
      error={detailError ?? undefined}
      onCancel={() => { if (!busy) onClose() }}
      footer={detailItem ? (<DialogActions>
          {active && !['review', 'ready', 'failed'].includes(active.status) ? (<span className={styles.small}>この移行の状態では判断を変更できません。</span>) : (<>
              {detailItem.decision !== 'exclude' ? <Button type="button" disabled={!canDecide || busy} lockedReason={lockedReason} onClick={() => decide(detailItem, 'exclude')}>除外する</Button> : null}
              {detailItem.newUid && detailItem.decision !== 'link' ? <Button type="button" variant="primary" disabled={!canDecide || busy} lockedReason={lockedReason} onClick={() => decide(detailItem, 'link')}>この組合せを承認</Button> : null}
            </>)}
        </DialogActions>) : undefined}
    >
      {detailItem ? (
        <dl className={styles.detailList}>
          <div><dt>旧UID</dt><dd>{detailItem.oldUid}</dd></div>
          <div><dt>新UID</dt><dd>{detailItem.newUid ?? emptyValue('unknown')}</dd></div>
          <div><dt>候補ユーザー</dt><dd>{detailItem.candidateName ?? '候補なし'}</dd></div>
          <div><dt>一致根拠</dt><dd>{EVIDENCE[detailItem.evidenceType]}</dd></div>
          <div><dt>分類</dt><dd>{classLabel[detailItem.classification]}</dd></div>
          <div><dt>競合内容</dt><dd>{detailItem.conflictReason ?? emptyValue('unknown')}</dd></div>
          <div><dt>現在の判断</dt><dd>{decisionLabel[detailItem.decision]}</dd></div>
          <div><dt>実行結果</dt><dd>{`${RESULT[detailItem.result]}${detailItem.errorMessage ? `（${detailItem.errorMessage}）` : ''}`}</dd></div>
        </dl>
      ) : null}
    </Dialog>
  )
}

/** 本移行の実行確認。確定ボタンだけが execute を呼ぶ。 */
export function ExecuteConfirmDialog({
  active, accounts, me, busy, open, error, canRun, lockedReason, onConfirm, onCancel,
}: {
  active: UidMigrationDetail | null
  accounts: LineAccount[]
  me: { id: string; role: string } | null
  busy: boolean
  open: boolean
  error: string | null
  canRun: boolean
  lockedReason?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!active) return null
  const name = (id: string) => accounts.find((account) => account.id === id)?.name ?? id
  return (
    <ConfirmDialog
      open={open}
      title="本移行を実行します"
      description="実行すると友だちと統合ユーザーの紐付けが実際に変わります。内容を確認してから確定してください。"
      confirmLabel="本移行を実行"
      busy={busy}
      error={error ?? undefined}
      confirmDisabled={!canRun}
      confirmLockedReason={lockedReason}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <OperationTargetSummary accounts={[
        { id: active.fromAccountId, name: accounts.find(account => account.id === active.fromAccountId)?.name, label: '移行元LINEアカウント' },
        { id: active.toAccountId, name: accounts.find(account => account.id === active.toAccountId)?.name, label: '移行先LINEアカウント' },
      ]} />
      <ul className={styles.bullets}>
        <li>{`対象：${name(active.fromAccountId)} → ${name(active.toAccountId)}`}</li>
        <li>{`結び付け ${active.decisionCounts?.link ?? emptyValue('unknown')} 件・除外 ${active.decisionCounts?.exclude ?? emptyValue('unknown')} 件・新規作成の判断 ${active.decisionCounts?.create ?? emptyValue('unknown')} 件（自動反映できない行は失敗として記録されます）`}</li>
        <li>実行権限：オーナーのみ。テスト移行を作成した本人は実行できません。</li>
        <li>復旧：実行後、この履歴から反映済みの分だけ切り戻せます。移行後に別の変更があった行は切り戻しを止めて表示します。</li>
      </ul>
      {me && !isOwnerRole(me.role) && !lockedReason ? <p className={styles.dangerNote}>本移行の実行はownerの権限が必要です。</p> : null}
      {me && isOwnerRole(me.role) && me.id === active.createdBy ? <p className={styles.dangerNote}>この移行はあなたが作成したため、別のownerが実行してください。</p> : null}
    </ConfirmDialog>
  )
}

/** 切り戻しの確認。 */
export function RollbackConfirmDialog({
  active, accounts = [], me, busy, open, error, conflicts, canRun, lockedReason, onConfirm, onCancel,
}: {
  active: UidMigrationDetail | null
  accounts?: LineAccount[]
  me: { id: string; role: string } | null
  busy: boolean
  open: boolean
  error: string | null
  conflicts: Array<{ itemId: string; oldUid: string; reason: string }>
  canRun: boolean
  lockedReason?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!active) return null
  return (
    <ConfirmDialog
      open={open}
      title="この移行を切り戻します"
      description={`反映した ${formatNumber(active.counts.applied)} 件を移行前の紐付けに戻します。移行後に別の変更があった行は切り戻さず、競合として表示します。`}
      confirmLabel="切り戻す"
      confirmIcon={<Undo2 size={16} aria-hidden="true" />}
      destructive
      busy={busy}
      error={error ?? undefined}
      confirmDisabled={!canRun}
      confirmLockedReason={lockedReason}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <OperationTargetSummary accounts={[
        { id: active.fromAccountId, name: accounts.find(account => account.id === active.fromAccountId)?.name, label: '移行元LINEアカウント' },
        { id: active.toAccountId, name: accounts.find(account => account.id === active.toAccountId)?.name, label: '移行先LINEアカウント' },
      ]} />
      <ul className={styles.bullets}>
        <li>{`対象：この履歴で反映済みの ${formatNumber(active.counts.applied)} 行だけです。失敗・除外の行は変更しません。`}</li>
        <li>制約：移行後に統合ユーザーへ別の変更があった行は切り戻せません。</li>
        <li>実行権限：オーナーのみ。</li>
      </ul>
      {conflicts.length > 0 ? (
        <ul className={`${styles.bullets} ${styles.dangerNote}`}>
          {conflicts.map((conflict) => <li key={conflict.itemId}>{`${conflict.oldUid}：${conflict.reason}`}</li>)}
        </ul>
      ) : null}
      {me && !isOwnerRole(me.role) && !lockedReason ? <p className={styles.dangerNote}>切り戻しはownerの権限が必要です。</p> : null}
    </ConfirmDialog>
  )
}
