'use client'

import { Download, FileSearch, Inbox } from 'lucide-react'
import { formatNumber } from '@/lib/format'
import { usePageTitle } from '@/components/shell/page-chrome'
import { PageFrame, PageContent } from '@/components/templates/page-frame'
import CsvTemplateDownload from '@/components/shared/csv-template-download'
import { FRIEND_IMPORT_HEADERS } from './friend-csv'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { DashboardColumns } from '@/components/templates/dashboard-page'
import Checkbox from '@/components/shared/checkbox'
import FileDropzone, { AttachmentRow } from '@/components/shared/file-drop'
import HelpTip from '@/components/shared/help-tip'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import ListState from '@/components/shared/list-state'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { FriendsSectionHead } from '../shared/head'
import { slashDateTime } from '../duplicates/words'
import { csvExportLine } from '../list/csv-export'
import { formatImportBytes, JOB_STATUS_LABELS, useFriendMigrations } from './use-friend-migrations'
import styles from './migrations.module.css'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { csvFileName } from '@/lib/csv-file-name'
import TruncatedText from '@/components/shared/truncated-text'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'

/*
 * ★V8 CSVで書き出す・取り込む（Pencil ）。/friends/migrations。
 *
 * 手順・API は今と同じ（書き出しを作る → 取り込みは「まず確認だけ」→ 内訳を見て反映）。
 * 見せ方：頭（← 友だちへ・タブ）→ 案内 → 書き出す／取り込むの2枚 → 確認の結果 → 履歴。
 * 確認の結果は、確認する前も場所と5つの区分を出しておく（数は「—」）。
 */

const COLUMN_CHOICES = [
  ['basic', '基本（LINEユーザーID・表示名・本名・登録日）', false],
  ['tags_fields', 'タグ・友だち情報（まだ書き出せません）', true],
  ['support', '対応状況・対応マーク・担当者（まだ書き出せません）', true],
] as const

function jobStatusLabel(status: string): string {
  return Object.prototype.hasOwnProperty.call(JOB_STATUS_LABELS, status) ? JOB_STATUS_LABELS[status] : '確認中'
}

export default function CsvMigrationsV8() {
  usePageTitle('友だち')
  const m = useFriendMigrations()
  const manageLockedReason = usePermissionLockReason(!m.manageLocked, 'manager')
  const reflectable = m.summary ? m.summary.add + m.summary.update : 0
  const blocked = m.summary ? m.summary.conflict + m.summary.error > 0 : true

  /* 頭の「表示中をCSVで書き出す」：いま出ている履歴の表を CSV にする（友だちの情報は含まない）。 */
  const exportHistory = () => {
    const header = ['日時', '種類', '対象', '件数', 'した人', '状態']
    const rows = m.jobs.map((job) => [
      slashDateTime(job.created_at),
      job.kind === 'export' ? '書き出し' : '取り込み',
      m.accounts.find((account) => account.id === job.line_account_id)?.name ?? '',
      String(job.row_count ?? job.total_count ?? ''),
      job.created_by_name,
      jobStatusLabel(job.status),
    ])
    const csv = [header, ...rows].map((row) => csvExportLine(row)).join('\n')
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("友だちの移行履歴")
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const body = m.status === 'loading' ? (
    <ListState kind="loading" title="書き出し・取り込みを読み込んでいます" />
  ) : m.status === 'forbidden' ? (
    <ListState kind="forbidden" title="書き出し・取り込みを見る権限がありません" description={permissionDeniedMessage('store')} />
  ) : m.status === 'error' ? (
    <ListState kind="error" title="書き出し・取り込みを表示できませんでした" description="履歴は消えていません。" onRetry={() => void m.load()} />
  ) : (
    <>
      <Notice tone="info" message="書き出しても友だちの情報は変わりません。取り込みは、まず確認だけをします（追加・更新・変更なし・競合・エラーの内訳）。" />

      {/* 書き出す・取り込むの2枚は同じ高さで、ボタンを同じ位置にそろえる（絵 T9gblG）。 */}
      <DashboardColumns layout="cards" cardHeight="equal">{[
        <Card key="export" layout="vertical" padding="default" gap="var(--polish-space-card)" aria-labelledby="csv-export-title">
          <CardHeader title="CSVで書き出す" titleId="csv-export-title" headingLevel={3} size="content" />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>アカウント</span>
            <SaveErrorField names={["accountId","m.accountId","account_id","m.account_id"]}><EntitySelect
              aria-label="書き出すLINEアカウント"
              size="full"
              value={m.accountId}
              onChange={m.setAccountId}
              options={[{ value: '', label: 'アカウントを選択' }, ...m.accounts.map((account) => ({ ...entityOptionMetadata(account), value: account.id, label: account.name }))]}
            /></SaveErrorField>
          </div>
          <fieldset className={styles.fieldset}>
            <legend className={styles.fieldLabel}>
              書き出す項目
              <HelpTip label="書き出す項目の説明">基本はLINEユーザーID・LINE表示名・本名・システム表示名・登録日の5列です。この5列はそのまま取り込めます。タグ・友だち情報、対応情報はまだ書き出せません。</HelpTip>
            </legend>
            {COLUMN_CHOICES.filter(([value]) => value !== 'support').map(([value, label, unavailable]) => (
              <SaveErrorField names={["value"]} key={value}><Checkbox key={value} checked={m.columns.includes(value)} onCheckedChange={() => m.toggleColumn(value)} disabled={unavailable}>
                {label}
              </Checkbox></SaveErrorField>
            ))}
          </fieldset>
          <p className={styles.small} title="Shift_JISの書き出しはまだ使えません">文字コード：UTF-8</p>
          <div className={styles.cardFoot}>
            {m.exportResult ? (
              <Button variant="text" size="inline" lockedReason={manageLockedReason} disabled={m.manageLocked || m.busy} busy={m.downloadId === m.exportResult.id} busyLabel="保存しています…" onClick={() => void m.downloadExport(m.exportResult!.id)}>
                {`CSVで書き出す（${m.exportResult.rowCount ?? emptyValue('unknown')}件）`}
              </Button>
            ) : null}
              <Button variant="primary" disabled={m.manageLocked || m.busy} lockedReason={manageLockedReason} busy={m.busy && !m.summary && !m.downloadId} onClick={() => void m.createExport()} title="件数が多いときは、できあがったらお知らせします。ダウンロードできる期間は7日です。">
                <Download size={16} aria-hidden="true" />
                書き出しを作る
              </Button>
          </div>
        </Card>,

        <Card key="import" layout="vertical" padding="default" gap="var(--polish-space-card)" aria-labelledby="csv-import-title">
          <CardHeader title="CSVから取り込む" titleId="csv-import-title" headingLevel={3} size="content" />
          <CsvTemplateDownload headers={FRIEND_IMPORT_HEADERS} name="友だち情報" />
          <FileDropzone
            className={styles.drop}
            variant="upload"
            disabled={m.manageLocked || m.busy}
            title="CSVを追加"
            hint={<>ドラッグ＆ドロップ<br />またはクリックしてファイルをアップロード<br />（1ファイル5メガバイト以内・UTF-8 の CSV）</>}
            accept=".csv,text/csv"
            onFiles={(files) => void m.onPickFile(files[0] ?? null)}
          />
          {m.file ? (
            <AttachmentRow name={m.file.name} meta={`${formatNumber(m.rows.length)} 行・${formatImportBytes(m.file.size)}`} onRemove={() => void m.onPickFile(null)} />
          ) : null}
          <p className={styles.small}>同じファイルをもう一度入れても、二重には反映しません。</p>
          <div className={styles.cardFoot}>
              <Button variant="primary" lockedReason={manageLockedReason} disabled={m.manageLocked || m.busy || !m.file} disabledReason={!m.manageLocked && !m.file ? 'CSVファイルを選ぶと確認できます。' : undefined} onClick={() => void m.previewImport()}>
                <FileSearch size={16} aria-hidden="true" />
                まず確認だけする
              </Button>
          </div>
        </Card>
      ]}</DashboardColumns>

      {m.message ? <p role="status" className={styles.message}>{m.message}</p> : null}

      <Card layout="vertical" padding="default" gap="var(--polish-space-card)" aria-labelledby="csv-result-title">
        <CardHeader size="content" headingLevel={3} titleId="csv-result-title"
          title={m.summary && m.file ? `確認の結果：${m.file.name}` : '確認の結果'}
          meta={m.summary ? 'まだ友だち情報は変えていません' : 'CSVを選んで「まず確認だけする」を押すと、ここに内訳が出ます'} />
        <KpiBand gridClassName="grid grid-cols-5">
          {([
            ['add', '追加', '人', ''],
            ['update', '更新', '人', ''],
            ['unchanged', '変更なし', '人', ''],
            ['conflict', '競合', '人', '同じIDで値が違う'],
            ['error', 'エラー', '行', '直して再確認'],
          ] as const).map(([key, title, unit, detail]) => {
            const value = m.summary ? m.summary[key] : null
            return (
              <KpiCard
                key={key}
                presentation="band"
                icon={<Inbox size={16} />}
                title={title}
                value={value}
                unit={value == null ? '' : unit}
                detail={detail || null}
              />
            )
          })}
        </KpiBand>
        <div className={styles.resultActions}>
          {m.summary && m.importId ? (
            <>
              <Button type="button" variant="secondary" onClick={m.cancelImport} disabled={m.busy}>取り込みをやめる</Button>
              <Button type="button" variant="primary" lockedReason={manageLockedReason} disabled={m.manageLocked || blocked || m.busy} busy={m.busy} busyLabel="反映中…" onClick={() => void m.executeImport()}>
                {`確認した内容を反映（${formatNumber(reflectable)} 人）`}
              </Button>
            </>
          ) : (
            <p className={styles.small}>{m.summary ? '競合・エラーのある行を直して、もう一度「まず確認だけする」からやり直してください。' : '反映は、確認の結果を見てからです。'}</p>
          )}
        </div>
      </Card>

      <Card layout="vertical" padding="default" gap="var(--polish-space-card)" aria-labelledby="csv-history-title">
        <CardHeader size="content" headingLevel={3} titleId="csv-history-title" title="書き出し・取り込みの履歴" help={<HelpTip label="状態の印の意味">反映ずみは反映が終わったもの、確認までは確認待ち、期限切れは確認の期限が過ぎたものです。</HelpTip>} />
        {m.jobs.length === 0 ? (
          <ListState kind="empty" title="履歴はまだありません" description="書き出しまたは取り込みを実行すると、ここに残ります。" />
        ) : (
          <DataTable columnSizing="controls" grid={{
            columns: 'var(--tpl-fr-mig-col-date) var(--tpl-fr-mig-col-kind) var(--tpl-fr-mig-col-kind) minmax(0, 1fr) var(--tpl-fr-mig-col-state)',
            padding: '0 var(--polish-space-card)',
            headPadding: 'var(--polish-space-field) var(--polish-space-card)',
            gap: 'var(--tpl-toolbar-gap)',
            rowHeight: 'var(--tpl-fr-mig-row-h)',
            headTextSize: 'var(--text-caption)',
            bodyTextSize: 'var(--text-caption)',
          }}>
            <thead>
              <TableHeadRow>
                <Th>日時</Th>
                <Th>種類</Th>
                <Th>件数</Th>
                <Th grow>した人</Th>
                <Th>状態</Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {m.jobs.map((job) => {
                const account = m.accounts.find((item) => item.id === job.line_account_id)?.name
                const count = job.row_count ?? job.total_count ?? null
                const downloadable = job.kind === 'export' && job.status === 'completed' && (!job.expires_at || job.expires_at > new Date().toISOString())
                return (
                  <Tr key={`${job.kind}-${job.id}`} className={styles.row}>
                    <Td>{slashDateTime(job.created_at)}</Td>
                    <Td><span title={account ? `対象：${account}` : undefined}>{job.kind === 'export' ? '書き出し' : '取り込み'}</span></Td>
                    <Td>{count == null ? emptyValue('unknown') : formatNumber(count)}</Td>
                    <Td grow><TruncatedText value={job.created_by_name ?? emptyValue('unknown')} /></Td>
                    <Td>
                      <span className={styles.stateCell}>
                        <StatusBadge tone={job.status === 'completed' ? 'success' : job.status === 'previewed' ? 'warning' : 'neutral'} size="compact">
                          {jobStatusLabel(job.status)}
                        </StatusBadge>
                        {downloadable ? (
                          <Button variant="text" size="inline" lockedReason={manageLockedReason} disabled={m.manageLocked || m.busy} busy={m.downloadId === job.id} busyLabel="保存しています…" onClick={() => void m.downloadExport(job.id)}>CSVで書き出す</Button>
                        ) : null}
                      </span>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  )

  return (
    <PageFrame kind="list" boardId="T9gblG">
      <FriendsSectionHead
        current="csv"
        description="友だち情報をCSVで書き出し、確かめてから取り込みます"
        action={(
          <Button type="button" variant="secondary" onClick={exportHistory} disabled={m.jobs.length === 0} title="下の「書き出し・取り込みの履歴」をCSVにします">
            <Download size={16} aria-hidden="true" />
            表示中をCSVで書き出す
          </Button>
        )}
      />
      {m.manageLocked ? <ReadOnlyNotice need="manager" /> : null}
      <PageContent>{body}</PageContent>
    </PageFrame>
  )
}
