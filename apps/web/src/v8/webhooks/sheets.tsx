'use client'
import AccountRequiredState from '@/components/shared/account-required-state'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { SaveErrorField,SaveErrorScope } from '@/components/shared/save-form-errors'
import { DelayedSkeleton,Skeleton } from '@/components/shared/skeleton'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { DataTable,TableHeadRow,Td,Th,Tr } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import TextLink from '@/components/shared/text-link'
import { ListPage } from '@/components/templates'
import { LayoutTemplate,RefreshCw,Sheet } from 'lucide-react'
import { runKindLabel,runStatusLabel } from './sheets-runs'
import styles from './sheets.module.css'
import {
ViewerBand,
WEBHOOKS_DESCRIPTION,
WebhookTabs,
} from './shell'
import { useSheets } from './use-sheets'
import { shortDateTime } from './words'


export { groupRuns,syncResultProblem } from './sheets-runs'

export default function WebhooksSheetsV8() {
  const { saveErrors, selectedAccountId, selectedAccount, accounts, isOwner, overview, connection, canManage, oauthConfigured, status, actionError, saveNotice, disconnectNotice, runsError, runsLoading, busy, showTargetForm, setShowTargetForm, targetInput, setTargetInput, disconnectFor, setDisconnectFor, loadRuns, load, handleConnect, handleSaveTarget, handleSync, handleDisconnect, callbackNotice, connStatus, staleRunningRun, effectivelyRunning, groups, lastSyncText } = useSheets()
  /* ===== 左：書き出しのカード ===== */
  let mainCard
  if (connStatus === 'disconnected') {
    mainCard = (
      <>
        <p className={styles.cardNote}>まだ接続されていません。Googleアカウントで許可すると、書き出し先を設定できるようになります。</p>
        {canManage ? (
          <div className={styles.buttonRow}>
            <Button variant="primary" disabled={busy !== null || !oauthConfigured} onClick={() => void handleConnect()} busy={busy === 'connect'} busyLabel="Googleへ移動しています…">
              Googleアカウントを接続する
            </Button>
          </div>
        ) : (
          <p className={styles.cardNote}>接続の設定は、統括だけが変更できます。</p>
        )}
      </>
    )
  } else {
    mainCard = (
      <>
        <div className={styles.statusRow}>
          <span className={styles.statusLabel}>いまの状態</span>
          <span className={styles.spacer} aria-hidden="true" />
          <span className={styles.statusStrong}>
            {connStatus === 'connected' ? '接続しています' : connStatus === 'expired' ? '許可が切れています' : '出力先の設定中'}
          </span>
        </div>
        <div className={styles.statusRow}>
          <span className={styles.statusLabel}>接続しているGoogleアカウント</span>
          <span className={styles.spacer} aria-hidden="true" />
          <span className={styles.statusValue}>{connection?.googleAccountEmail ?? emptyValue('unknown')}</span>
        </div>
        <div className={styles.statusRow}>
          <span className={styles.statusLabel}>書き出し先</span>
          <span className={styles.spacer} aria-hidden="true" />
          {connection?.spreadsheetUrl ? (
            <TextLink external href={connection.spreadsheetUrl}   className={styles.statusValue}>
              {`${connection.spreadsheetTitle ?? connection.spreadsheetUrl}（シート：友だち・フォーム回答）`}
            </TextLink>
          ) : (
            <span className={styles.statusValue}>まだ決めていません</span>
          )}
        </div>
        <div className={styles.statusRow}>
          <span className={styles.statusLabel}>前回の同期</span>
          <span className={styles.spacer} aria-hidden="true" />
          <span className={styles.statusValue}>{lastSyncText}</span>
        </div>
        {connStatus === 'expired' ? (
          <Notice tone="warn">Googleとの許可が切れています。同期は止まっています。{canManage ? '「再接続する」から許可をやり直してください。' : null}</Notice>
        ) : null}
        {staleRunningRun ? (
          <Notice tone="warn">前の同期が途中で止まったまま残っています。「今すぐ同期」で残った記録を回収して、もう一度同期できます。</Notice>
        ) : null}
        {canManage ? (
          <div className={styles.buttonRow}>
            {connStatus === 'expired' ? (
              <Button variant="primary" disabled={busy !== null} onClick={() => void handleConnect()} busy={busy === 'connect'} busyLabel="Googleへ移動しています…">
                再接続する
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  disabled={busy !== null || effectivelyRunning || !connection?.spreadsheetId}
                  onClick={() => void handleSync()}
                  busy={busy === 'sync'}
                  busyLabel="同期しています…"
                >
                  <RefreshCw size={16} aria-hidden="true" />{effectivelyRunning ? '同期中' : '今すぐ同期'}
                </Button>
                <Button disabled={busy !== null} onClick={() => setShowTargetForm((current) => !current)}>
                  <Sheet size={16} aria-hidden="true" />{showTargetForm ? '閉じる' : connection?.spreadsheetId ? '出力先を変更' : '出力先を設定'}
                </Button>
              </>
            )}
            <span className={styles.spacer} aria-hidden="true" />
            <Button
              variant="danger-outline"
              disabled={busy !== null}
              onClick={() => selectedAccountId && setDisconnectFor({ id: selectedAccountId, label: selectedAccount?.name?.trim() || selectedAccountId })}
            >
              接続を解除する
            </Button>
          </div>
        ) : (
          <p className={styles.cardNote}>接続の設定は、統括だけが変更できます。</p>
        )}
        {showTargetForm && canManage && connStatus !== 'expired' ? (
          <form onSubmit={handleSaveTarget} className={styles.targetForm}>

            <p className={styles.cardNote}>
              共有設定で「{connection?.googleAccountEmail ?? '接続したGoogleアカウント'}」に編集権限を付けたシートを指定してください。指定したシート内に「友だち」「フォーム回答」のタブを自動で作ります。
            </p>
            <div className={styles.targetRow}>
              <SaveErrorField names={["targetInput","target_input"]}><Field label="スプレッドシートのURLまたはID" htmlFor="wh-sheets-target"><TextField id="wh-sheets-target" value={targetInput} onChange={(event) => setTargetInput(event.target.value)}  placeholder="https://docs.google.com/spreadsheets/d/…" required /></Field></SaveErrorField>
              <Button type="submit" variant="primary" disabled={busy !== null} busy={busy === 'target'} busyLabel="確認しています…">保存する</Button>
            </div>
          </form>
        ) : null}
      </>
    )
  }

  let body
  if (!selectedAccountId) {
    body = <AccountRequiredState hasAccounts={accounts.length > 0} />
  } else if (status === 'loading') {
    body = (
      <div aria-busy="true" aria-label="連携の状態を読み込んでいます">
        <DelayedSkeleton
          loading
          skeleton={(
            <Card spacing="integration" aria-hidden="true">
              <Skeleton className={styles.skeletonTitle} />
              {[0, 1, 2, 3].map((row) => <Skeleton key={row} className={styles.skeletonRow} />)}
            </Card>
          )}
        />
      </div>
    )
  } else if (status === 'error') {
    body = (
      <ListState
        kind="error"
        title="連携の状態を読み込めませんでした"
        description="連携の内容は変わっていません。上で選んでいるLINEアカウントが合っているか確かめてください。"
        onRetry={() => void load()}
      />
    )
  } else {
    body = (
      <>
        <Card spacing="integration" aria-labelledby="wh-sheets-export">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle} id="wh-sheets-export">Google Sheets への書き出し</h2>
            <p className={styles.cardNote}>友だち・フォーム回答をスプレッドシートへ書き出します</p>
          </div>
          {mainCard}
        </Card>
        {connStatus !== 'disconnected' ? (
          <Card spacing="integration" aria-labelledby="wh-sheets-runs">
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle} id="wh-sheets-runs">同期の記録</h2>
            </div>
            {runsError ? (
              <div className={styles.buttonRow}>
                <span className={styles.cardNote}>{runsError}表示中の記録は、最後に読み込めた時点のものです。</span>
                <Button onClick={() => selectedAccountId && void loadRuns(selectedAccountId)} busy={runsLoading} busyLabel="読み込んでいます…">記録を読み直す</Button>
              </div>
            ) : null}
            {groups.length === 0 && !runsError ? (
              <p className={styles.cardNote}>{runsLoading ? '読み込んでいます…' : 'まだ同期の記録がありません。'}</p>
            ) : null}
            {groups.length > 0 ? (
              <>
                <DataTable aria-label="同期の記録" columnSizing="content">
                  <thead>
                    <TableHeadRow>
                  <Th>日時</Th>
                  <Th>きっかけ</Th>
                  <Th grow>書き出したもの</Th>
                  <Th>結果</Th>
                </TableHeadRow>
                </thead>
                <tbody>
                {groups.map((group) => (
                  <Tr key={group.key}>
                    <Td>{shortDateTime(group.startedAt)}</Td>
                    <Td>{runKindLabel(group.kind)}</Td>
                    <Td grow title={group.parts.join('・')}><TruncatedText value={group.parts.join('・') || emptyValue('unknown')} /></Td>
                    <Td>
                      <StatusBadge tone={group.status === 'ok' ? 'success' : group.status === 'partial' ? 'warning' : group.status === 'error' ? 'danger' : 'neutral'}>{runStatusLabel(group.status)}</StatusBadge>
                    </Td>
                  </Tr>
                ))}
                </tbody>
                </DataTable>
              </>
            ) : null}
          </Card>
        ) : null}
      </>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      boardId="DxAAA"
      headingSize="regular"
      title="外部連携"
      help={WEBHOOKS_DESCRIPTION}
      actions={isOwner ? <Button href="/webhooks?tab=notify"><LayoutTemplate size={16} aria-hidden="true" />見本から作る</Button> : undefined}
      tabs={<WebhookTabs active="sheets" outgoingCount={overview.outgoingCount} incomingCount={overview.incomingCount} />}
      stats={<>
        {!isOwner ? <ViewerBand /> : null}
      </>}
      overlays={(
        <Dialog
          open={disconnectFor !== null}
          title="Google Sheets との接続を解除しますか？"
          description="書き出しが止まります。シートの中身は消えません。この操作は取り消せません。"
          descriptionBand="danger"
          tone="destructive"
          confirmation
          compact
          designNode="YZ57z"
          designWidth={500}
          designTop={280}
          designContentPadding="0 var(--polish-space-section) var(--polish-space-card)"
          busy={busy === 'disconnect'}
          confirmLabel="接続を解除する"
          onConfirm={() => handleDisconnect()}
          onCancel={() => { if (busy !== 'disconnect') setDisconnectFor(null) }}
        >
          <p>このLINEアカウントの連携設定・同期の記録・Google側の許可を消します。</p>
          <OperationTargetSummary accounts={[{ id: disconnectFor?.id ?? '', name: disconnectFor?.label === disconnectFor?.id ? undefined : disconnectFor?.label }]} />
        </Dialog>
      )}
    >
      <div className={styles.body}>
        <div className={styles.mainCol}>
          {callbackNotice ? <Notice tone={callbackNotice.tone}>{callbackNotice.text}</Notice> : null}
          {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
          {disconnectNotice ? <Notice tone="warn">{disconnectNotice}</Notice> : null}
          {saveNotice ? (
            <Notice tone="warn" action={<Button onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button>}>{saveNotice}</Notice>
          ) : null}
          {body}
        </div>
        <Card spacing="integration" className={styles.sideCard} aria-labelledby="wh-sheets-care">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle} id="wh-sheets-care">気をつけること</h2>
          </div>
          <p className={styles.careText}>
            ・Google 側でこのアプリの許可を取り消したときは、「再接続する」からやり直します<br />
            ・解除しても、書き出したスプレッドシートは消えません
          </p>
        </Card>
      </div>
    </ListPage></SaveErrorScope>
  )
}
