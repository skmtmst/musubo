import { CircleCheck, LoaderCircle } from 'lucide-react'
import { ProgressBar } from '@/components/shared/progress'
import { type FollowerImportState, type LineAccountConnectData } from '@/lib/api'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { emptyValue } from '@/components/shared/empty-value'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import type { HandoverProgress } from './check-rows'
import styles from './register.module.css'

/** 登録完了と友だちの引き継ぎ。保存処理は親が持つ。 */
export default function Step5Completion({ connection, accountName, createdId, importRunning, importFriends, importState, handover, idleSeconds, requestError, onRefresh, refreshing = false }: {
  connection: Pick<LineAccountConnectData, 'displayName' | 'basicId' | 'followerImport' | 'remainingActions' | 'verification'>; accountName: string; createdId: string; importRunning: boolean; importFriends: boolean
  importState: FollowerImportState | null; handover: HandoverProgress; idleSeconds: number | null; requestError: boolean
  onRefresh?: () => void; refreshing?: boolean
}) {
  const updatedAtInvalid = Boolean(importState?.updatedAt) && idleSeconds === null
  const checking = Boolean(importState?.lastError) || requestError || updatedAtInvalid || (idleSeconds !== null && idleSeconds >= 60)
  const complete = importFriends && (importState?.phase ?? connection.followerImport.phase) === 'completed'
  const countsKnown = importState !== null
  const capability = importState?.capability ?? connection.followerImport.capability
  const showHandover = importFriends && (importRunning || (complete && countsKnown))
  const needsReview = handover.needsReview > 0 || (importState?.profileErrors ?? 0) > 0
  const resultLabel = complete
    ? requestError ? '引き継ぎの人数を確認できません' : '引き継ぎの人数を確認しています'
    : requestError || capability === 'unknown' ? '友だちの引き継ぎを確認できません'
    : capability === 'unavailable' ? '友だちの一括引き継ぎを利用できません'
    : '友だちの引き継ぎは未開始です'
  const resultNote = complete
    ? requestError ? '引き継ぎの処理は終了していますが、人数を読み取れませんでした。もう一度確認してください。' : '引き継ぎの処理は終了しています。人数は現在確認中です。'
    : requestError ? '最新の状態を読み取れませんでした。もう一度確認してください。'
    : capability === 'unavailable' ? 'このアカウントでは、いまの友だちを一括で引き継げません。'
    : capability === 'unknown' ? '一括で引き継げるかを、まだ確認できていません。'
    : '必要な場合は、登録したアカウントの詳細で引き継ぎを確認してください。'
  const total = handover.confirmed
  const processed = total === null ? handover.processed : Math.min(handover.processed, total)
  const remaining = total === null ? null : Math.max(0, total - processed)
  const percent = total === null ? null : total === 0 ? complete ? 100 : 0 : Math.round(processed / total * 100)
  const stageLabel = complete ? needsReview ? '引き継ぎの処理が終わりました（要確認）' : '友だちの引き継ぎが完了しました' : checking ? '進み具合を確認できません' : total === null ? '友だちを確認しています' : '友だちの情報を引き継いでいます'
  const countDetail = complete
    ? handover.needsReview > 0 ? `未反映${polishFormatNumber(handover.needsReview)}件` : ''
    : `残り${polishFormatNumber(remaining ?? 0)}人`
  const progressLabel = total === null ? '対象人数を確認中' : `${polishFormatNumber(processed)} / ${polishFormatNumber(total)}人 · ${percent}%${countDetail ? ` · ${countDetail}` : ''}`
  const referenceTotal = connection.verification?.followerTotal
  const completedMs = Date.parse(importState?.completedAt ?? importState?.updatedAt ?? '')
  const updateLabel = complete
    ? Number.isFinite(completedMs)
      ? `完了：${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(completedMs))}`
      : '完了時刻を確認できません'
    : importState?.updatedAt
      ? idleSeconds === null
        ? '最終更新を確認できません'
        : `最終更新：${idleSeconds < 60 ? `${idleSeconds}秒前` : `${Math.floor(idleSeconds / 60)}分前`}`
      : '最新の状態を確認中'
  return (
            <Card surface="standard" layout="vertical" contentPadding={showHandover ? 'var(--tpl-htn6-handover-card-pad)' : 'var(--tpl-htn-panel-pad)'} gap={showHandover ? 'var(--tpl-htn6-handover-card-gap)' : 'var(--tpl-htn-panel-gap)'} className={styles.panel} aria-label={showHandover ? '友だちの引き継ぎ' : '登録完了'} data-design-node="Plmq1">
              {showHandover ? <>
                <div className={styles.handoverHeading}>
                  <span className={styles.handoverIcon}>{complete ? <CircleCheck size={22} aria-hidden="true" /> : <LoaderCircle className={styles.handoverSpinner} size={22} aria-hidden="true" />}</span>
                  <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>{stageLabel}</h2>
                  <StatusBadge dot={false} tone={checking || (complete && needsReview) ? 'caution' : 'success'}>{complete ? needsReview ? '要確認' : '完了' : checking ? '要確認' : total === null ? '確認中' : '進行中'}</StatusBadge>
                </div>
                <p className={styles.progressNote}>LINEアカウントの登録は完了しました。{complete ? '引き継ぎ結果を確認できます。' : '画面を閉じても引き継ぎは続きます。ここでは最新の状態を確認できます。'}</p>
                <div className={styles.handoverBox}>
                  <div className={styles.handoverStages} aria-label="引き継ぎの段階">
                    {(['友だちを確認', '情報を反映', '完了を確認'] as const).map((label, index) => <div key={label} className={styles.handoverStage} data-state={index + 1 < handover.stage ? 'done' : index + 1 === handover.stage ? 'current' : 'waiting'}>
                      <span className={styles.handoverStageNumber}>{index + 1 < handover.stage ? '✓' : index + 1}</span><span>{label}</span>
                    </div>)}
                  </div>
                  <div className={styles.handoverMetrics}>
                    <div><span>引き継いだ友だち</span><strong>{countsKnown ? `${polishFormatNumber(processed)} 人` : '確認中'}</strong></div>
                    <div><span>現在の対象人数</span><strong>{total === null ? '確認中' : `${polishFormatNumber(total)} 人`}</strong></div>
                    <p>{complete ? `対象${polishFormatNumber(total ?? 0)}人を確認しました。` : total === null ? referenceTotal === null || referenceTotal === undefined ? 'LINEの現在の対象人数を確認しています。' : `LINEの参考値：${polishFormatNumber(referenceTotal)}人（前日の集計）` : referenceTotal === null || referenceTotal === undefined ? `現在の対象数は${polishFormatNumber(total)}人です。` : `前日集計は${polishFormatNumber(referenceTotal)}人でした。現在の対象数は${polishFormatNumber(total)}人です。`}</p>
                  </div>
                  {countsKnown && <p className={styles.progressNote}>{`内訳：新規${polishFormatNumber(handover.imported)}人、登録済み${polishFormatNumber(handover.alreadyPresent)}人、再登録${polishFormatNumber(handover.restored)}人。`}</p>}
                  <div className={styles.handoverProgressHead}><span>友だちの引き継ぎ進捗</span><strong aria-live="polite">{progressLabel}</strong></div>
                  <ProgressBar className={styles.handoverProgressBar} appearance="quota" max={total === 0 ? 1 : total ?? 1} value={total === 0 && complete ? 1 : processed} indeterminate={total === null} indeterminateVisual="empty" label="友だちの引き継ぎ進捗" />
                  <p className={styles.handoverCurrent} data-attention={checking || undefined} role="status" aria-live="polite">{complete ? `${polishFormatNumber(processed)}人の友だちを引き継ぎました` : checking ? idleSeconds !== null && idleSeconds >= 60 ? `${Math.floor(idleSeconds / 60)}分間、引き継ぎの状態が更新されていません` : '進み具合を確認できません。状態を再確認してください。' : total === null ? 'LINEから友だちの一覧を確認しています' : remaining === 0 ? 'サーバーの完了を確認しています' : `${polishFormatNumber(total)}人のうち${polishFormatNumber(processed)}人を引き継ぎました。残り${polishFormatNumber(remaining)}人を処理中です。`}</p>
                  <p className={styles.progressNote}>{complete ? '友だち一覧で確認できます。' : checking ? '状態を再確認できます。引き継ぎ中のデータは保持されます。' : total === null ? '人数が分かりしだい、引き継ぎの進み具合を表示します。' : '完了した人数に合わせてバーが伸びます。'}</p>
                  {handover.needsReview > 0 ? <Notice tone="warn" compact>{polishFormatNumber(handover.needsReview)}件は取り込めず、確認が必要です。</Notice> : null}
                  {importState && importState.profileErrors > 0 ? <Notice tone="warn" compact>一部のプロフィールを読み込めませんでした。友だち一覧で確認してください。</Notice> : null}
                  <div className={styles.handoverFooter}>
                    <p className={styles.progressNote}>{updateLabel}</p>
                    {complete && <div className={styles.buttonRow}>
                      <Button external href={`/accounts/detail?id=${encodeURIComponent(createdId)}`}>登録したアカウントを見る</Button>
                      <Button href="/friends">友だち一覧</Button>
                    </div>}
                  </div>
                </div>
              </> : <>
                <div className={styles.doneHero}>
                  <CircleCheck size={40} className={styles.doneIcon} aria-hidden="true" />
                  <h2 data-step-heading tabIndex={-1} className={styles.doneTitle}>LINEアカウントの登録が完了しました</h2>
                </div>
                <Card className={styles.accountBox} layout="vertical" surface="muted" corner="control" contentPadding="var(--tpl-htn-note-pad)" gap="var(--tpl-htn-gap-xs)">
                  <span className={styles.accountName}>{(connection.displayName ?? accountName) || 'LINEアカウント'}</span>
                  <span className={styles.accountId}>{connection.basicId || String(emptyValue('none'))}</span>
                </Card>
                {importFriends && (
                  <Card layout="vertical" surface="muted" corner="control" contentPadding="var(--tpl-htn-note-pad)" gap="var(--tpl-htn-gap-xs)">
                    <p className={styles.progressNote} role="status">{resultLabel}</p>
                    <p className={styles.progressNote}>{resultNote}</p>
                    {countsKnown && (handover.foundSoFar > 0 || handover.processed > 0) && <p className={styles.progressNote}>{`これまでに確認できた友だち：${polishFormatNumber(handover.foundSoFar)}人。処理済みの記録：${polishFormatNumber(handover.processed)}人（新規${polishFormatNumber(handover.imported)}人、登録済み${polishFormatNumber(handover.alreadyPresent)}人、再登録${polishFormatNumber(handover.restored)}人）。引き継ぎの完了を確認した実績ではありません。`}</p>}
                    {onRefresh && (!complete || requestError) && <Button type="button" onClick={onRefresh} disabled={refreshing} busy={refreshing} busyLabel="確認中…">状態を再確認</Button>}
                    {handover.needsReview > 0 ? <Notice tone="warn" compact>{polishFormatNumber(handover.needsReview)}件は取り込めず、確認が必要です。</Notice> : null}
                    {importState && importState.profileErrors > 0 ? <Notice tone="warn" compact>一部のプロフィールを読み込めませんでした。友だち一覧で確認してください。</Notice> : null}
                    {capability === 'unavailable' && <p className={styles.progressNote}>一括で引き継げない場合も、友だちが話しかけた順に登録されます。</p>}
                  </Card>
                )}
                {connection.remainingActions.length > 0 && (
                  <Card className={styles.noteBox} layout="vertical" surface="muted" corner="control" contentPadding="var(--tpl-htn-note-pad)" gap="var(--tpl-htn-gap-s)">
                    <p><strong>残りの手作業</strong></p>
                    <ul>{connection.remainingActions.map((item) => <li key={item}>{item}</li>)}</ul>
                  </Card>
                )}
              </>}
            </Card>
  )
}
