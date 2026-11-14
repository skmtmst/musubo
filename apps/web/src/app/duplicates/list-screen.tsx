'use client'
import TextLink from '@/components/shared/text-link'
import Link from '@/components/shared/list-navigation'
import { CircleAlert, Info, RotateCw, SearchX } from 'lucide-react'
import Button from '@/components/shared/button'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import Pagination from '@/components/shared/pagination'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { isForbidden, loadFailureCopy } from '@/components/shared/api-error-message'
import { FriendsManageNavV8 } from '@/app/friends'
import { formatNumber } from '@/lib/format'
import { CANDIDATE_PAGE_SIZE, formatRelative, useDuplicatesData } from '@/v8/friends/public/duplicates-use-duplicates-data/index'
import DuplicatesStatsNotice from '../../v8/duplicates/duplicates-stats-notice/index'
import { formatDateTime } from '@/lib/format'
import styles from '@/app/friends/friends-v8.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'


/*
 * ★V8 重複検出（Pencil 、タブを消した採用版は `sdbsQ` 板1、
 * 状態は 。再撮の板 （1152）を数の帯に付ける）。
 *
 * データの口は 管理画面 と同じ `use-duplicates-data`。違いは見せ方だけ——
 * タブの段を「← 友だち一覧 › データ管理 › 重複検出」と「データ管理 ▾」に
 * 替え、数の帯・道具の段・候補の表を板どおりに組む。
 * 管理画面 を直す必要が出たら page.tsx 側も同じ判断を入れる（V8 完成までの二重管理）。
 */

const CONFIDENCE_LABEL = { very_high: '最高', high: '高', medium: '中', low: '低' } as const

export default function DuplicatesV8() {
  usePageTitle('重複検出')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: '友だち', href: '/friends' }])
  const d = useDuplicatesData()

  const candidatePageCount = Math.max(1, Math.ceil(d.candidateTotal / CANDIDATE_PAGE_SIZE))
  const rangeStart = d.candidateTotal === 0 ? 0 : (d.page - 1) * CANDIDATE_PAGE_SIZE + 1
  const rangeEnd = Math.min(d.page * CANDIDATE_PAGE_SIZE, d.candidateTotal)
  const filtering = !d.unfilteredCandidates

  const kpiCandidateDetail =
    d.statusCounts !== null
      ? `未確認 ${formatNumber(d.statusCounts.pending ?? 0)}・保留 ${formatNumber(d.statusCounts.deferred ?? 0)}`
      : d.duplicateDetail

  return (
    <div className={styles.board} data-design-node="hn6Y8">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.headTitle}>重複検出</h2>
          <p className={styles.headDescription}>重複の可能性を検出します。自動統合はしません。</p>
        </div>
        <div className={styles.headAction}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void d.detect()}
            disabled={d.refreshing}
            busy={d.refreshing}
            busyLabel="再検出中…"
          >
            <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
            重複を再検出
          </Button>
        </div>
      </div>

      <FriendsManageNavV8 current="重複検出" />

      <Notice tone="info" icon={<Info size={16} aria-hidden="true" />}>
        <span>
          自動では結び付けません。確定済みID・連携UID・メール／電話の一致は強い根拠、
          プロフィール画像や名前だけの一致は候補として出します。確認後も元のLINE友だちデータは残ります。
        </span>
      </Notice>

      {/* 数の帯：4つのマス。取れない数は「—」と短い理由（SXCb3）。1152 は `G9C4Uw`。 */}
      <KpiBand data-design-node="G9C4Uw">
        <KpiCard presentation="band" icon={null} loading={d.loading} title="重複候補" value={null}
          valueText={d.duplicateTotalText.replace(/組$/u, '')} valueTextWithUnit unit="組" detail={d.loading && d.statusCounts === null ? '' : kpiCandidateDetail} />
        <KpiCard presentation="band" icon={null} loading={d.loading} title="確認済み" value={d.statusCounts !== null ? d.statusCounts.linked ?? 0 : null} unit="組"
          help="統合ユーザーに紐付け済みの組数です" helpDisplay="question"
          detail={d.statusCounts !== null ? '統合ユーザーに紐付け済みの組数です' : d.loading ? '' : '読み込めませんでした'} />
        <KpiCard presentation="band" icon={null} loading={d.loading} title="重複配信の削減" value={null} unit=""
          help="配信前プレビューの実績を接続したあと、重複分を除いた削減の見込みをここに表示します。" helpDisplay="question"
          detail="配信実績の接続を待っています" />
        <KpiCard presentation="band" icon={null} loading={d.loading} title="1配信あたりの無駄" value={null}
          valueText={d.data ? `¥${formatNumber(d.data.wastedPerBroadcastYen)}` : '—'} unit=""
          help="重複している友だち登録の数に1通あたりの単価を掛けた見積りです。実際に送った配信の実績ではありません。" helpDisplay="question"
          detail={d.data ? `¥${formatNumber(d.data.msgUnitYen)}/通の見積り` : d.loading ? '' : '読み込めませんでした'} />
      </KpiBand>

      {/* 集計だけ落ちたときは候補一覧を残し、失敗はこの1行で伝える（R598）。 */}
      {!d.data || isForbidden(d.statsFailure) ? (
        <DuplicatesStatsNotice failure={d.statsFailure} onRetry={() => void d.load()} />
      ) : d.error ? (
        <Notice tone="warn" role="status" action={<Button type="button" onClick={() => void d.load()}>もう一度</Button>}>
          再計算できませんでした。表示中の数字は前回の集計です。
        </Notice>
      ) : null}

      {/* 道具の段：検索・状態・右に件数と再検出の補足。 */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <SearchField
            className="w-full"
            aria-label="名前・メール・電話で探す"
            value={d.query}
            onChange={d.setQuery}
            onClear={() => d.setQuery('')}
            placeholder="名前・メール・電話で探す"
          />
        </div>
        <div className={styles.selectWrap}>
          <SaveErrorField names={["status","d.status"]}><Select
            aria-label="状態で絞り込む"
            label="状態"
            size="full"
            value={d.status}
            onChange={d.setStatus}
            options={[
              { value: '', label: 'すべて' },
              { value: 'pending', label: '未確認' },
              { value: 'linked', label: '確認済み' },
              { value: 'deferred', label: '保留' },
              { value: 'different', label: '別人' },
            ]}
          /></SaveErrorField>
        </div>
        <span className={styles.toolbarSpacer} />
        {d.data?.computedAt ? (
          <span className={styles.toolbarCount}>{formatRelative(d.data.computedAt)}に見直した</span>
        ) : null}
        <span className={styles.toolbarCount}>
          {d.candidatesLoading && d.candidateTotal === 0 ? '更新中…' : `${formatNumber(d.candidateTotal)}組`}
        </span>
      </div>

      {/* 候補の表。状態は SXCb3：骨格・0件・失敗をこの場所で出す。 */}
      <div className={styles.tableWrap} aria-busy={d.candidatesLoading}>
        <table className={styles.table}>
          <thead>
            <tr className={styles.headRow}>
              <th>候補</th>
              <th>確からしさ</th>
              <th>一致した根拠</th>
              <th>アカウント</th>
              <th>最終更新</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {d.candidateError ? (
              <tr>
                <td colSpan={6}>
                  <div className={styles.stateCard} style={{ border: 0 }}>
                    <span className={`${styles.stateIcon} ${styles.stateIconError}`}>
                      <CircleAlert size={20} aria-hidden="true" />
                    </span>
                    <p className={styles.stateTitle}>{isForbidden(d.candidateFailure) ? loadFailureCopy(d.candidateFailure, '重複の候補').title : '重複の候補を読み込めませんでした'}</p>
                    <Button type="button" variant="primary" onClick={() => void (d.data ? d.loadCandidates() : d.load())} busyLabel="処理中…">
                      もう一度試す
                    </Button>
                  </div>
                </td>
              </tr>
            ) : d.candidatesLoading && d.candidates.length === 0 ? (
              Array.from({ length: 5 }, (_, index) => (
                <tr key={index} aria-hidden="true">
                  <td><span className={styles.skeletonDot} style={{ display: 'inline-block' }} /></td>
                  <td colSpan={5}><span className={styles.skeletonBar} style={{ display: 'block' }} /></td>
                </tr>
              ))
            ) : d.candidates.length ? d.candidates.map((candidate) => (
              <tr key={candidate.id}>
                <td>
                  <span className={styles.pairCell}>
                    <span className={styles.avatarDot} aria-hidden="true">
                      {candidate.left.label.slice(0, 1)}
                    </span>
                    <Link href={`/friends/identity-candidates?id=${encodeURIComponent(candidate.id)}`}>
                      {candidate.left.label}
                    </Link>
                    <span aria-hidden="true">↔</span>
                    <span className={styles.avatarDot} aria-hidden="true">
                      {candidate.right.label.slice(0, 1)}
                    </span>
                    <Link href={`/friends/identity-candidates?id=${encodeURIComponent(candidate.id)}`}>
                      {candidate.right.label}
                    </Link>
                  </span>
                </td>
                <td>
                  <span className={`${styles.pill} ${candidate.confidence.label === 'very_high' || candidate.confidence.label === 'high' ? styles.pillStrong : candidate.confidence.label === 'medium' ? styles.pillWeak : styles.pillWarn}`}>
                    {CONFIDENCE_LABEL[candidate.confidence.label] ?? candidate.confidence.label}
                  </span>
                </td>
                <td>
                  <span className={styles.evidenceChips}>
                    {candidate.evidenceSummary.length
                      ? candidate.evidenceSummary.map((evidence) => (
                          <span key={evidence} className={styles.evidenceChip}>{evidence}</span>
                        ))
                      : <span className={styles.evidenceChip}>根拠を確認</span>}
                    {candidate.confidence.label === 'low' ? (
                      <span className={`${styles.evidenceChip} ${styles.evidenceChipWarn}`}>根拠不足</span>
                    ) : null}
                  </span>
                </td>
                <td>
                  {[candidate.left.lineAccountName, candidate.right.lineAccountName]
                    .filter(Boolean)
                    .join(' ／ ') || emptyValue('unknown')}
                </td>
                <td>{formatDateTime(candidate.reviewedAt ?? candidate.detectedAt)}</td>
                <td>
                  <TextLink inline href={`/friends/identity-candidates?id=${encodeURIComponent(candidate.id)}`}>
                    根拠を確認 →
                  </TextLink>
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan={6}>
                  <div className={styles.stateCard} style={{ border: 0 }}>
                    <span className={styles.stateIcon}>
                      <SearchX size={20} aria-hidden="true" />
                    </span>
                    <p className={styles.stateTitle}>
                      {filtering ? '条件に合う候補はありません' : '重複の候補はありません'}
                    </p>
                    {filtering ? (
                      <>
                        <p className={styles.stateDesc}>
                          「未確認」「保留」「結び付けた」「別人」や検索を外すと、すべて出ます
                        </p>
                        <Button type="button" variant="secondary" onClick={d.clearFilters}>
                          × 条件を外す
                        </Button>
                      </>
                    ) : (
                      <>
                        <p className={styles.stateDesc}>同じ人が別の友だちとして登録されていそうなときに、ここに出ます。</p>
                        <Button type="button" variant="secondary" onClick={() => d.loadCandidates()} busyLabel="処理中…">
                          もう一度見直す
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {d.candidateTotal > CANDIDATE_PAGE_SIZE ? (
        <div className={styles.pagerRow}>
          <span className={styles.toolbarCount}>
            {formatNumber(d.candidateTotal)}組中 {formatNumber(rangeStart)}〜{formatNumber(rangeEnd)}組
          </span>
          <Pagination
            page={d.page}
            pageCount={candidatePageCount}
            onPageChange={d.setPage}
            disabled={d.candidatesLoading}
            ariaLabel="重複候補のページ"
          />
        </div>
      ) : null}

      {/* 集計が無いときは内訳とマトリックスを出さない（母数が無いため。R598）。 */}
      {d.data ? (
        <div className={styles.duoCards}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>アカウントごとの重なり</h3>
            <p className={styles.sectionDesc}>どのアカウントに重複が偏っているか</p>
            {d.data.perAccount.length === 0 ? (
              <p className={styles.sectionDesc}>アカウントが登録されていません。</p>
            ) : (
              <table className={styles.table} style={{ minWidth: 0 }}>
                <thead>
                  <tr className={styles.headRow}>
                    <th>アカウント</th>
                    <th className="num">友だち</th>
                    <th className="num">うち重複</th>
                    <th className="num">重複の割合</th>
                  </tr>
                </thead>
                <tbody>
                  {d.data.perAccount.map((row) => (
                    <tr key={row.accountId}>
                      <td title={row.accountName}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-ink)', fontWeight: 600 }}>
                          {row.accountName}
                        </span>
                      </td>
                      <td className="num">{formatNumber(row.friends)}</td>
                      <td className="num">{formatNumber(row.dups)}</td>
                      <td className="num" style={{ color: 'var(--color-accent-deep)', fontWeight: 700 }}>
                        {(row.dupRate * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {d.data.perAccount.length >= 2 && d.data.pairwiseOverlap ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>アカウント間 重複マトリクス</h3>
              <p className={styles.sectionDesc}>同じ人が両方にいる数</p>
              <table className={styles.table} style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th className={styles.headCell}>行 ＼ 列</th>
                    {d.data.perAccount.map((col) => (
                      <th key={col.accountId} className={`${styles.headCell} num`} title={col.accountName}>
                        {col.accountName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.data.perAccount.map((row) => (
                    <tr key={row.accountId}>
                      <td title={row.accountName}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-ink)', fontWeight: 600 }}>
                          {row.accountName}
                        </span>
                      </td>
                      {d.data!.perAccount.map((col) => {
                        if (row.accountId === col.accountId) {
                          return <td key={col.accountId} className="num" style={{ color: 'var(--color-ink-disabled)' }}>{emptyValue('unknown')}</td>
                        }
                        const pair = d.data!.pairwiseOverlap!.find(
                          (p) => p.fromAccountId === row.accountId && p.toAccountId === col.accountId,
                        )
                        return <td key={col.accountId} className="num">{formatNumber(pair?.overlap ?? 0)}</td>
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
