'use client'
import { useEffect, useRef } from 'react'
import { uidAccountHint } from '@/lib/uid-migration-input'

import CsvTemplateDownload from '@/components/shared/csv-template-download'
import { UID_IMPORT_HEADERS } from '@/lib/csv-import-columns'

import { isOwnerRole } from '@/lib/staff-role'
import type { UidMigrationItem, UidMigrationRun } from '@/lib/api'
import Button from '@/components/shared/button'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { Steps } from '@/components/templates/steps'
import Checkbox from '@/components/shared/checkbox'
import FileDropzone, { AttachmentRow } from '@/components/shared/file-drop'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import Select from '@/components/shared/select'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import StickyBar from '@/components/shared/sticky-bar'
import { TextField } from '@/components/shared/text-field'
import ListRange from '@/components/ui/list-range'
import { formatDateTime, formatNumber } from '@/lib/format'
import { FriendsManageNavV8 } from '@/app/friends'
import { runStatusView, ExecuteConfirmDialog, MigrationItemDialog, RollbackConfirmDialog } from './migration-dialogs'
import {
  classLabel,
  formatMappingBytes,
  ITEM_CLASSIFICATIONS,
  ITEM_PAGE_SIZE,
  MIGRATION_STEPS,
  type ItemClassification,
  type UidMigrationDetail,
  type UidMigrationState,
} from './use-uid-migration'
import styles from '@/app/friends/friends-v8.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockTip } from '@/components/shared/permission-lock-tip'

/*
 * ★V8 UID移行（Pencil  要確認の判断・ 本移行の完了・
 * `sdbsQ` 板5）。
 *
 * 管理画面 と同じ判断・実行・切り戻しの仕組み（use-uid-migration.ts）を使い、
 * 見た目だけを V8 に積み替える。
 *
 * - 5つの段を横のステッパーで示す（ 上部）
 * - 分類ごとの人数を4枚の数カードで出す（自動一致／要確認／一致しない／競合）
 * - 要確認の行は「どうするか」の選び欄で1行ずつ確定する（保存は行ごと。
 *   まとめて保存のAPIは無い）
 * - 完了した履歴は  の形（結果の帯＋照合の結果＋履歴）
 * - 「本移行を実行」「切り戻す」は確認ダイアログを開くだけ（FRIEND-33/36）
 */

const PRE_EXECUTE_STATUSES = ['dry_run', 'review', 'ready']

export default function UidMigrationV8({ m }: { m: UidMigrationState }) {
  const {
    accounts,
    runs,
    active,
    status,
    fromAccountId,
    setFromAccountId,
    toAccountId,
    setToAccountId,
    purpose,
    setPurpose,
    file,
    setFile,
    mappings,
    setMappings,
    busy,
    detailBusy,
    me,
    message,
    setMessage,
    page,
    classification,
    pendingOnly,
    detailItem,
    setDetailItem,
    detailError,
    setDetailError,
    confirmExecute,
    setConfirmExecute,
    executeError,
    setExecuteError,
    confirmRollback,
    setConfirmRollback,
    rollbackError,
    setRollbackError,
    rollbackConflicts,
    setRollbackConflicts,
    load,
    onUidFile,
    createDryRun,
    decide,
    unresolved,
    canRunExecute,
    canRunRollback,
    execute,
    rollback,
    selectRun,
    onFilterChange,
    onPageChange,
  } = m
  const executeTicket = useRef<object | null>(null)
  const rollbackTicket = useRef<object | null>(null)
  const renderedExecuteTicket = executeTicket.current
  const renderedRollbackTicket = rollbackTicket.current
  useEffect(() => () => { executeTicket.current = null; rollbackTicket.current = null }, [])
  useEffect(() => { if (!confirmExecute) executeTicket.current = null }, [confirmExecute])
  useEffect(() => { if (!confirmRollback) rollbackTicket.current = null }, [confirmRollback])
  const openExecute = () => { executeTicket.current = {}; setExecuteError(null); setConfirmExecute(true) }
  const openRollback = () => { rollbackTicket.current = {}; setRollbackError(null); setRollbackConflicts([]); setConfirmRollback(true) }
  const purposeLock = usePermissionLockTip<HTMLDivElement>(m.managerLockReason)
  const { disabled: _purposeDisabled, ...purposeHandlers } = purposeLock.handlers ?? {}

  if (status === 'loading') {
    return <ListState kind="loading" title="UID移行を読み込んでいます" description="移行履歴とアカウントを確認しています。" />
  }
  if (status === 'error') {
    return <ListState kind="error" title="UID移行を表示できませんでした" description="登録した移行履歴は消えていません。" onRetry={() => void load()} />
  }

  const executeBlockedReason = me && isOwnerRole(me.role) && me.id === active?.createdBy
    ? 'この移行はあなたが作成したため、別のownerが実行してください。' : null
  const ownerLockReason = m.ownerLockReason
  const managerLockReason = m.managerLockReason
  const canDecideItems = m.canDecide

  const currentStep = !active
    ? 0
    : active.status === 'completed' || active.status === 'rolled_back'
      ? MIGRATION_STEPS.length
      : active.status === 'ready' || active.status === 'executing' || active.status === 'failed' || unresolved === 0
        ? 4
        : 3

  const showDecisionBoard = active && !['completed', 'rolled_back'].includes(active.status)

  return (
    <div className={styles.board} data-design-node="Z0jHp">
      <FriendsManageNavV8 current="UID移行" />

      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.headTitle}>UID移行</h2>
          <p className={styles.headDescription}>
            別のLINEアカウントから友だちを引っ越します。照合してから本移行します。
          </p>
        </div>
      </div>

      {/* 5つの段（Z0jHp）。手順は型の共通部品 Steps（Fa8ED）で、題と説明のすぐ下・左寄せ・1行。 */}
      <Steps
        label="移行の手順"
        currentKey={currentStep < MIGRATION_STEPS.length ? String(currentStep) : undefined}
        steps={MIGRATION_STEPS.map((step, index) => ({
          key: String(index),
          label: step,
          state: index < currentStep ? 'done' as const : 'todo' as const,
        }))}
      />

      {me !== null && !canDecideItems ? <ReadOnlyNotice need="manager" /> : null}

      {/* FRIEND-15: 「まだ変更していません」は本移行前の履歴だけに出す。 */}
      {(!active || PRE_EXECUTE_STATUSES.includes(active.status)) && (
        <Notice tone="info" role="note">
          <p>本移行まで、既存ユーザー・配信・シナリオには影響しません。</p>
        </Notice>
      )}

      {/* 移行の登録（いつでも新しいテスト移行を始められる）。 */}
      <section className={styles.section} aria-labelledby="uid-register">
        <div className={styles.sectionHead}>
          <h3 id="uid-register" className={styles.sectionTitle}>移行の登録</h3>
          <p className={styles.sectionDesc}>移行元と移行先・対応表のCSVを選び、まずテスト移行で照合します。</p>
        </div>
        <div className={styles.duoCards}>
          <div className={styles.fieldStack}>
            <span className={styles.fieldLabel}>移行元</span>
            <SaveErrorField names={["fromAccountId","from_account_id"]}><EntitySelect aria-label="移行元アカウント" placeholder="移行元アカウントを選択" disabled={!canDecideItems || busy} lockedReason={managerLockReason} value={fromAccountId} onChange={(value) => setFromAccountId(value)} options={[...accounts.map((account) => ({ ...entityOptionMetadata(account), value: account.id, label: account.name, hint: uidAccountHint(account) }))]} size="full" /></SaveErrorField>
          </div>
          <div className={styles.fieldStack}>
            <span className={styles.fieldLabel}>移行先</span>
            <SaveErrorField names={["toAccountId","to_account_id"]}><EntitySelect aria-label="移行先アカウント" placeholder="移行先アカウントを選択" disabled={!canDecideItems || busy} lockedReason={managerLockReason} value={toAccountId} onChange={(value) => setToAccountId(value)} options={[...accounts.map((account) => ({ ...entityOptionMetadata(account), value: account.id, label: account.name, hint: uidAccountHint(account) }))]} size="full" /></SaveErrorField>
          </div>
        </div>
        <div className={styles.fieldStack} style={{ marginTop: 12 }} ref={purposeLock.ref} {...purposeHandlers} tabIndex={m.managerLockReason ? 0 : undefined} role={m.managerLockReason ? "group" : undefined} aria-label={m.managerLockReason ? "利用目的" : undefined}>
          <span className={styles.fieldLabel}>利用目的</span>
          <SaveErrorField names={["purpose"]}><TextField aria-label="利用目的" aria-describedby={purposeLock.handlers?.["aria-describedby"]} disabled={!canDecideItems || busy} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></SaveErrorField>
          {purposeLock.node}
        </div>
        <div style={{ marginTop: 12 }}>
          <CsvTemplateDownload headers={UID_IMPORT_HEADERS} name="UID対応表" />
          <FileDropzone
            title="対応表のCSVをここに置く"
            hint="old_uid・new_uid 列のCSVを選びます"
            accept=".csv,text/csv"
            chooseLabel="CSVをアップロード"
            disabled={!canDecideItems || busy}
            lockedReason={managerLockReason}
            onFiles={(files) => void onUidFile(files)}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          {file ? (
            <AttachmentRow
              disabled={!canDecideItems || busy}
              lockedReason={managerLockReason}
              name={file.name}
              meta={`${formatNumber(mappings.length)}行・${formatMappingBytes(file.size)}`}
              onRemove={() => { setFile(null); setMappings([]); setMessage(null) }}
            />
          ) : (
            <p className={styles.sectionDesc}>ファイルは未選択です</p>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" disabled={!canDecideItems || busy || Boolean(m.dryRunBlockedReason)} lockedReason={managerLockReason} onClick={() => void createDryRun()} busy={busy} busyLabel="確認中…">テスト移行を実行</Button>
          {canDecideItems && m.dryRunBlockedReason ? <p className={styles.sectionDesc} role="status">{m.dryRunBlockedReason}</p> : null}
        </div>
        {message && <p role="status" className={styles.sectionDesc} style={{ marginTop: 8 }}>{message}</p>}
      </section>

      {active && showDecisionBoard && (
        <MigrationReviewBoard
          active={active}
          unresolved={unresolved}
          page={page}
          classification={classification}
          pendingOnly={pendingOnly}
          busy={busy}
          detailBusy={detailBusy}
          canDecide={canDecideItems}
          managerLockReason={managerLockReason}
          ownerLockReason={ownerLockReason}
          canRunExecute={canRunExecute}
          canRunRollback={canRunRollback}
          executeBlockedReason={executeBlockedReason}
          onShowDetail={(item) => { setDetailError(null); setDetailItem(item) }}
          onDecide={(item, decision) => void decide(item, decision)}
          onRequestExecute={openExecute}
          onRequestRollback={openRollback}
          onFilterChange={(nextClassification, nextPendingOnly) => onFilterChange(active.id, nextClassification, nextPendingOnly)}
          onPageChange={(nextPage) => onPageChange(active.id, nextPage)}
        />
      )}

      {active && !showDecisionBoard && (
        <MigrationResultBoard active={active} ownerLockReason={ownerLockReason} canRunRollback={canRunRollback} busy={busy} detailBusy={detailBusy} onRequestRollback={openRollback} />
      )}

      {!active && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>テスト移行の結果</h3>
          </div>
          <ListState kind="empty" title="テスト移行はまだありません" description="移行元・移行先と対応表を選び、まず確認だけ実行してください。" />
        </section>
      )}

      {/* L48eY: 移行の履歴（日時｜移行元 → 移行先｜状態｜切り戻す）。 */}
      <section className={styles.section} aria-labelledby="uid-history">
        <div className={styles.sectionHead}>
          <h3 id="uid-history" className={styles.sectionTitle}>移行の履歴</h3>
          <p className={styles.sectionDesc}>これまでの移行です。選ぶと対応表と結果を見直せます。</p>
        </div>
        {runs.length === 0 ? (
          <ListState kind="empty" title="移行履歴はまだありません" description="移行を実行すると、ここに履歴が表示されます。" />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr className={styles.headRow}>
                  <th>日時</th>
                  <th>移行元 → 移行先</th>
                  <th>状態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <HistoryRow
                    key={run.id}
                    run={run}
                    accountName={(id) => accounts.find((account) => account.id === id)?.name ?? id}
                    isActive={active?.id === run.id}
                    onSelect={() => selectRun(run.id)}
                    canRunRollback={canRunRollback}
                    lockedReason={ownerLockReason}
                    busy={busy || detailBusy}
                    onRollback={run.rollbackable
                      ? () => { selectRun(run.id); openRollback() }
                      : null}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <MigrationItemDialog
        detailItem={detailItem}
        active={active}
        canDecide={canDecideItems}
        lockedReason={managerLockReason}
        busy={busy || detailBusy}
        detailError={detailError}
        onClose={() => { setDetailItem(null); setDetailError(null) }}
        decide={(item, decision) => void decide(item, decision)}
      />
      <ExecuteConfirmDialog
        active={active}
        accounts={accounts}
        me={me}
        busy={busy || detailBusy}
        lockedReason={ownerLockReason}
        open={confirmExecute}
        error={executeError}
        canRun={canRunExecute}
        onConfirm={() => { if (renderedExecuteTicket && executeTicket.current === renderedExecuteTicket) void execute() }}
        onCancel={() => { if (!busy && executeTicket.current === renderedExecuteTicket) { executeTicket.current = null; setConfirmExecute(false) } }}
      />
      <RollbackConfirmDialog
        active={active}
        accounts={accounts}
        me={me}
        busy={busy || detailBusy}
        lockedReason={ownerLockReason}
        open={confirmRollback}
        error={rollbackError}
        conflicts={rollbackConflicts}
        canRun={canRunRollback}
        onConfirm={() => { if (renderedRollbackTicket && rollbackTicket.current === renderedRollbackTicket) void rollback() }}
        onCancel={() => { if (!busy && rollbackTicket.current === renderedRollbackTicket) { rollbackTicket.current = null; setConfirmRollback(false); setRollbackConflicts([]) } }}
      />
    </div>
  )
}

function historyBadge(run: UidMigrationRun): { tone: StatusBadgeTone; label: string } {
  if (run.status === 'completed') return { tone: 'success', label: '本移行済み' }
  if (run.status === 'rolled_back') return { tone: 'neutral', label: '切り戻し済み' }
  if (run.status === 'failed') return { tone: 'danger', label: run.counts.applied > 0 ? '一部失敗' : '失敗' }
  if (run.status === 'executing') return { tone: 'info', label: '実行中' }
  if (run.status === 'ready') return { tone: 'success', label: '確認完了' }
  return { tone: 'neutral', label: '確認中' }
}

function HistoryRow({
  run,
  accountName,
  isActive,
  onSelect,
  onRollback,
  canRunRollback,
  lockedReason,
  busy,
}: {
  run: UidMigrationRun
  accountName: (id: string) => string
  isActive: boolean
  onSelect: () => void
  onRollback: (() => void) | null
  canRunRollback: boolean
  lockedReason?: string
  busy: boolean
}) {
  const badge = historyBadge(run)
  return (
    <tr>
      <td className={styles.nowrap}>{formatDateTime(run.createdAt)}</td>
      <td>
        <button type="button" className={styles.linkAction} onClick={onSelect} aria-current={isActive ? 'true' : undefined}>
          {accountName(run.fromAccountId)} → {accountName(run.toAccountId)}
        </button>
        <span className={styles.pairCellSub}>{run.purpose}・{formatNumber(run.counts.total)}件</span>
      </td>
      <td><StatusBadge tone={badge.tone}>{badge.label}</StatusBadge></td>
      <td>
        {run.rollbackable
          ? <Button type="button" variant="text" size="inline" disabled={!canRunRollback || busy} lockedReason={lockedReason} onClick={onRollback ?? undefined}>切り戻す</Button>
          : <span className={styles.pairCellSub}>{emptyValue('unknown')}</span>}
      </td>
    </tr>
  )
}

/** : 判断する帯。分類カード＋対応表＋下の追従帯。 */
function MigrationReviewBoard({
  active,
  unresolved,
  page,
  classification,
  pendingOnly,
  busy,
  detailBusy,
  canDecide,
  managerLockReason,
  ownerLockReason,
  canRunExecute,
  canRunRollback,
  executeBlockedReason,
  onShowDetail,
  onDecide,
  onRequestExecute,
  onRequestRollback,
  onFilterChange,
  onPageChange,
}: {
  active: UidMigrationDetail
  unresolved: number | null
  page: number
  classification: '' | ItemClassification
  pendingOnly: boolean
  busy: boolean
  detailBusy: boolean
  canDecide: boolean
  managerLockReason?: string
  ownerLockReason?: string
  canRunExecute: boolean
  canRunRollback: boolean
  executeBlockedReason: string | null
  onShowDetail: (item: UidMigrationItem) => void
  onDecide: (item: UidMigrationItem, decision: 'link' | 'create' | 'exclude') => void
  onRequestExecute: () => void
  onRequestRollback: () => void
  onFilterChange: (classification: '' | ItemClassification, pendingOnly: boolean) => void
  onPageChange: (page: number) => void
}) {
  const total = active.itemTotal ?? active.items?.length ?? 0
  const showPager = page > 0 || total > ITEM_PAGE_SIZE
  const from = total === 0 ? 0 : page * ITEM_PAGE_SIZE + 1
  const to = Math.min((page + 1) * ITEM_PAGE_SIZE, total)
  const statusView = runStatusView(active, unresolved)
  const decisionsLocked = !['review', 'ready', 'failed'].includes(active.status)

  return (
    <>
      {/* Z0jHp: 自動で一致／要確認／一致しない／競合 の4枚。 */}
      <KpiBand role="group" aria-label="照合の内訳">
        <KpiCard presentation="band" icon={null} title="自動で一致" value={active.counts.auto} unit="人" detail="そのまま引き継ぐ" />
        <KpiCard presentation="band" icon={null} title="要確認" value={active.counts.review} unit="人" detail="いまここで決める" />
        <KpiCard presentation="band" icon={null} title="一致しない" value={active.counts.unmatched} unit="人" detail="新しく作るか除く" />
        <KpiCard presentation="band" icon={null} title="競合" value={active.counts.conflict} unit="人" detail="同じ先に2人いる" />
      </KpiBand>

      <section className={styles.section} aria-labelledby="uid-review">
        <div className={styles.sectionHead}>
          <h3 id="uid-review" className={styles.sectionTitle}>要確認の判断</h3>
          <p className={styles.sectionDesc}>{statusView.description}</p>
          <StatusBadge tone={statusView.badgeTone}>{statusView.badgeLabel}</StatusBadge>
        </div>
        <div className={styles.toolbar}>
          <SaveErrorField names={["classification"]}><Select aria-label="分類で絞り込む" label="分類" value={classification} onChange={(value) => onFilterChange(value as '' | ItemClassification, pendingOnly)} options={[{ value: '', label: 'すべての分類' }, ...ITEM_CLASSIFICATIONS.map((value) => ({ value, label: classLabel[value] }))]} size="standard" /></SaveErrorField>
          <SaveErrorField names={["pendingOnly","pending_only"]}><Checkbox checked={pendingOnly} onCheckedChange={(checked) => onFilterChange(classification, checked)}>未判断のみ</Checkbox></SaveErrorField>
          <span className={styles.toolbarSpacer} />
          <span className={styles.toolbarCount}>全 {formatNumber(total)} 件{detailBusy ? '・読み込み中…' : ''}</span>
        </div>
        {detailBusy && <p role="status" className={styles.sectionDesc}>対応表を読み込んでいます…</p>}
        {(active.items?.length ?? 0) === 0 ? (
          <ListState kind="empty" title="対応表に結果がありません" description="絞り込みを変えるか、別のCSVを選んでテスト移行してください。" />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr className={styles.headRow}>
                  <th>移行元 uid</th>
                  <th>移行先 uid</th>
                  <th>一致</th>
                  <th>どうするか</th>
                </tr>
              </thead>
              <tbody>
                {active.items?.map((item, saveFieldIndex) => (
                  <tr key={item.id}>
                    <td className={`${styles.nowrap} ${styles.mono}`} title={item.oldUid}>{item.oldUid}</td>
                    <td>
                      <span className={styles.mono}>{item.newUid ?? emptyValue('unknown')}</span>
                      {item.candidateName && <span className={styles.pairCellSub}>{item.candidateName}</span>}
                      {item.conflictReason && <span className={styles.pairCellSub}>{item.conflictReason}</span>}
                    </td>
                    <td>
                      <StatusBadge tone={item.classification === 'auto' ? 'success' : item.classification === 'unmatched' ? 'neutral' : 'warning'}>
                        {classLabel[item.classification]}
                      </StatusBadge>
                    </td>
                    <td>
                      <div className={styles.chips}>
                        {/*
                          FRIEND-14: 行の選び欄は選んだ時点で保存する
                          （一覧の各行が「どうするか」を持つ Z0jHp の形）。
                          まとめて保存のAPIは無いので行ごとの保存のままにする。
                        */}
                        {decisionsLocked ? (
                          <span className={styles.pairCellSub}>{item.decision === 'pending' ? '未判断' : item.decision === 'link' ? '結び付ける' : item.decision === 'create' ? '新しく作る' : '除く'}</span>
                        ) : (
                          <SaveErrorField names={[`items.${saveFieldIndex}.decision`,"decision","item.decision"]}><Select
                            aria-label={`${item.oldUid} の引き継ぎ方`}
                            size="standard"
                            disabled={!canDecide || busy || detailBusy}
                            lockedReason={managerLockReason}
                            value={item.decision === 'pending' ? '' : item.decision}
                            onChange={(value) => { if (value) onDecide(item, value as 'link' | 'create' | 'exclude') }}
                            options={[
                              { value: '', label: '選んでください' },
                              ...(item.newUid ? [{ value: 'link', label: '結び付ける' }, { value: 'create', label: '新しく作る' }] : []),
                              { value: 'exclude', label: '除く' },
                            ]}
                          /></SaveErrorField>
                        )}
                        <button type="button" className={styles.linkAction} disabled={busy || detailBusy} onClick={() => onShowDetail(item)}>詳細</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showPager && (
          <div className={styles.pagerRow}>
            <ListRange total={total} first={from} last={to} />
            <Pagination page={page + 1} pageCount={Math.max(1, Math.ceil(total / ITEM_PAGE_SIZE))} onPageChange={(next) => onPageChange(next - 1)} disabled={busy || detailBusy} />
          </div>
        )}
      </section>

      {/*
        Z0jHp 下の追従帯：左に「切り戻す」（使えるときだけ）、中央に
        一覧へ戻る・本移行へ進む。実行は確認ダイアログが開くだけ。
      */}
      <StickyBar
        destructive={
          active.rollbackable
            ? <Button type="button" variant="danger" disabled={!canRunRollback || busy || detailBusy} lockedReason={ownerLockReason} onClick={onRequestRollback}>この移行を切り戻す</Button>
            : undefined
        }
        status={unresolved !== null && unresolved > 0 ? `要確認 ${formatNumber(unresolved)} 件` : undefined}
        actions={
          <>
            <Button type="button" href="/friends">友だち一覧へ戻る</Button>
            {active.status === 'ready' && (
              <Button type="button" variant="primary" disabled={!canRunExecute || busy || detailBusy} lockedReason={ownerLockReason} disabledReason={ownerLockReason ? undefined : executeBlockedReason ?? undefined} onClick={onRequestExecute}>
                本移行へ進む
              </Button>
            )}
          </>
        }
      />
    </>
  )
}

/** : 本移行と照合が終わった履歴。結果の帯＋照合の内訳。 */
function MigrationResultBoard({
  active,
  ownerLockReason,
  canRunRollback,
  busy,
  detailBusy,
  onRequestRollback,
}: {
  active: UidMigrationDetail
  ownerLockReason?: string
  canRunRollback: boolean
  busy: boolean
  detailBusy: boolean
  onRequestRollback: () => void
}) {
  const statusView = runStatusView(active, null)
  const isCompleted = active.status === 'completed'
  return (
    <>
      <Notice tone={isCompleted ? "info" : "danger"} role={isCompleted ? 'note' : 'alert'}>
        <p>
          {isCompleted
            ? `本移行と照合が終わりました。${formatNumber(active.counts.applied)} 人を引き継ぎました。必要ならこの履歴から切り戻せます。`
            : statusView.description}
        </p>
      </Notice>
      <KpiBand role="group" aria-label="照合の結果">
        <KpiCard presentation="band" icon={null} title="引き継いだ" value={active.counts.applied} unit="人" detail="" />
        <KpiCard presentation="band" icon={null} title="一致先なし" value={active.counts.unmatched} unit="人" detail="" />
        <KpiCard presentation="band" icon={null} title="除いた" value={active.decisionCounts?.exclude ?? 0} unit="人" detail="" />
        <KpiCard presentation="band" icon={null} title="失敗" value={active.counts.failed} unit="人" detail="" />
      </KpiBand>
      {active.rollbackable && (
        <div className={styles.cardCenter}>
          <Button type="button" variant="danger" disabled={!canRunRollback || busy || detailBusy} lockedReason={ownerLockReason} onClick={onRequestRollback}>この移行を切り戻す</Button>
        </div>
      )}
    </>
  )
}
