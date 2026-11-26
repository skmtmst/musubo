'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'

import { useGooglePermission } from './use-google-permission'
import { notifySaved } from '@/components/shared/toast'
import ListToolbar, { ListToolbarSort } from '@/components/shared/list-toolbar'
import PageSizeSelect from '@/components/shared/page-size-select'
import { isConflictResponse, SaveConflictBand } from '@/components/shared/save-conflict'
import { useListUrlValue } from '@/components/shared/list-url-state'
import KpiCard from '@/components/shared/kpi-card'
import { useCallback, useEffect, useState } from 'react'
import { Inbox, RefreshCw, Sparkles } from 'lucide-react'
import { ApiError } from '@/lib/api'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import Button from '@/components/shared/button'
import { GridTable, GridHeadRow, GridRow, GridCell, type GridTableDesign } from '@/components/shared/grid-table'
import { TextArea } from '@/components/shared/text-field'
import Checkbox from '@/components/shared/checkbox'
import IconButton from '@/components/shared/icon-button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import {
  restaurantGoogleApi,
  type GoogleConnectionData,
  type GoogleReview,
  type GoogleReviewFilter,
  type GoogleReviewListData,
  type GoogleReviewOrder,
} from '@/lib/restaurant-google-api'
import { StatRow } from '@/v8/restaurant/common-a/public/parts/index'
import { errorMessage, formatShortStamp, reviewReceivedAt } from './format'
import type { GoogleNav } from './navigation-types'
import styles from './google.module.css'
import { Stars, replyBadge } from './review-presentation'
export { Stars, replyBadge } from './review-presentation'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import TextLink from '@/components/shared/text-link'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 Googleビジネス 口コミ（一覧 ・返信を作る ・公開の確認 `xSudF`）。
 * 口（一覧・絞り込み・並び・同期・下書き作成・保存・公開）は今の画面と同じ。
 */

const STATE_OPTIONS: Array<{ value: GoogleReviewFilter; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'unreplied', label: '未返信' },
  { value: 'draft', label: '下書きあり' },
  { value: 'attention', label: '要確認' },
]

const ORDER_OPTIONS: Array<{ value: GoogleReviewOrder; label: string }> = [
  { value: 'newest', label: '新しい順' },
  { value: 'oldest', label: '古い順' },
  { value: 'rating_low', label: '評価が低い順' },
  { value: 'rating_high', label: '評価が高い順' },
]

const RATING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'すべて' },
  ...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `★${n}` })),
]

const REVIEW_TABLE_DESIGN: GridTableDesign = {
  columns: 'var(--tpl-rt-col-150) minmax(0, 1fr) var(--tpl-rt-col-130) var(--tpl-rt-col-130) var(--tpl-rt-col-130)',
  gap: 'var(--tpl-rt-col-gap)',
  rowPadding: 'var(--space-12) var(--tpl-list-inset)',
  headPadding: '0 var(--tpl-list-inset)',
  rowHeight: 'auto',
  fontSize: 'var(--text-caption)',
}

export function ReviewsBoard({ accountId, data, go, onSynced }: { accountId: string; data: GoogleConnectionData; go: GoogleNav; onSynced: () => void }) {
  const { allowed: canEdit, lockedReason } = useGooglePermission()
  const [filter, setFilter] = useListUrlValue<GoogleReviewFilter>('filter', 'all')
  const [rating, setRating] = useState('')
  const [order, setOrder] = useListUrlValue<GoogleReviewOrder>('order', 'newest')
  const [search, setSearch] = useListUrlValue('q', '')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useListUrlValue('page', 1)
  const [perPage, setPerPage] = useListUrlValue('perPage', 20)
  const [list, setList] = useState<GoogleReviewListData | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [syncedOnce, setSyncedOnce] = useState(false)
  const { connection } = data

  const load = useCallback(async () => {
    setListLoading(true)
    setListError('')
    try {
      const ratingNumber = Number.parseInt(rating, 10)
      setList(await restaurantGoogleApi.listReviews(accountId, { filter, order, q: appliedSearch || undefined, page, perPage, rating: Number.isInteger(ratingNumber) ? ratingNumber : undefined }))
    } catch (err) {
      setList(null)
      setListError(errorMessage(err, '口コミを読み込めませんでした。'))
    } finally {
      setListLoading(false)
    }
  }, [accountId, appliedSearch, filter, order, page, perPage, rating])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
     setAppliedSearch(search); setPage(1)
  }, [search])

  const sync = useCallback(async () => {
    if (!canEdit || syncing) return
    setSyncing(true)
    setSyncError('')
    try {
      await restaurantGoogleApi.syncReviews(accountId)
      onSynced()
      await load()
    } catch (err) {
      setSyncError(errorMessage(err, 'Googleから口コミを読み込めませんでした。前回取得した内容を表示しています。'))
    } finally {
      setSyncing(false)
    }
  }, [accountId, canEdit, load, onSynced, syncing])

  // 画面を開いたとき、最終同期が古ければ裏で1回だけ同期する（前回の一覧はそのまま見せる）。
  useEffect(() => {
    if (!canEdit || syncedOnce || connection.status !== 'connected' || !data.summary.syncStale) return
    setSyncedOnce(true)
    void sync()
  }, [canEdit, connection.status, data.summary.syncStale, sync, syncedOnce])

  const pageCount = list ? Math.max(1, Math.ceil(list.total / list.perPage)) : 1
  const average = connection.averageRating
  const reviewTotal = connection.totalReviewCount ?? data.summary.storedCount

  return (
    <>
      <StatRow>
        <KpiCard density="compact" title="未返信" valueText={`${data.summary.unrepliedCount}`} detail="返信を待っている口コミ" valueTone={data.summary.unrepliedCount > 0 ? 'warning' : 'default'} icon={<Inbox size={16} />} presentation="band" value={null} unit="" />
        <KpiCard density="compact" title="平均の評価" valueText={average === null || average === undefined ? '—' : `${Math.round(average * 10) / 10}`} detail={`総合・${polishFormatNumber(reviewTotal)}件`} icon={<Inbox size={16} />} presentation="band" value={null} unit="" />
        <KpiCard density="compact" title="要確認" valueText={`${data.summary.attentionCount}`} detail="評価2以下" icon={<Inbox size={16} />} presentation="band" value={null} unit="" />
        {/* Google経由の予約：結ぶ口がまだ無いので「—」（数を推測しない）。 */}
        <KpiCard density="compact" title="Google経由の予約" valueText="—" detail="この30日" help="予約の連携サービスと結ぶと数えます。いまは取れないので「—」です。" icon={<Inbox size={16} />} presentation="band" value={null} unit="" />
      </StatRow>
      <ListToolbar
        search={{ placeholder: '口コミを探す', label: '口コミを探す', value: search, onChange: setSearch }}
        filters={<>
          <Select label="評価" aria-label="評価で絞り込み" value={rating} onChange={(value) => { setRating(value); setPage(1) }} options={RATING_OPTIONS} />
          <Select label="状態" aria-label="状態で絞り込み" value={filter} onChange={(value) => { setFilter(value as GoogleReviewFilter); setPage(1) }} options={STATE_OPTIONS} />
        </>}
        trailing={<>
          <IconButton
            aria-label={syncing ? 'Googleから取得中…' : 'Googleから同期する'}
            onClick={() => void sync()}
            disabled={!canEdit || syncing || connection.status !== 'connected'} lockedReason={lockedReason}
            title={syncing ? '口コミを取得しています' : connection.status !== 'connected' ? 'Googleとの接続を確認してください' : undefined}
          >
            <RefreshCw aria-hidden className={`${styles.icon16} ${syncing ? styles.spin : ''}`} />
          </IconButton>
          <PageSizeSelect value={perPage} onChange={(next) => { setPerPage(next); setPage(1) }} />
          <ListToolbarSort aria-label="並び順" value={order} onChange={(value) => { setOrder(value as GoogleReviewOrder); setPage(1) }} options={ORDER_OPTIONS} />
        </>}
      />
      {connection.status === 'expired' ? <Notice tone="danger" action={<TextLink inline href="/settings/sns">SNS連携で再接続</TextLink>}>Googleとの接続を確認してください（認可切れ）。前回取得した口コミを表示しています。</Notice> : null}
      {connection.status === 'no_permission' ? <Notice tone="danger" action={<TextLink inline href="/settings/sns">SNS連携で接続を確認する</TextLink>}>この店舗を操作する権限がありません。</Notice> : null}
      {syncError ? <Notice tone="warn" action={<Button variant="text" disabled={!canEdit} lockedReason={lockedReason} onClick={() => sync()} busy={syncing} busyLabel="取得中…">もう一度</Button>}>{syncError}</Notice> : null}
      {syncing && (list?.total ?? 0) === 0 ? <Notice tone="info">口コミを取得中… すべてのページを取得してから表示します。</Notice> : null}
      {listLoading && !list ? <div className={styles.stateBox}><ListState kind="loading" title="口コミを読み込んでいます" /></div> : null}
      {listError ? <div className={styles.stateBox}><ListState kind="error" title="口コミを表示できませんでした" description={listError} onRetry={() => void load()} /></div> : null}
      {list && list.total === 0 && !listLoading ? (
        <div className={styles.stateBox}>
          <ListState
            kind="empty"
            title={filter === 'all' ? 'まだ口コミがありません' : 'その状態の口コミはありません'}
            description={filter === 'all' ? '同期しても0件のときは、Google側にまだ口コミがありません。評価を推測して表示することはしません。' : '絞り込みを変えると他の口コミを確認できます。'}
            emptyPreset="readonly"
          />
        </div>
      ) : null}
      {list && list.total > 0 ? (
        /* 絵 ：口コミの表は角丸の枠のカードに入る。列幅を固定して投稿者名・年付き日時で列がずれないようにする。 */
        <Card overflow="hidden">
          <GridTable label="口コミ一覧" framed={false} design={REVIEW_TABLE_DESIGN} data-design="google-reviews">
            <GridHeadRow>
              <GridCell role="columnheader">投稿者・評価</GridCell>
              <GridCell role="columnheader">口コミ</GridCell>
              <GridCell role="columnheader" align="right">受信</GridCell>
              <GridCell role="columnheader">状態</GridCell>
              <GridCell role="columnheader">操作</GridCell>
            </GridHeadRow>
            {list.reviews.map((review) => {
              const badge = replyBadge(review)
              const reviewerName = review.reviewerDisplayName ?? '匿名'
              const actionable = review.replyStatus === 'unreplied' || review.replyStatus === 'draft' || review.replyStatus === 'pending_confirm'
              return (
                <GridRow key={review.id} data-row-id={review.id}>
                  <GridCell stack>
                    <span className={styles.reviewer} title={reviewerName}>{reviewerName}</span>
                    <Stars rating={review.starRating} />
                  </GridCell>
                  <GridCell>
                    <span className={styles.comment} title={review.comment ?? undefined}>{review.comment ?? '（本文なし・評価のみ）'}</span>
                  </GridCell>
                  <GridCell align="right" className={styles.reviewDate}>{formatShortStamp(reviewReceivedAt(review))}</GridCell>
                  <GridCell><StatusBadge tone={badge.tone}>{badge.label}</StatusBadge></GridCell>
                  <GridCell data-list-action-cell="">
                    <Button disabled={actionable && !review.replyDraft && !canEdit} lockedReason={actionable && !review.replyDraft ? lockedReason : undefined} onClick={() => { if (canEdit || !actionable || review.replyDraft) go({ tab: 'reviews', view: 'draft', id: review.id }) }}>{actionable && !review.replyDraft ? '下書きを作る' : '返信を見る'}</Button>
                  </GridCell>
                </GridRow>
              )
            })}
          </GridTable>
        </Card>
      ) : null}
      {list && pageCount > 1 ? (
        <Pagination page={page} pageCount={pageCount} onPageChange={setPage} summary={`${polishFormatNumber(list.total)} 件・新着と未返信は別に管理`} />
      ) : null}
    </>
  )
}

/** 返信を作る＋公開の確認（xSudF）。 */
export function ReviewDraft({ accountId, reviewId, data, go, onPublished }: { accountId: string; reviewId: string; data: GoogleConnectionData; go: GoogleNav; onPublished: () => void }) {
  const { allowed: canEdit, lockedReason } = useGooglePermission()
  const saveErrors = useSaveFormErrors()

  const { allowed: canPublish, lockedReason: publishReason } = useGooglePermission('manager', data.permissions.canPublishReply)
  const [review, setReview] = useState<GoogleReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [text, setText] = useState('')
  const [aiGenerated, setAiGenerated] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'save' | 'publish' | null>(null)
  const [actionError, setActionError] = useState('')
  const [saved, setSaved] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [checked, setChecked] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [done, setDone] = useState<{ comment: string } | null>(null)
  // 未保存の下書きがあるまま一覧や他画面へ移ろうとしたら止める（今の画面と同じ）。
  const dirty = canEdit && review !== null && done === null && review.replyStatus !== 'published' && review.replyStatus !== 'replied' && text !== (review.replyDraft ?? '')
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: busy !== null })

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await restaurantGoogleApi.review(accountId, reviewId)
      setReview(response.review)
      setText(response.review.replyDraft ?? '')
      setAiGenerated(response.review.replyDraftAiGenerated)
      setConflict(null)
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setLoadError(errorMessage(err, '口コミを読み込めませんでした。')) }
    } finally {
      setLoading(false)
    }
  }, [accountId, reviewId, saveErrors])

  useEffect(() => { void load() }, [load])

  const generate = async () => {
    if (!canEdit) return
    setBusy('generate')
    setActionError('')
    setSaved('')
    try {
      const response = await restaurantGoogleApi.generateDraft(accountId, reviewId)
      setText(response.draft)
      setAiGenerated(true)
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setActionError(errorMessage(err, 'AIの下書き作成に失敗しました。もう一度お試しください。')) }
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!canEdit) return
    setBusy('save')
    setActionError('')
    try {
      const response = await restaurantGoogleApi.saveDraft(accountId, reviewId, text)
      setReview(response.review)
      setAiGenerated(false)
      notifySaved('下書きを保存しました。まだGoogleには送信していません。')
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setActionError(errorMessage(err, '下書きを保存できませんでした。')) }
    } finally {
      setBusy(null)
    }
  }

  const publish = async () => {
    if (!canEdit || !canPublish || !data.writeEnabled) return
    setBusy('publish')
    setActionError('')
    try {
      const response = await restaurantGoogleApi.publishReply(accountId, reviewId, text)
      setDone({ comment: response.reply.comment })
      setConfirming(false)
      onPublished()
    } catch (err) {
      const fieldFailure = saveErrors.capture(err);

      if (isConflictResponse(err) && err.code === 'already_replied') {
        const existing = (err.data as { existingReply?: string } | undefined)?.existingReply
        setConflict(existing ?? '（返信文を読み込めませんでした）')
        setConfirming(false)
      } else if (err instanceof ApiError && err.status === 502) {
        { if (!fieldFailure)
        setActionError('Googleへの送信結果を確認できませんでした。重複を防ぐため、次に開いたときGoogle側の状態を照合してから再送します。') }
        setConfirming(false)
        await load()
      } else {
        { if (!fieldFailure)
        setActionError(errorMessage(err, 'Googleへの返信に失敗しました。')) }
      }
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <SaveErrorScope errors={saveErrors}><div className={styles.stateBox}><ListState kind="loading" title="口コミを読み込んでいます" /></div></SaveErrorScope>
  if (loadError || !review) {
    return <SaveErrorScope errors={saveErrors}><ListState kind="error" title="口コミを表示できませんでした" description={loadError} onRetry={() => void load()} /></SaveErrorScope>
  }

  const reviewer = review.reviewerDisplayName ?? '匿名'
  const storeTitle = data.connection.locationTitle ?? data.store.name
  const alreadyReplied = review.replyStatus === 'published' || review.replyStatus === 'replied' || Boolean(done)
  const pendingConfirm = review.replyStatus === 'pending_confirm'
  const textLength = text.trim().length
  const canOpenConfirm = canEdit && canPublish && data.writeEnabled && textLength > 0 && textLength <= 4096 && !alreadyReplied && conflict === null && busy === null
  const sourceUrl = data.connection.locationMapsUrl
    ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(storeTitle)}`

  if (confirming && canEdit && canPublish && data.writeEnabled) {
    return (
      <SaveErrorScope errors={saveErrors}><div className={styles.split} data-design-node="xSudF">
        <div className={styles.mainColumn}>
          <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
            <SectionHeader size="small" title={<>この返信をGoogleに公開しますか？</>} />
            <OperationTargetSummary accounts={[{ id: accountId }]} store={data.store} />
            <dl className={styles.facts}>
              <div className={styles.factRow}><dt className={styles.factKey}>返信先の店舗</dt><dd className={styles.factValue}>{storeTitle}</dd></div>
              <div className={styles.factRow}><dt className={styles.factKey}>返信する口コミ</dt><dd className={styles.factValue}>{`${reviewer}（★${review.starRating}・${formatShortStamp(reviewReceivedAt(review))}）`}</dd></div>
              <div className={styles.factRow}><dt className={styles.factKey}>公開のタイミング</dt><dd className={styles.factValue}>送信後、Googleの処理を経て表示</dd></div>
            </dl>
            <p className={styles.preText}>{text}</p>
            <p className={styles.muted}>{`元の口コミ：${review.comment ?? '（本文なし・評価のみ）'}`}</p>
          </Card>
        </div>
        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" className={styles.sideColumn} aria-label="公開前の確認">
          <SectionHeader size="small" title="公開前の確認" />
          <SaveErrorField names={["checked"]}><Checkbox checked={checked} onCheckedChange={setChecked}>返信先・内容・個人情報の有無を確認しました</Checkbox></SaveErrorField>
          <p className={styles.checklist}>{'・予約内容や来店履歴などを追記していません\n・返信は店舗を代表して公開されます\n・通信結果が不明な場合はGoogle側を先に確認します'}</p>
          {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
          <Button onClick={() => setConfirming(false)} disabled={busy !== null} className={styles.fullButton}>修正する</Button>
          <Button variant="primary" onClick={() => void publish()} disabled={!checked || busy !== null} busy={busy === 'publish'} busyLabel="送信中…" className={styles.fullButton}>この内容で返信する</Button>
        </Card>
      </div></SaveErrorScope>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      {done ? <Notice tone="success">Googleに返信を送信しました。反映を確認できるまで「反映確認中」と表示します。</Notice> : null}
      {conflict !== null ? <SaveConflictBand title="別の担当者がすでに返信しています。" description={`表示されている返信：「${conflict}」。重ねて送信せず、最新の内容を読み込んで確認してください。`} onReload={() => void load()} /> : null}
      {pendingConfirm && !done ? <Notice tone="warn">{canEdit ? '前回の送信結果を確認できていません。「この内容で返信する」を押すと、先にGoogle側の状態を照合してから送信します。' : '前回の送信結果を確認できていません。オーナーか管理者にGoogle側の状態の確認を頼んでください。'}</Notice> : null}
      <div className={styles.split}>
        <div className={styles.mainColumn}>
          <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
            <SectionHeader size="small" title={<>返信する口コミ</>} />
            <p className={styles.reviewMeta}>
              <span className={styles.reviewMetaName}>{reviewer}</span>
              <Stars rating={review.starRating} small />
              <span className={styles.reviewMetaDate}>{formatShortStamp(reviewReceivedAt(review))}</span>
              <TextLink external href={sourceUrl}   className={styles.textLink}>Googleで原文を確認</TextLink>
            </p>
            <p className={styles.reviewText}>{review.comment ?? '（本文なし・評価のみ）'}</p>
            {alreadyReplied && (review.replyComment || done) ? (
              <p className={styles.repliedBox}>{`公開済みの返信：${done?.comment ?? review.replyComment}`}</p>
            ) : null}
          </Card>
          {!alreadyReplied ? (
            <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
              <SectionHeader size="small" title={<>{aiGenerated ? 'AIが作った返信の下書き' : '返信の下書き'}</>} />
              <SaveErrorField names={["text"]}><TextArea
                density="compact" height="reply"
                value={text}
                onChange={(event) => { setText(event.target.value); setSaved('') }}
                placeholder="返信文を入力するか、AIで下書きを作ります。"
                aria-label="返信文" readOnly={!canEdit}
                aria-invalid={textLength > 4096 || undefined}
              /></SaveErrorField>
              <div className={styles.draftTools}>
                {data.aiAvailable ? (
                  <Button onClick={() => void generate()} lockedReason={lockedReason} disabled={!canEdit || busy !== null} busy={busy === 'generate'} busyLabel="作成中…"><Sparkles aria-hidden className={styles.icon15} />AIで下書きを作る</Button>
                ) : <span className={styles.muted}>この環境ではAI下書きは使えません。</span>}
                <span className={styles.spacer} aria-hidden="true" />
                <span className={textLength > 4096 ? styles.countOver : styles.count}>{`${polishFormatNumber(textLength)} / 4,096`}</span>
              </div>
              {saved ? <p className={styles.saved} role="status">{saved}</p> : null}
            </Card>
          ) : (
            <Card appearance="outlined" layout="vertical" padding="default" gap="normal"><p className={styles.muted}>この口コミへの返信は公開済みです。</p></Card>
          )}
        </div>
        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" className={styles.sideColumn} aria-label="公開前の確認">
          <SectionHeader size="small" title="公開前の確認" />
          <p className={styles.checklist}>{'・返信先が合っている\n・お客さまの個人情報を書いていない\n・お店の約束（値引きなど）を書いていない'}</p>
          <p className={styles.grayNote}>
            {!data.writeEnabled
              ? '検証環境では Google へは送りません。下書きと承認まで。'
              : canPublish ? '確認してから Google へ公開します。' : 'Googleへの公開は店舗管理者以上が行います。下書きを保存しておくと、管理者が確認して公開できます。'}
          </p>
          {!alreadyReplied ? (
            <>
              <Button onClick={() => void save()} lockedReason={lockedReason} disabled={!canEdit || busy !== null || textLength === 0 || textLength > 4096} busy={busy === 'save'} className={styles.fullButton}>下書きを保存する</Button>
              {data.writeEnabled ? (
                <Button variant="primary" lockedReason={publishReason} onClick={() => { if (canOpenConfirm) { setChecked(false); setActionError(''); setConfirming(true) } }} disabled={!canOpenConfirm} className={styles.fullButton}>返信内容を確認する</Button>
              ) : (
                /* 送れない設定（検証環境・権限なし）のときは送信へ進むボタンを出さない。場所だけ空ける。 */
                <span className={styles.buttonSpace} aria-hidden="true" />
              )}
            </>
          ) : null}
        </Card>
      </div>
      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="返信文の変更"
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
      />
    </></SaveErrorScope>
  )
}
