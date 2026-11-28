'use client'
import { useRef } from 'react'
import { uidAccountHint } from '@/lib/uid-migration-input'
import SegmentedControl from '@/components/shared/segmented'

import CsvTemplateDownload from '@/components/shared/csv-template-download'
import { UID_IMPORT_HEADERS } from '@/lib/csv-import-columns'

import { isOwnerRole } from '@/lib/staff-role'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockTip } from '@/components/shared/permission-lock-tip'
import { shortUid, historyBadge } from './uid-labels'

import { useState } from 'react'
import { Inbox, CheckCheck, CircleCheck, Download, Plus, Undo2 } from 'lucide-react'
import type { UidMigrationItem } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { usePageTitle } from '@/components/shell/page-chrome'
import { PageFrame } from '@/components/templates/page-frame'
import { PageFooter } from '@/components/templates/page-footer'
import { Steps } from '@/components/templates/steps'
import Button from '@/components/shared/button'
import FilterChip from '@/components/shared/filter-chip'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import FileDropzone, { AttachmentRow } from '@/components/shared/file-drop'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import Pagination from '@/components/shared/pagination'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { FriendsSectionHead } from '../shared/head'
import { slashDateTime } from '../duplicates/words'
import { csvExportLine } from '../list/csv-export'
import { ExecuteConfirmDialog, MigrationItemDialog, RollbackConfirmDialog, runStatusView } from './uid-dialogs'
import { classLabel, decisionLabel, formatMappingBytes, ITEM_PAGE_SIZE, MIGRATION_STEPS, useUidMigration, type ItemClassification } from './use-uid-migration'
import styles from './migrations.module.css'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'

/*
 * ★V8 UID移行（Pencil  要確認の判断・ 本移行と照合の完了）。/friends/migrations?tab=uid（`&run=` で履歴を選ぶ）。
 *
 * 判断・実行・切り戻しの口は今と同じ（use-uid-migration：行ごとの判断・実行と切り戻しは確認窓の確定だけ・
 * owner と作成者の決まり・結果不明のときの読み直し）。今の入口 /accounts?tab=migration はそのまま。
 * 見せ方：頭（← 友だちへ・タブ）→ 5つの段 → 判断中なら数4つと「要確認の判断」、終わったら結果の帯と「照合の結果」
 * → 移行の履歴 → 新しい移行の登録（開いて使う）。
 */

const PRE_EXECUTE = ['dry_run', 'review', 'ready']

export default function UidMigrationV8({ initialRunId }: { initialRunId: string | null }) {
  usePageTitle('友だち')
  const m = useUidMigration(initialRunId)
  const purposeLock = usePermissionLockTip<HTMLDivElement>(m.managerLockReason)
  const { disabled: _purposeDisabled, ...purposeHandlers } = purposeLock.handlers ?? {}
  const [registerOpen, setRegisterOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const active = m.active

  const executeBlockedReason = m.me && isOwnerRole(m.me.role) && m.me.id === active?.createdBy
    ? 'この移行はあなたが作成したため、別のownerが実行してください。' : undefined
  const canDecideItems = m.canDecide
  const currentStep = !active
    ? 0
    : active.status === 'completed' || active.status === 'rolled_back'
      ? MIGRATION_STEPS.length
      : active.status === 'ready' || active.status === 'executing' || active.status === 'failed' || m.unresolved === 0
        ? 4
        : 3
  const reviewing = Boolean(active && !['completed', 'rolled_back'].includes(active.status))
  const decisionsLocked = !active || !['review', 'ready', 'failed'].includes(active.status)
  const accountName = (id: string) => m.accounts.find((account) => account.id === id)?.name ?? (id.endsWith('-old') ? '旧アカウント' : id)

  /* 頭の「表示中をCSVで書き出す」：いま出ている対応表（このページ）を CSV にする。 */
  const exportItems = () => {
    if (!active?.items?.length) return
    const header = ['移行元uid', '移行先uid', '一致', 'どうするか']
    const rows = active.items.map((item) => [item.oldUid, item.newUid ?? '', classLabel[item.classification], decisionLabel[item.decision]])
    const csv = [header, ...rows].map((row) => csvExportLine(row)).join('\n')
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("UID移行")
    anchor.click()
    URL.revokeObjectURL(url)
  }

  /* 「要確認をまとめて結び付ける」：このページの要確認・未判断・移行先ありの行を1行ずつ結び付ける（まとめての口は無い）。 */
  const bulkTargets: UidMigrationItem[] = (active?.items ?? []).filter((item) => item.classification === 'review' && item.decision === 'pending' && item.newUid)
  const bulkConfirmation = useRef<{ runId: string | null; items: UidMigrationItem[]; acknowledged: Set<string> }>({ runId: null, items: [], acknowledged: new Set() })
  const runBulkLink = async () => {
    const confirmation = bulkConfirmation.current
    if (confirmation.runId !== active?.id) return
    return m.decideMany(confirmation.items, 'link', confirmation.acknowledged)
  }

  const register = (
    <section className={styles.card} aria-labelledby="uid-register">
      <div className={styles.cardHead}>
        <h3 id="uid-register" className={styles.cardTitle}>移行の登録</h3>
        <p className={styles.cardSub}>移行元と移行先・対応表のCSVを選び、まずテスト移行で照合します。本移行まで、既存ユーザー・配信・シナリオには影響しません。</p>
      </div>
      <div className={styles.pair}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>移行元</span>
          <SaveErrorField names={["fromAccountId","m.fromAccountId","from_account_id","m.from_account_id"]}><EntitySelect aria-label="移行元アカウント" placeholder="移行元アカウントを選択" size="full" disabled={!canDecideItems || m.busy} lockedReason={m.managerLockReason} value={m.fromAccountId} onChange={m.setFromAccountId} options={[...m.accounts.map((account) => ({ ...entityOptionMetadata(account), value: account.id, label: account.name, hint: uidAccountHint(account) }))]} /></SaveErrorField>
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>移行先</span>
          <SaveErrorField names={["toAccountId","m.toAccountId","to_account_id","m.to_account_id"]}><EntitySelect aria-label="移行先アカウント" placeholder="移行先アカウントを選択" size="full" disabled={!canDecideItems || m.busy} lockedReason={m.managerLockReason} value={m.toAccountId} onChange={m.setToAccountId} options={[...m.accounts.map((account) => ({ ...entityOptionMetadata(account), value: account.id, label: account.name, hint: uidAccountHint(account) }))]} /></SaveErrorField>
        </div>
      </div>
      <div className={styles.field} ref={purposeLock.ref} {...purposeHandlers} tabIndex={m.managerLockReason ? 0 : undefined} role={m.managerLockReason ? "group" : undefined} aria-label={m.managerLockReason ? "利用目的" : undefined}>
        <span className={styles.fieldLabel}>利用目的</span>
        <SaveErrorField names={["purpose","m.purpose"]}><TextField aria-describedby={purposeLock.handlers?.["aria-describedby"]} disabled={!canDecideItems || m.busy} value={m.purpose} onChange={(event) => m.setPurpose(event.target.value)} aria-label="利用目的" /></SaveErrorField>
        {purposeLock.node}
      </div>
      <CsvTemplateDownload headers={UID_IMPORT_HEADERS} name="UID対応表" />
      <FileDropzone title="対応表のCSVをここに置く" hint="old_uid・new_uid 列のCSVを選びます" accept=".csv,text/csv" chooseLabel="CSVをアップロード" disabled={!canDecideItems || m.busy} lockedReason={m.managerLockReason} onFiles={(files) => void m.onUidFile(files)} />
      {m.file ? (
        <AttachmentRow disabled={!canDecideItems || m.busy} lockedReason={m.managerLockReason} name={m.file.name} meta={`${formatNumber(m.mappings.length)} 行・${formatMappingBytes(m.file.size)}`} onRemove={() => { m.setFile(null); m.setMappings([]); m.setMessage(null) }} />
      ) : <p className={styles.small}>ファイルは未選択です</p>}
      <div className={styles.cardFoot}>
        <Button variant="primary" disabled={!canDecideItems || m.busy || Boolean(m.dryRunBlockedReason)} lockedReason={m.managerLockReason} onClick={() => void m.createDryRun()} busy={m.busy} busyLabel="確認中…">テスト移行を実行</Button>
        {canDecideItems && m.dryRunBlockedReason ? <p className={styles.small} role="status">{m.dryRunBlockedReason}</p> : null}
      </div>
    </section>
  )

  let body
  if (m.status === 'loading') {
    body = <ListState kind="loading" title="UID移行を読み込んでいます" description="移行履歴とアカウントを確認しています。" />
  } else if (m.status === 'error') {
    body = <ListState kind="error" title="UID移行を表示できませんでした" description="登録した移行履歴は消えていません。" onRetry={() => void m.load()} />
  } else {
    const statusView = active ? runStatusView(active, m.unresolved) : null
    const total = active?.itemTotal ?? active?.items?.length ?? 0
    const pageCount = Math.max(1, Math.ceil(total / ITEM_PAGE_SIZE))
    body = (
      <>
        {/* 手順は型の共通部品 Steps（Fa8ED）。タブの中の頭（題と説明の下）に1行で置く。 */}
        <Steps
          label="移行の手順"
          currentKey={currentStep < MIGRATION_STEPS.length ? String(currentStep) : undefined}
          steps={MIGRATION_STEPS.map((step, index) => ({
            key: String(index),
            label: step,
            state: index < currentStep ? 'done' as const : 'todo' as const,
          }))}
        />

        {m.me !== null && !canDecideItems ? <ReadOnlyNotice need="manager" /> : null}
        {m.message ? <p role="status" className={styles.message}>{m.message}</p> : null}

        {!active ? register : null}

        {active && reviewing ? (
          <>
            <KpiBand gridClassName="grid grid-cols-4" role="group" aria-label="照合の内訳">
              {([
                ['auto', '自動で一致', active.counts.auto, 'そのまま引き継ぐ'],
                ['review', '要確認', active.counts.review, 'いまここで決める'],
                ['unmatched', '一致しない', active.counts.unmatched, '新しく作るか除く'],
                ['conflict', '競合', active.counts.conflict, '同じ先に2人'],
              ] as const).map(([key, title, value, detail]) => (
                <KpiCard key={key} presentation="band" icon={<Inbox size={16} />} title={title} value={value} unit="人" detail={detail} />
              ))}
            </KpiBand>

            <section className={styles.card} aria-labelledby="uid-review">
              <div className={styles.cardHead}>
                <h3 id="uid-review" className={styles.cardTitle}>要確認の判断</h3>
                <p className={styles.cardSub}>{`1人ずつ、どう引き継ぐかを決めます。${statusView?.description ?? ''}（${statusView?.badgeLabel ?? ''}）`}</p>
              </div>
              <div className={styles.toolRow}>
                <div role="group" aria-label="分類で絞り込む" className={styles.chipRow}>
                  <SegmentedControl<ItemClassification | ''> aria-label="分類で絞り込む" fit="content" value={m.classification} onClear={() => m.onFilterChange(active.id, '', m.pendingOnly)} onChange={(value) => m.onFilterChange(active.id, value, m.pendingOnly)} options={[
                    { value: '', label: 'すべて' }, { value: 'review', label: '要確認', count: active.counts.review },
                    { value: 'conflict', label: '競合', count: active.counts.conflict }, { value: 'unmatched', label: '一致しない', count: active.counts.unmatched },
                  ]} />
                  <FilterChip selected={m.pendingOnly} onChange={() => m.onFilterChange(active.id, m.classification, !m.pendingOnly)}>
                    {`未判断 ${m.unresolved == null ? emptyValue('unknown') : formatNumber(m.unresolved)}`}
                  </FilterChip>
                </div>
                <span className={styles.spacer} />
                {!decisionsLocked && bulkTargets.length > 0 ? (
                  <Button type="button" variant="text" size="inline" disabled={!canDecideItems || m.busy || m.detailBusy} lockedReason={m.managerLockReason} onClick={() => { bulkConfirmation.current = { runId: active.id, items: bulkTargets, acknowledged: new Set() }; m.clearDecisionError(); setBulkOpen(true) }}>
                    <CheckCheck size={16} aria-hidden="true" />
                    要確認をまとめて「結び付ける」
                  </Button>
                ) : null}
              </div>
              {(active.items?.length ?? 0) === 0 ? (
                <ListState kind="empty" title="対応表に結果がありません" description="絞り込みを変えるか、別のCSVを選んでテスト移行してください。" />
              ) : (
                <DataTable className={styles.table}>
                  <colgroup>
                    <col className={styles.colUid} />
                    <col />
                    <col className={styles.colKind} />
                    <col className={styles.colDecide} />
                  </colgroup>
                  <thead>
                    <TableHeadRow>
                      <Th className={styles.th}>移行元 uid</Th>
                      <Th className={styles.th}>移行先 uid</Th>
                      <Th className={styles.th}>一致</Th>
                      <Th className={styles.th}>どうするか</Th>
                    </TableHeadRow>
                  </thead>
                  <tbody>
                    {active.items?.map((item, saveFieldIndex) => (
                      <Tr key={item.id} className={`${styles.row} ${styles.rowTall}`} data-row-id={item.id}>
                        <Td className={styles.td}>
                          <button type="button" className={`${styles.mono} ${styles.uidButton}`} title={`${item.oldUid}（詳細を見る）`}  onClick={() => { m.setDetailError(null); m.setDetailItem(item) }}>
                            {shortUid(item.oldUid)}
                          </button>
                        </Td>
                        <Td className={styles.td}>
                          <span className={styles.mono} title={[item.newUid, item.candidateName, item.conflictReason].filter(Boolean).join(' ／ ') || undefined}>{item.newUid ? shortUid(item.newUid) : emptyValue('unknown')}</span>
                        </Td>
                        <Td className={styles.td}>
                          <span className={`${styles.pill} ${item.classification === 'auto' ? styles.pillOk : item.classification === 'conflict' ? styles.pillDanger : item.classification === 'unmatched' ? styles.pillMuted : styles.pillWarn}`}>
                            {item.classification === 'unmatched' ? '一致しない' : classLabel[item.classification]}
                          </span>
                        </Td>
                        <Td className={styles.td}>
                          {decisionsLocked ? (
                            <span className={styles.small}>{decisionLabel[item.decision]}</span>
                          ) : (
                            <SaveErrorField names={[`items.${saveFieldIndex}.decision`,"decision","item.decision"]}><Select
                              aria-label={`${item.oldUid} の引き継ぎ方`}
                              size="full"
                              disabled={!canDecideItems || m.busy || m.detailBusy}
                              lockedReason={m.managerLockReason}
                              value={item.decision === 'pending' ? '' : item.decision}
                              onChange={(value) => { if (value) void m.decide(item, value as 'link' | 'create' | 'exclude') }}
                              options={[
                                { value: '', label: '選んでください' },
                                ...(item.newUid ? [{ value: 'link', label: '結び付ける' }, { value: 'create', label: '新しく作る' }] : []),
                                { value: 'exclude', label: '除く' },
                              ]}
                            /></SaveErrorField>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </DataTable>
              )}
              {pageCount > 1 ? (
                <div className={styles.pagerRow}>
                  <span className={styles.small}>{`${formatNumber(total)} 件中 ${formatNumber(m.page * ITEM_PAGE_SIZE + 1)}〜${formatNumber(Math.min((m.page + 1) * ITEM_PAGE_SIZE, total))} 件`}</span>
                  <Pagination page={m.page + 1} pageCount={pageCount} onPageChange={(next) => m.onPageChange(active.id, next - 1)} disabled={m.busy || m.detailBusy} />
                </div>
              ) : null}
            </section>
          </>
        ) : null}

        {active && !reviewing ? (
          <>
            <Notice tone={active.status === "completed" ? "success" : "info"} role="note" icon={<CircleCheck size={20} aria-hidden="true" />} heading={<>{active.status === 'completed' ? '本移行と照合が終わりました' : statusView?.badgeLabel}</>}>
              <span className={styles.bandText}>
                {active.status === 'completed'
                  ? `${formatNumber(active.counts.applied)} 人を引き継ぎました。必要ならこの履歴から切り戻せます。`
                  : statusView?.description}
              </span>
            </Notice>
            <section className={styles.card} aria-labelledby="uid-result">
              <h3 id="uid-result" className={styles.cardTitle}>照合の結果</h3>
              <ul className={styles.lines}>
                <li className={styles.line}><span>引き継いだ</span><span className={styles.lineGood}>{`${formatNumber(active.counts.applied)} 人`}</span></li>
                <li className={styles.line}><span>一致先なし（CSVで書き出す・取り込むで作る）</span><span className={styles.lineValue}>{`${formatNumber(active.counts.unmatched)} 人`}</span></li>
                <li className={styles.line}><span>除いた</span><span className={styles.lineValue}>{`${formatNumber(active.decisionCounts?.exclude ?? 0)} 人`}</span></li>
                <li className={styles.line}><span>失敗</span><span className={styles.lineValue}>{`${formatNumber(active.counts.failed)} 人`}</span></li>
              </ul>
            </section>
          </>
        ) : null}

        <section className={styles.card} aria-labelledby="uid-history">
          <div className={styles.cardHeadRow}>
            <h3 id="uid-history" className={styles.cardTitle}>移行の履歴</h3>
            {active ? (
              <Button type="button" variant="text" size="inline" disabled={!canDecideItems || m.busy} lockedReason={m.managerLockReason} aria-expanded={registerOpen} onClick={() => setRegisterOpen((open) => !open)}>
                <Plus size={16} aria-hidden="true" />
                新しい移行を作る
              </Button>
            ) : null}
          </div>
          {m.runs.length === 0 ? (
            <ListState kind="empty" title="まだ移行していません" description="" />
          ) : (
            <DataTable className={styles.table}>
              <colgroup>
                <col className={styles.colDate} />
                <col />
                <col className={styles.colRunState} />
                <col className={styles.colAction} />
              </colgroup>
              <thead>
                <TableHeadRow>
                  <Th className={`${styles.th} ${styles.thHistory}`}>日時</Th>
                  <Th className={`${styles.th} ${styles.thHistory}`}>移行元 → 移行先</Th>
                  <Th className={`${styles.th} ${styles.thHistory}`}>状態</Th>
                  <Th className={`${styles.th} ${styles.thHistory}`}><span className="sr-only">操作</span></Th>
                </TableHeadRow>
              </thead>
              <tbody>
                {m.runs.map((run) => {
                  const badge = historyBadge(run)
                  return (
                    <Tr key={run.id} className={`${styles.row} ${styles.rowRun}`} data-row-id={run.id}>
                      <Td className={styles.td}>{slashDateTime(run.createdAt)}</Td>
                      <Td className={styles.td}>
                        <button type="button" className={styles.runButton} aria-current={active?.id === run.id ? 'true' : undefined} title={`${run.purpose}・${formatNumber(run.counts.total)}件`}  onClick={() => m.selectRun(run.id)}>
                          {`${accountName(run.fromAccountId)} → ${accountName(run.toAccountId)}`}
                        </button>
                      </Td>
                      <Td className={styles.td}><StatusBadge size="compact" tone={badge.tone === 'ok' ? 'success' : badge.tone === 'danger' ? 'danger' : badge.tone === 'warn' ? 'warning' : 'neutral'}>{badge.label}</StatusBadge></Td>
                      <Td className={styles.td}>
                        {run.rollbackable === true ? (
                          <Button type="button" variant="text" size="inline" disabled={!m.canRunRollback || m.busy || m.detailBusy} lockedReason={m.ownerLockReason} onClick={() => { m.selectRun(run.id); m.setRollbackError(null); m.setRollbackConflicts([]); m.setConfirmRollback(true) }}>
                            <Undo2 size={16} aria-hidden="true" />
                            切り戻す
                          </Button>
                        ) : <EmptyCell />}
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </DataTable>
          )}
        </section>

        {active && registerOpen ? register : null}
      </>
    )
  }

  return (
    /* 要確認の判断は板を画面の高さまで伸ばし、キャンセルの帯を画面の下に追従させる。 */
    <PageFrame kind="list" boardId={active && !reviewing ? 'L48eY' : 'Z0jHp'} hasFooter={Boolean(active && reviewing)} heightMode={active && reviewing ? 'viewport' : undefined}>
      <FriendsSectionHead
        current="uid-migration"
        description="友だち情報と配信停止の状態を、新しいLINEアカウントへ引き継ぎます"
        action={(
          <Button type="button" variant="secondary" onClick={exportItems} disabled={!active?.items?.length} title="表示中の対応表をCSVにします">
            <Download size={16} aria-hidden="true" />
            表示中をCSVで書き出す
          </Button>
        )}
      />
      <div className={styles.body} data-template-region="body">{body}</div>
      {active && reviewing ? <PageFooter actions={<>
        <Button href="/friends">キャンセル</Button>
        <Button type="button" variant="primary"
          disabled={!m.canRunExecute || active.status !== 'ready' || m.busy || m.detailBusy}
          lockedReason={m.ownerLockReason}
          disabledReason={m.ownerLockReason ? undefined : executeBlockedReason ?? (active.status !== 'ready' ? '要確認をすべて決めると進めます' : undefined)}
          onClick={() => { m.setExecuteError(null); m.setConfirmExecute(true) }}>
          本移行へ進む
        </Button>
      </>} /> : null}

      <MigrationItemDialog detailItem={m.detailItem} active={active} canDecide={canDecideItems} lockedReason={m.managerLockReason} busy={m.busy || m.detailBusy} detailError={m.detailError} onClose={() => { m.setDetailItem(null); m.setDetailError(null) }} decide={(item, decision) => void m.decide(item, decision)} />
      <ExecuteConfirmDialog active={active} accounts={m.accounts} me={m.me} busy={m.busy || m.detailBusy} lockedReason={m.ownerLockReason} open={m.confirmExecute} error={m.executeError} canRun={m.canRunExecute} onConfirm={() => m.execute()} onCancel={() => { if (!m.busy) m.setConfirmExecute(false) }} />
      <RollbackConfirmDialog active={active} accounts={m.accounts} me={m.me} busy={m.busy || m.detailBusy} lockedReason={m.ownerLockReason} open={m.confirmRollback} error={m.rollbackError} conflicts={m.rollbackConflicts} canRun={m.canRunRollback} onConfirm={() => m.rollback()} onCancel={() => { if (!m.busy) { m.setConfirmRollback(false); m.setRollbackConflicts([]) } }} />
      <ConfirmDialog
        open={bulkOpen && bulkConfirmation.current.runId === active?.id}
        title="要確認をまとめて結び付けます"
        description={`このページの要確認・未判断で移行先のある ${formatNumber(bulkConfirmation.current.items.length)} 行を「結び付ける」にします。1行ずつ保存します。本移行まで実データは変わりません。`}
        confirmLabel="結び付ける"
        confirmDisabled={!canDecideItems || decisionsLocked || m.detailBusy}
        confirmLockedReason={m.managerLockReason}
        busy={m.busy}
        error={m.detailError || m.message || undefined} onSuccess={() => setBulkOpen(false)} onConfirm={() => runBulkLink()}
        onCancel={() => { if (!m.busy) setBulkOpen(false) }}
      />
    </PageFrame>
  )
}
