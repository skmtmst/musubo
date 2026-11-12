'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'

import { lockMenuItems } from '@/components/shared/permission-lock'
import { useGooglePermission } from './use-google-permission'

import { statusBadge } from './post-status'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  form_title: requiredText("タイトルを入力してください。"),
  form_start: requiredText("期間のはじめの日時を入力してください。"),
  form_end: requiredText("期間のおわりの日時を入力してください。"),
  form_summary: requiredText("本文を入力してください。"),
}


import { useListUrlValue } from '@/components/shared/list-url-state'
import { ListToolbarEnd, ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'
import PageSizeSelect from '@/components/shared/page-size-select'
import LastChecked from '@/components/shared/last-checked'
import { usePostStatusCheck } from './use-post-status-check'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw, Send } from 'lucide-react'
import type { InstagramConnectionStatus, MediaItem } from '@line-crm/shared'
import { api, ApiError, type MediaUploadSession } from '@/lib/api'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { RowMenu } from '@/components/shared/row-actions'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import Select from '@/components/shared/select'
import Chip from '@/components/shared/chip'
import { Field } from '@/components/shared/form-controls'
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import { TextArea, TextField } from '@/components/shared/text-field'
import DateTimeField from '@/components/shared/date-time-field'
import Toggle from '@/components/shared/toggle'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import {
  restaurantGoogleApi,
  type GoogleConnectionData,
  type GooglePost,
  type GooglePostCtaType,
  type GooglePostDraftInput,
  type GooglePostFilter,
  type GooglePostKind,
  type GooglePostListData,
} from '@/lib/restaurant-google-api'
import { errorMessage, formatShortDay, formatShortStamp } from './format'
import type { GoogleNav } from './navigation-types'
import styles from './google.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { formatNumber } from '@/lib/format'
import { PostImageCrop, type CropSource, type CropTarget } from './post-image-crop'
import { PostMediaPickerDialog } from './post-media-picker-dialog'

/*
 * ★V8 Googleビジネス 投稿（一覧 ・投稿を作る ）と公開前の確認。
 * 口（一覧・状態の確認・下書きの保存・取消・削除・公開）は今の画面と同じ。
 * 端末からの画像のアップロードは、入口の page.tsx が渡す道具（mediaUpload）で行う
 * （src/v8 から @/app を読まないため）。渡されないときは登録メディアから選ぶだけ。
 */

/** 端末からのアップロードの道具（今の画面の app/contents/media-direct-upload を入口が渡す）。 */
export interface MediaUploadHelpers {
  accept: string
  validate: (file: File) => string
  extractMetadata: (file: File) => Promise<{ width?: number; height?: number; durationMs?: number; pageCount?: number; codec?: string }>
  put: (session: MediaUploadSession, file: File, onProgress: (progress: number) => void) => Promise<string>
}

export const KIND_LABELS: Record<GooglePostKind, string> = { standard: '最新情報', event: 'イベント', offer: '特典', alert: 'お知らせ' }
const FILTER_OPTIONS: Array<{ value: GooglePostFilter; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'scheduled', label: '予約' },
  { value: 'draft', label: '下書き' },
  { value: 'published', label: '公開済み' },
  { value: 'attention', label: '要確認' },
]
const CTA_LABELS: Record<GooglePostCtaType, string> = { book: '予約', order: '注文', shop: '購入', learn_more: '詳細', sign_up: '申し込み', call: '電話' }


/** 種類の札は全部同じ chip（種類＝灰）。 */
function KindChip({ kind }: { kind: GooglePostKind }) {
  return <Chip>{KIND_LABELS[kind]}</Chip>
}

function postWhen(post: GooglePost): string {
  if (post.status === 'published' && post.publishedAt) return `${formatShortDay(post.publishedAt)} 公開`
  if (post.status === 'draft') return '未送信'
  return formatShortStamp(post.updatedAt)
}

/*
 * Instagram 同時投稿の札（★V8-B `HEEN9`／2026-10-07 承認）。
 * 絵のことばは3つだけなので、送る前（出す設定だがまだ結果が無い）は札を出さない。
 * `post.instagram` が `null` のとき＝この口が同時投稿に未対応。札も操作も出さない。
 */
function instagramBadge(post: GooglePost): { label: string; tone: StatusBadgeTone; title?: string } | null {
  const ig = post.instagram
  if (!ig) return null
  if (!ig.enabled) return { label: 'Instagram なし', tone: 'neutral' }
  if (ig.status === 'published') return { label: 'Instagram 済み', tone: 'success' }
  if (ig.status === 'failed') return { label: 'Instagram 失敗・もう一度送る', tone: 'danger', title: ig.error ?? undefined }
  return null
}

/** 確認画面の「Instagram」の行（★V8-B `U1X7T2` の決めごとをことばにしたもの）。 */
function instagramFact(ig: NonNullable<GooglePost['instagram']>): string {
  if (!ig.enabled) return '出しません'
  if (ig.status === 'published') return '出しました'
  if (ig.status === 'failed') return '出せませんでした（再送できます）'
  return ig.caption ? 'Google と同時に出します（Instagram 用の文章あり）' : 'Google と同時に出します（本文をそのまま使います）'
}

export function PostsBoard({ accountId, go, store, googleLocation, connection, onConnectionReloaded }: { accountId: string; go: GoogleNav; store?: { id: string; name?: string | null }; googleLocation?: string | null; connection?: { id?: string; confirmationRevision?: number }; onConnectionReloaded?: (data: GoogleConnectionData) => void }) {
  const scope = useRef({ id: accountId, generation: 0 })
  if (scope.current.id !== accountId) scope.current = { id: accountId, generation: scope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [filter, setFilter] = useListUrlValue<GooglePostFilter>('filter', 'all')
  const [kind, setKind] = useState<'all' | GooglePostKind>('all')
  const [page, setPage] = useListUrlValue('page', 1)
  const [perPage, setPerPage] = useListUrlValue('perPage', 20)
  const [data, setData] = useState<GooglePostListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<GooglePost | null>(null)
  const removeTicket = useRef<object | null>(null)
  const renderedRemoveTicket = removeTicket.current
  const [removeScope, setRemoveScope] = useState<{ id: string; generation: number; store?: { id: string; name?: string | null }; googleLocation?: string | null; connectionId?: string; connectionRevision?: number } | null>(null)

  const [actionError, setActionError] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const { allowed: canPublish, lockedReason: publishReason, canView } = useGooglePermission('manager', data?.permissions?.canPublish ?? false)
  const canPublishRef = useRef(canPublish)
  canPublishRef.current = canPublish

  useEffect(() => { if (!canView) setMenuFor(null) }, [canView])

  const load = useCallback(async () => {
    const requestScope = scope.current.generation
    setLoading(true)
    setLoadError('')
    try {
      const result = await restaurantGoogleApi.posts(accountId, { filter, kind, page, perPage })
      if (!alive.current || requestScope !== scope.current.generation) return
      setData(result)
      loadedScope.current = requestScope
    } catch (err) {
      if (!alive.current || requestScope !== scope.current.generation) return
      setData(null)
      setLoadError(errorMessage(err, '投稿を読み込めませんでした。'))
    } finally {
      if (alive.current && requestScope === scope.current.generation) setLoading(false)
    }
  }, [accountId, filter, kind, page, perPage])

  useEffect(() => { void load() }, [load])

  const { sync, syncing, syncError, lastChecked, canSync, lockedReason } = usePostStatusCheck(accountId, load)

  const cancelDraft = async (post: GooglePost) => {
    if (!canSync || busyId) return
    setBusyId(post.id)
    setActionError('')
    try {
      await restaurantGoogleApi.cancelPost(accountId, post.id)
      await load()
    } catch (err) {
      setActionError(errorMessage(err, '取り消せませんでした。'))
    } finally {
      setBusyId(null)
    }
  }

  const removePost = async () => {
    if (!canPublish || busyId || !confirmRemove) return
    const requestScope = scope.current
    const requestTicket = removeTicket.current
    setBusyId(confirmRemove.id)
    setActionError('')
    try {
      if (!Number.isSafeInteger(confirmRemove.confirmationRevision) || !Number.isSafeInteger(removeScope?.connectionRevision) || !removeScope?.connectionId) throw new Error('確認した版がありません')
      await restaurantGoogleApi.removePost(accountId, confirmRemove.id, { expectedPostRevision: confirmRemove.confirmationRevision!, expectedConnectionRevision: removeScope.connectionRevision!, expectedConnectionId: removeScope.connectionId })
      if (!alive.current || requestScope !== scope.current || requestTicket !== removeTicket.current) return false
      removeTicket.current = null

      setConfirmRemove(null)
      await load()
      return true
    } catch (err) {
      if (!alive.current || requestScope !== scope.current || requestTicket !== removeTicket.current) return false
      setActionError(errorMessage(err, '削除できませんでした。'))
      if (err instanceof ApiError && err.status === 409) {
        const generation = scope.current.generation
        try {
          const [latestPosts, latestConnection] = await Promise.all([
            restaurantGoogleApi.posts(accountId, { filter, kind, page, perPage }),
            restaurantGoogleApi.connection(accountId),
          ])
          if (!alive.current || generation !== scope.current.generation) return false
          const latest = latestConnection.connection?.id && Number.isSafeInteger(latestConnection.connection.confirmationRevision)
            ? latestPosts.posts.find(item => item.id === confirmRemove.id && item.status === 'published') : undefined
          onConnectionReloaded?.(latestConnection)
          setData(latestPosts)
          setConfirmRemove(latest ?? null)
          setRemoveScope(previous => previous && latest ? { ...previous, googleLocation: latestConnection.connection?.locationTitle,
            connectionId: latestConnection.connection?.id, connectionRevision: latestConnection.connection?.confirmationRevision } : null)
        } catch { if (alive.current && generation === scope.current.generation) setConfirmRemove(null) }
      }
      return false
    } finally {
      setBusyId(null)
    }
  }

  /** Instagram だけをもう一度送る。Google の公開はそのまま残る（★V8-B `HEEN9`）。 */
  const retryInstagram = async (post: GooglePost) => {
    if (!canPublish || busyId) return
    setBusyId(post.id)
    setActionError('')
    try {
      await restaurantGoogleApi.retryInstagram(accountId, post.id)
      await load()
    } catch (err) {
      setActionError(errorMessage(err, 'Instagram へ送れませんでした。'))
    } finally {
      setBusyId(null)
    }
  }

  const menuItems = (post: GooglePost): ActionMenuItem[] => {
    const actionable = post.status === 'draft' || post.status === 'rejected' || post.status === 'failed'
    const items: ActionMenuItem[] = [
      { id: 'open', label: '中身を見る', onSelect: () => { if (canView) go({ tab: 'posts', view: 'edit', id: post.id }) } },
    ]
    if (actionable) items.push({ id: 'edit', label: '編集', disabled: !canSync, onSelect: () => { if (canSync) go({ tab: 'posts', view: 'edit', id: post.id }) } })
    if (post.status === 'published' && post.searchUrl) items.push({ id: 'google', label: 'Googleで表示', group: 'view', external: true, href: post.searchUrl ?? '' })
    if (post.status === 'draft') items.push({ id: 'cancel', label: '取り消す', disabled: busyId === post.id, onSelect: () => void cancelDraft(post) })
    if (post.instagram?.status === 'failed') items.push({ id: 'ig-retry', label: 'Instagram へ再送', lockedReason: publishReason, disabled: !canPublish || busyId === post.id, onSelect: () => void retryInstagram(post) })
    if (post.status === 'published') items.push({ id: 'remove', label: 'Google から削除', tone: 'danger', dividerBefore: true, lockedReason: publishReason, disabled: !canPublish || busyId === post.id, onSelect: () => { if (canPublishRef.current && loadedScope.current === scope.current.generation) { removeTicket.current = {}; setActionError(''); setRemoveScope({ id: accountId, generation: scope.current.generation, store, googleLocation, connectionId: connection?.id, connectionRevision: connection?.confirmationRevision }); setConfirmRemove(post) } } })

    if (!canView) return items.map(item => ({ ...item, disabled: true, lockedReason: undefined }))
    return lockMenuItems(canSync, items, 'feature', item => item.id === 'open' || item.id === 'google')
  }

  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1

  return (
    <>
      <ListToolbarFrame>
        <ListToolbarRow>
          <Select label="状態" aria-label="状態で絞り込み" value={filter} onChange={(value) => { setFilter(value as GooglePostFilter); setPage(1) }} options={FILTER_OPTIONS.map((option) => ({ ...option, disabled: option.value === 'scheduled' && (data?.counts.scheduled ?? 0) === 0 }))} />
          <Select label="種類" aria-label="種類で絞り込み" value={kind} onChange={(value) => { setKind(value as typeof kind); setPage(1) }} options={[{ value: 'all', label: 'すべて' }, ...(['standard', 'event', 'offer'] as GooglePostKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))]} />
          <ListToolbarEnd>
            <Button key={accountId} onClick={() => void sync()} disabled={!canSync || syncing} lockedReason={lockedReason} busy={syncing} busyLabel="確認中…"><RefreshCw aria-hidden className={styles.icon16} />Googleの状態を確認する</Button>
            <Button variant="primary" disabled={!canSync} lockedReason={lockedReason} onClick={() => { if (canSync) go({ tab: 'posts', view: 'new', kind: 'standard' }) }}><Plus aria-hidden className={styles.icon16} />投稿を作る</Button>
            <PageSizeSelect value={perPage} onChange={(next) => { setPerPage(next); setPage(1) }} />
          </ListToolbarEnd>
        </ListToolbarRow>
      </ListToolbarFrame>
      <LastChecked at={lastChecked} inSession busy={syncing} />
      {syncError ? <Notice tone="warn">{syncError}</Notice> : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      {loading && !data ? <div className={styles.stateBox}><ListState kind="loading" title="投稿を読み込んでいます" /></div> : null}
      {loadError ? <div className={styles.stateBox}><ListState kind="error" title="投稿を表示できませんでした" description={loadError} onRetry={() => void load()} /></div> : null}
      {data ? (
        <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
          <SectionHeader size="small" title={<>{`投稿 ${formatNumber(data.total)} 件`}</>} />
          {data.total === 0 && !loading ? (
            <ListState kind="empty" title={filter === 'all' ? 'まだ投稿がありません' : 'その状態の投稿はありません'} description="「投稿を作る」から最新情報・イベント・特典を作れます。" emptyPreset="readonly" />
          ) : (
            <div className={styles.postList}>
              {data.posts.map((post) => {
                const badge = statusBadge(post)
                const igBadge = instagramBadge(post)
                const name = post.title ?? post.summary
                return (
                  <div key={post.id} className={styles.postRow}>
                    <KindChip kind={post.kind} />
                    <span className={styles.postTitle} ><TruncatedText value={String(name ?? '')} /></span>
                    {post.origin === 'google' ? <span className={styles.postMeta}>Googleで作成</span> : null}
                    <span className={styles.postMeta}>{postWhen(post)}</span>
                    <Chip tone={badge.tone === 'success' ? 'ok' : badge.tone === 'warning' ? 'warn' : badge.tone === 'danger' ? 'danger' : badge.tone === 'info' ? 'info' : 'neutral'}>{badge.label}</Chip>
                    {igBadge ? <span title={igBadge.title}><Chip tone={igBadge.tone === 'success' ? 'ok' : igBadge.tone === 'danger' ? 'danger' : 'neutral'}>{igBadge.label}</Chip></span> : null}
                    <span className={styles.menuBox}>
                      <RowMenu label={`投稿「${name}」の操作`} items={menuItems(post)} triggerProps={{ disabled: !canView }} open={canView && menuFor === post.id} onOpenChange={(next) => { if (canView || !next) setMenuFor(next ? post.id : null) }} />
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {data.total > 0 && pageCount > 1 ? (
            <Pagination page={page} pageCount={pageCount} onPageChange={setPage} summary={`${formatNumber(data.total)} 件・時刻はすべて日本時間（Asia/Tokyo）`} />
          ) : null}
        </Card>
      ) : null}
      <ConfirmDialog
        confirmDisabled={!canPublish}
        confirmLockedReason={publishReason}
        open={confirmRemove !== null && removeScope?.generation === scope.current.generation}
        title="この投稿をGoogleから削除しますか？"
        deleteName={confirmRemove?.title || confirmRemove?.summary || 'この投稿'}
        description="削除すると元に戻せません。もう一度公開するには、新しく投稿を作り直してください。"
        confirmLabel="削除する"
        destructive
        busy={busyId === confirmRemove?.id}
        error={actionError || undefined} onSuccess={() => { removeTicket.current = null; setConfirmRemove(null) }} onConfirm={() => { if (renderedRemoveTicket && renderedRemoveTicket === removeTicket.current && alive.current && canPublishRef.current && removeScope?.generation === scope.current.generation) return removePost() }}
        onCancel={() => { removeTicket.current = null; setConfirmRemove(null) }}
      >{removeScope ? <OperationTargetSummary accounts={[{ id: removeScope.id }]} store={removeScope.store} externalTarget={{ label: 'Googleの店舗', name: removeScope.googleLocation }} /> : null}</ConfirmDialog>
    </>
  )
}

interface PostForm {
  kind: GooglePostKind
  summary: string
  title: string
  start: string
  end: string
  ctaType: GooglePostCtaType | ''
  ctaUrl: string
  couponCode: string
  redeemOnlineUrl: string
  termsConditions: string
  mediaId: string | null
  mediaFilename: string | null
  mediaSourceUrl: string | null
  mediaOriginalId: string | null
  igMediaId: string | null
  igMediaFilename: string | null
  igMediaSourceUrl: string | null
  igOriginalId: string | null
  /** Instagram にも出すか（★V8-B `U1X7T2`／2026-10-07 承認。新しい投稿は既定でオン）。 */
  igEnabled: boolean
  /** Instagram 用の文章。空なら本文をそのまま使う。 */
  igCaption: string
}

function emptyForm(kind: GooglePostKind): PostForm {
  return { kind, summary: '', title: '', start: '', end: '', ctaType: '', ctaUrl: '', couponCode: '', redeemOnlineUrl: '', termsConditions: '', mediaId: null, mediaFilename: null, mediaSourceUrl: null, mediaOriginalId: null, igMediaId: null, igMediaFilename: null, igMediaSourceUrl: null, igOriginalId: null, igEnabled: true, igCaption: '' }
}

function formFromPost(post: GooglePost): PostForm {
  const join = (date?: string, time?: string) => (date ? `${date}T${time || '00:00'}` : '')
  return {
    kind: post.kind === 'alert' ? 'standard' : post.kind,
    summary: post.summary,
    title: post.title ?? '',
    start: join(post.schedule?.startDate, post.schedule?.startTime),
    end: join(post.schedule?.endDate, post.schedule?.endTime),
    ctaType: post.cta?.type ?? '',
    ctaUrl: post.cta?.url ?? '',
    couponCode: post.offer?.couponCode ?? '',
    redeemOnlineUrl: post.offer?.redeemOnlineUrl ?? '',
    termsConditions: post.offer?.termsConditions ?? '',
    mediaId: post.media[0]?.mediaId ?? null,
    mediaFilename: post.media[0]?.filename ?? null,
    mediaSourceUrl: post.media[0]?.sourceUrl ?? null,
    mediaOriginalId: post.media[0]?.originalMediaId ?? null,
    igMediaId: post.instagram?.mediaId ?? null,
    igMediaFilename: null,
    igMediaSourceUrl: null,
    igOriginalId: post.instagram?.originalMediaId ?? null,
    igEnabled: post.instagram?.enabled ?? false,
    igCaption: post.instagram?.caption ?? '',
  }
}

/**
 * 送る形は今の画面と同じ（日時は「日付」と「時刻」に分けて送る）。
 * `igAvailable` が false（Instagram をつないでいない）ときは、画面に区画が出ないので必ず「出さない」で送る。
 */
function draftInputFrom(form: PostForm, igAvailable: boolean): GooglePostDraftInput {
  const [startDate = '', startTime = ''] = form.start.split('T')
  const [endDate = '', endTime = ''] = form.end.split('T')
  return {
    kind: form.kind,
    summary: form.summary.trim(),
    title: form.kind === 'standard' ? null : form.title.trim() || null,
    schedule: form.kind === 'standard' ? null : { startDate, startTime, endDate, endTime },
    cta: form.kind !== 'offer' && form.ctaType ? { type: form.ctaType, url: form.ctaType === 'call' ? null : form.ctaUrl.trim() || null } : null,
    offer: form.kind === 'offer' ? { couponCode: form.couponCode.trim() || null, redeemOnlineUrl: form.redeemOnlineUrl.trim() || null, termsConditions: form.termsConditions.trim() || null } : null,
    mediaId: form.mediaId,
    mediaOriginalId: form.mediaOriginalId,
    instagram: igAvailable ? { enabled: form.igEnabled, caption: form.igCaption.trim() || null, mediaId: form.igMediaId, originalMediaId: form.igOriginalId } : { enabled: false, caption: null, mediaId: null, originalMediaId: null },
  }
}

function PostImagePanel({ target, filename, url, editable, busy, lockedReason, onFile, onMediaPick, onAdjust, onUseGoogle }: {
  target: CropTarget
  filename: string | null
  url: string | null
  editable: boolean
  busy: boolean
  lockedReason?: string
  onFile: (file: File) => void
  onMediaPick: () => void
  onAdjust: () => void
  onUseGoogle?: () => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const isGoogle = target === 'google'
  return <div className={styles.platformImagePanel}>
    <div className={styles.platformImageHead}><strong>{isGoogle ? 'Google ビジネス用の画像' : 'Instagram 用の画像'}</strong><span className={isGoogle ? styles.optionalLabel : styles.requiredLabel}>{isGoogle ? '任意' : '必須'}</span><span className={styles.platformImageRatio}>{isGoogle ? '4:3' : '4:5'} の投稿画像</span></div>
    <div className={styles.platformImageContent}>
      {url ? <><div className={`${styles.platformThumb} ${isGoogle ? styles.platformThumbGoogle : styles.platformThumbInstagram}`}><img src={url} alt={`${isGoogle ? 'Google' : 'Instagram'}用の投稿画像`} /></div><div className={styles.platformImageInfo}><strong>{filename}</strong><span>{isGoogle ? 'Google 表示範囲 4:3' : 'Instagram 表示範囲 4:5'}</span><b>切り取り位置を確認済み</b></div></> : <div className={styles.platformImageEmpty}><p>画像を選んで、投稿前に切り取り位置を確認</p>{editable ? <div className={styles.platformImageActions}><Button lockedReason={lockedReason} onClick={() => fileInput.current?.click()} disabled={busy}>画像を選ぶ</Button><Button lockedReason={lockedReason} onClick={onMediaPick} disabled={busy}>登録メディアから選ぶ</Button>{onUseGoogle ? <Button lockedReason={lockedReason} variant="text" onClick={onUseGoogle} disabled={busy}>Google画像を使う</Button> : null}</div> : null}</div>}
    </div>
    {url && editable ? <div className={styles.platformImageLinks}><Button variant="text" lockedReason={lockedReason} onClick={() => fileInput.current?.click()} disabled={busy}>画像を変更</Button><Button variant="text" lockedReason={lockedReason} onClick={onAdjust} disabled={busy}>切り取りを調整</Button>{onUseGoogle ? <Button variant="text" lockedReason={lockedReason} onClick={onUseGoogle} disabled={busy}>Google画像を使う</Button> : null}</div> : null}
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = '' }} />
    {!url ? <p className={styles.platformImageHelp}>{isGoogle ? '画像がなくてもGoogleへの投稿は作成できます。' : 'Google画像を使うことも、別の画像を選ぶこともできます。'}</p> : null}
  </div>
}

/** 投稿を作る・直す。 */
export function PostEditor({ accountId, kind: kindFromUrl, postId, go, mediaUpload, adjustTarget }: { accountId: string; kind: GooglePostKind; postId: string | null; go: GoogleNav; mediaUpload?: MediaUploadHelpers; adjustTarget?: CropTarget }) {
  const saveErrors = useSaveFormErrors()
  const { allowed: canEdit, lockedReason } = useGooglePermission()
  const openedAdjust = useRef(false)

  const [form, setForm] = useState<PostForm>(emptyForm(kindFromUrl))
  const [initial, setInitial] = useState<PostForm>(emptyForm(kindFromUrl))
  const [loading, setLoading] = useState(Boolean(postId))
  const [loadError, setLoadError] = useState('')
  const [draftEditable, setEditable] = useState(true)
  const editable = draftEditable && canEdit
  const [picker, setPicker] = useState<CropTarget | null>(null)
  const [crop, setCrop] = useState<{ target: CropTarget; source: CropSource; preserveOriginal: boolean } | null>(null)
  const [cropSources, setCropSources] = useState<Partial<Record<CropTarget, CropSource>>>({})
  const [busy, setBusy] = useState<'save' | 'confirm' | null>(null)
  const [actionError, setActionError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof PostForm, string>>>({})
  const [upload, setUpload] = useState<{ busy: boolean; progress: number; error: string }>({ busy: false, progress: 0, error: '' })
  const [igState, setIgState] = useState<InstagramConnectionStatus['state'] | null>(null)

  /* Instagram をつないでいるときだけ同時投稿の区画を出す（「出す＝使える」）。 */
  useEffect(() => {
    let alive = true
    api.instagram.connection(accountId)
      .then((response) => { if (alive) setIgState(response.success ? response.data.state : 'unconfigured') })
      .catch(() => { if (alive) setIgState('unconfigured') })
    return () => { alive = false }
  }, [accountId])
  const igAvailable = igState === 'connected'

  useEffect(() => {
    if (!postId) { setForm(emptyForm(kindFromUrl)); setInitial(emptyForm(kindFromUrl)); setLoading(false); return }
    let alive = true
    setLoading(true)
    restaurantGoogleApi.post(accountId, postId)
      .then(async (response) => {
        if (!alive) return
        const next = formFromPost(response.post)
        if (next.igMediaId) {
          if (next.igMediaId === next.mediaId) {
            next.igMediaFilename = next.mediaFilename
            next.igMediaSourceUrl = next.mediaSourceUrl
          } else {
            const media = await api.media.detail(next.igMediaId, accountId)
            if (media.success) {
              next.igMediaFilename = media.data.item.filename
              next.igMediaSourceUrl = media.data.item.url
            }
          }
        }
        if (!alive) return
        setForm(next)
        setInitial(next)
        setEditable(response.post.status === 'draft')
      })
      .catch((err) => { if (alive) setLoadError(errorMessage(err, '投稿を読み込めませんでした。')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [accountId, postId, kindFromUrl])

  const dirty = canEdit && JSON.stringify(form) !== JSON.stringify(initial)
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: busy !== null })

  const selectRegisteredMedia = async (item: MediaItem) => {
    if (!editable || !picker) return
    const blob = await api.media.readContent(item.id, accountId)
    setCrop({ target: picker, source: { file: new File([blob], item.filename, { type: blob.type || item.mimeType || 'image/jpeg' }), name: item.filename, mediaId: item.id }, preserveOriginal: false })
    setPicker(null)
  }

  const uploadMedia = async (file: File): Promise<MediaItem> => {
    if (!canEdit) throw new Error(lockedReason ?? '画像を変更できません。')
    if (!mediaUpload) throw new Error('画像のアップロードを利用できません。')
    const problem = mediaUpload.validate(file)
    if (problem) throw new Error(problem)
    const metadata = await mediaUpload.extractMetadata(file)
    const prepared = await api.media.prepareUploads({ accountId, files: [{ filename: file.name, mimeType: file.type, sizeBytes: file.size, metadata }] })
    if (!prepared.success) throw new ApiError(500, prepared.error)
    const session = prepared.data.sessions[0]
    if (!session) throw new Error('送信の準備結果を確認できませんでした。')
    const etag = await mediaUpload.put(session, file, (progress) => setUpload((current) => ({ ...current, progress })))
    const completion = await api.media.completeUpload(session.id, { accountId, etag })
    if (!completion.success || !completion.data.mediaId) throw new Error('画像の登録を完了できませんでした。')
    const detail = await api.media.detail(completion.data.mediaId, accountId)
    if (!detail.success) throw new ApiError(500, detail.error)
    return detail.data.item
  }

  const chooseFile = (target: CropTarget, file: File) => {
    if (!editable) return
    if (!mediaUpload) { setUpload({ busy: false, progress: 0, error: '画像のアップロードを利用できません。' }); return }
    const problem = mediaUpload.validate(file)
    if (problem) { setUpload({ busy: false, progress: 0, error: problem }); return }
    setCrop({ target, source: { file, name: file.name }, preserveOriginal: true })
  }

  const openCropFromMedia = useCallback(async (target: CropTarget, mediaId: string, name: string) => {
    if (!editable) return
    setUpload({ busy: true, progress: 0, error: '' })
    try {
      const blob = await api.media.readContent(mediaId, accountId)
      setCrop({ target, source: { file: new File([blob], name, { type: blob.type || 'image/jpeg' }), name, mediaId }, preserveOriginal: false })
    } catch (err) {
      setUpload({ busy: false, progress: 0, error: errorMessage(err, '画像を読み込めませんでした。') })
      return
    }
    setUpload({ busy: false, progress: 0, error: '' })
  }, [accountId, editable])

  useEffect(() => {
    if (editable && !loading && postId && adjustTarget && !openedAdjust.current) {
      openedAdjust.current = true
      const mediaId = adjustTarget === 'google' ? (form.mediaOriginalId ?? form.mediaId) : (form.igOriginalId ?? form.igMediaId)
      const name = adjustTarget === 'google' ? form.mediaFilename : form.igMediaFilename
      if (mediaId) void openCropFromMedia(adjustTarget, mediaId, name ?? '画像.jpg')
    }
  }, [loading, postId, adjustTarget, form.mediaOriginalId, form.mediaId, form.igOriginalId, form.igMediaId, form.mediaFilename, form.igMediaFilename, openCropFromMedia, editable])

  const adjustCrop = (target: CropTarget) => {
    if (!editable) return
    const source = cropSources[target]
    if (source) { setCrop({ target, source, preserveOriginal: false }); return }
    const mediaId = target === 'google' ? (form.mediaOriginalId ?? form.mediaId) : (form.igOriginalId ?? form.igMediaId)
    const name = target === 'google' ? form.mediaFilename : form.igMediaFilename
    if (mediaId) void openCropFromMedia(target, mediaId, name ?? '画像.jpg')
  }

  const useGoogleImage = () => {
    if (!editable) return
    const source = cropSources.google
    if (source) { setCrop({ target: 'instagram', source, preserveOriginal: false }); return }
    if (form.mediaId) void openCropFromMedia('instagram', form.mediaOriginalId ?? form.mediaId, form.mediaFilename ?? 'Google画像.jpg')
  }

  const confirmCrop = async (file: File) => {
    if (!editable) return
    if (!crop) return
    setUpload({ busy: true, progress: 0, error: '' })
    try {
      let originalMediaId = crop.source.mediaId ?? null
      if (crop.preserveOriginal && crop.source.file) {
        const original = await uploadMedia(crop.source.file)
        originalMediaId = original.id
        setCrop((current) => current ? { ...current, source: { ...current.source, mediaId: original.id }, preserveOriginal: false } : current)
      }
      const item = await uploadMedia(file)
      const patch = crop.target === 'google'
        ? { mediaId: item.id, mediaFilename: crop.source.name, mediaSourceUrl: item.url, mediaOriginalId: originalMediaId }
        : { igMediaId: item.id, igMediaFilename: crop.source.name, igMediaSourceUrl: item.url, igOriginalId: originalMediaId }
      set(patch)
      setCropSources((current) => ({ ...current, [crop.target]: { ...crop.source, mediaId: originalMediaId ?? undefined } }))
      setCrop(null)
      setPicker(null)
      setUpload({ busy: false, progress: 100, error: '' })
    } catch (err) {
      saveErrors.capture(err)
      setUpload({ busy: false, progress: 0, error: errorMessage(err, '画像を保存できませんでした。') })
      throw err
    }
  }

  const validate = () => {
    const errors: Partial<Record<keyof PostForm, string>> = {}
    if ((FIELD_REQUIREMENTS.form_summary.check(form.summary) !== null)) errors.summary = '本文を入力してください。'
    else if (form.summary.length > 1500) errors.summary = '本文は1,500文字までです。'
    if (form.kind !== 'standard') {
      if ((FIELD_REQUIREMENTS.form_title.check(form.title) !== null)) errors.title = `${form.kind === 'event' ? 'イベントタイトル' : '特典タイトル'}を入力してください。`
      if ((FIELD_REQUIREMENTS.form_start.check(form.start) !== null)) errors.start = '期間のはじめの日時を入力してください。'
      if ((FIELD_REQUIREMENTS.form_end.check(form.end) !== null)) errors.end = '期間のおわりの日時を入力してください。'
      else if (form.start && form.end < form.start) errors.end = '期間のおわりは、はじめより後にしてください。'
    }
    setFieldErrors(errors)
    const first = (['title', 'start', 'end', 'summary'] as const).find((key) => errors[key])
    if (first) {
      const field = document.getElementById(`gb-post-${first}`)
      field?.focus()
      field?.scrollIntoView({ block: 'center' })
      return false
    }
    // Instagram にも投稿するときの決まり（★V8-B `U1X7T2`、2026-10-07 利用者承認）。
    // 画像は欄ではなく「選ぶ」操作なので、欄の下ではなく帯で知らせる。
    if (igAvailable && form.igEnabled) {
      if (!form.igMediaId) {
        setActionError('Instagram にも投稿するときは、画像を1枚選んでください。')
        return false
      }
      if (form.igCaption.length > 2200) {
        setActionError('Instagram 用の文章は2,200文字までです。')
        return false
      }
    }
    return true
  }

  const save = async (): Promise<string | null> => {
    if (!editable || busy !== null) return null
    setActionError('')
    if (upload.busy || !validate()) return null
    setBusy('save')
    setActionError('')
    try {
      const input = draftInputFrom(form, igAvailable)
      const response = postId ? await restaurantGoogleApi.savePost(accountId, postId, input) : await restaurantGoogleApi.createPost(accountId, input)
      setInitial(form)
      return response.post.id
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setActionError(errorMessage(err, '下書きを保存できませんでした。')) }
      return null
    } finally {
      setBusy(null)
    }
  }

  const saveDraft = async () => {
    const id = await save()
    if (id && !postId) go({ tab: 'posts', view: 'edit', id })
  }

  const openConfirm = async () => {
    if (!editable || busy !== null) return
    const id = await save()
    setBusy(null)
    if (id) go({ tab: 'posts', view: 'confirm', id })
  }

  if (loading) return <SaveErrorScope errors={saveErrors}><div className={styles.stateBox}><ListState kind="loading" title="投稿を読み込んでいます" /></div></SaveErrorScope>
  if (loadError) return <SaveErrorScope errors={saveErrors}><ListState kind="error" title="投稿を表示できませんでした" description={loadError} /></SaveErrorScope>

  const withPeriod = form.kind !== 'standard'
  const set = (patch: Partial<PostForm>) => {
    setForm((current) => ({ ...current, ...patch }))
    setFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in patch))))
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
      {!draftEditable ? <Notice tone="warn">この投稿はもう編集できません（送信済み、または送信手続き中です）。</Notice> : null}
      <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
        <SectionHeader size="small" title={<>{postId ? '投稿を直す' : '投稿を作る'}</>} />
        <Field density="compact" label="種類">
          <SaveErrorField names={["kind","form.kind"]}><Select
            aria-label="投稿の種類"
            size="full"
            value={form.kind}
            disabled={Boolean(postId) || !editable}
            onChange={(value) => go({ tab: 'posts', view: 'new', kind: value })}
            options={(['standard', 'event', 'offer'] as GooglePostKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))}
          /></SaveErrorField>
        </Field>
        {withPeriod ? (
          <div className={styles.fieldGroup}>
            <Field density="input" label="タイトル（特典・イベントのとき）" htmlFor="gb-post-title" error={fieldErrors.title} requirement={FIELD_REQUIREMENTS.form_title}>
              <SaveErrorField names={["title","form.title"]}><TextField id="gb-post-title" value={form.title} onChange={(e) => set({ title: e.target.value })} disabled={!editable} maxLength={100} /></SaveErrorField>
            </Field>
            <div className={styles.fieldPair}>
              <Field density="input" label="期間 はじめ" htmlFor="gb-post-start" error={fieldErrors.start} grow requirement={FIELD_REQUIREMENTS.form_start}>
                <SaveErrorField names={["start","form.start"]}><DateTimeField size="compact" id="gb-post-start" invalid={Boolean(fieldErrors.start)} value={form.start} onChange={(next) => set({ start: next })} disabled={!editable} /></SaveErrorField>
              </Field>
              <Field density="input" label="期間 おわり" htmlFor="gb-post-end" error={fieldErrors.end} grow requirement={FIELD_REQUIREMENTS.form_end}>
                <SaveErrorField names={["end","form.end"]}><DateTimeField size="compact" id="gb-post-end" invalid={Boolean(fieldErrors.end)} value={form.end} onChange={(next) => set({ end: next })} disabled={!editable} /></SaveErrorField>
              </Field>
            </div>
          </div>
        ) : null}
        <Field density="compact" label="本文" htmlFor="gb-post-summary" error={fieldErrors.summary} requirement={FIELD_REQUIREMENTS.form_summary}>
          <SaveErrorField names={["summary","form.summary"]}><TextArea density="compact" height="post" id="gb-post-summary" value={form.summary} onChange={(e) => set({ summary: e.target.value })} disabled={!editable} maxLength={1500} aria-describedby="gb-post-summary-count" /></SaveErrorField>
          <span id="gb-post-summary-count" className="sr-only">{`${form.summary.length} / 1,500 文字`}</span>
        </Field>
        <SaveErrorField names={["mediaSourceUrl","form.mediaSourceUrl","media_source_url","form.media_source_url"]}><PostImagePanel target="google" filename={form.mediaFilename} url={form.mediaSourceUrl} editable={draftEditable} lockedReason={lockedReason} busy={!canEdit || busy !== null || upload.busy} onFile={(file) => chooseFile('google', file)} onMediaPick={() => { if (editable) setPicker('google') }} onAdjust={() => adjustCrop('google')} /></SaveErrorField>
        <div className={styles.postDetails} data-post-details>
          <SectionHeader size="small" title="投稿の詳細" />
          <div className={styles.fieldPair}>
            <Field density="compact" label="ボタン" optional grow>
              <SaveErrorField names={["ctaType","form.ctaType","cta_type","type","form.cta_type"]}><Select
                aria-label="ボタンの種類"
                size="full"
                value={form.kind === 'offer' ? '' : form.ctaType}
                onChange={(v) => set({ ctaType: v as GooglePostCtaType | '' })}
                options={[{ value: '', label: form.kind === 'offer' ? 'なし（特典は Google の決まりで付けられません）' : emptyValue('none') }, ...(Object.keys(CTA_LABELS) as GooglePostCtaType[]).map((k) => ({ value: k, label: CTA_LABELS[k] }))]}
                disabled={!editable || form.kind === 'offer'}
              /></SaveErrorField>
            </Field>
            <Field density="input" label="リンク先" htmlFor="gb-post-cta-url" grow>
              <SaveErrorField names={["ctaUrl","form.ctaUrl","cta_url","form.cta_url"]}><TextField id="gb-post-cta-url" type="url" placeholder="https://" value={form.ctaUrl} onChange={(e) => set({ ctaUrl: e.target.value })} disabled={!editable || form.kind === 'offer' || !form.ctaType || form.ctaType === 'call'} maxLength={500} /></SaveErrorField>
            </Field>
          </div>
          <Field density="compact" label="公開方法">
            <Select
              aria-label="公開方法"
              size="full"
              value="now"
              onChange={() => {}}
              options={[{ value: 'now', label: '今すぐ' }, { value: 'scheduled', label: '日時を指定（Google側の対応を確かめてから使えます）', disabled: true }]}
              disabled={!editable}
            />
          </Field>
        </div>
        {form.kind === 'offer' ? (
          <div className={styles.fieldGroup}>
            <div className={styles.fieldPair}>
              <Field density="input" label="クーポンコード" optional htmlFor="gb-post-coupon" grow>
                <SaveErrorField names={["couponCode","form.couponCode","coupon_code","form.coupon_code"]}><TextField id="gb-post-coupon" value={form.couponCode} onChange={(e) => set({ couponCode: e.target.value })} disabled={!editable} maxLength={40} /></SaveErrorField>
              </Field>
              <Field density="input" label="特典の利用リンク" optional htmlFor="gb-post-redeem" grow>
                <SaveErrorField names={["redeemOnlineUrl","form.redeemOnlineUrl","redeem_online_url","form.redeem_online_url"]}><TextField id="gb-post-redeem" type="url" placeholder="https://" value={form.redeemOnlineUrl} onChange={(e) => set({ redeemOnlineUrl: e.target.value })} disabled={!editable} maxLength={200} /></SaveErrorField>
              </Field>
            </div>
            <Field density="input" label="利用条件" optional htmlFor="gb-post-terms">
              <SaveErrorField names={["termsConditions","form.termsConditions","terms_conditions","form.terms_conditions"]}><TextField id="gb-post-terms" value={form.termsConditions} onChange={(e) => set({ termsConditions: e.target.value })} disabled={!editable} maxLength={300} /></SaveErrorField>
            </Field>
          </div>
        ) : null}
        {igAvailable ? (
          <div className={styles.igBand} data-design-node="hsiwQ">
            <div className={styles.igToggleRow}>
              {draftEditable ? <>
              <SaveErrorField names={["igEnabled","form.igEnabled","ig_enabled","enabled","form.ig_enabled"]}>
                <Toggle checked={form.igEnabled} label="Instagram にも投稿する" lockedReason={lockedReason} disabled={!editable} onChange={(next) => { if (editable) set({ igEnabled: next }) }} />
              </SaveErrorField>
              <span className={styles.igToggleLabel}>Instagram にも投稿する</span>
              </> : <span className={styles.igToggleLabel}>{`Instagram にも投稿する：${form.igEnabled ? 'はい' : 'いいえ'}`}</span>}
            </div>
            {form.igEnabled ? (
              <>
                <Field label="Instagram 用の文章（書き換えたいときだけ）" optional htmlFor="gb-post-ig-caption">
                  <SaveErrorField names={["igCaption","form.igCaption","ig_caption","caption","form.ig_caption"]}><TextArea density="compact" height="post" id="gb-post-ig-caption" value={form.igCaption} onChange={(e) => set({ igCaption: e.target.value })} disabled={!editable} maxLength={2200} placeholder="空のままなら、上の本文をそのまま使います" aria-describedby="gb-post-ig-caption-count" /></SaveErrorField>
                  <span id="gb-post-ig-caption-count" className="sr-only">{`${form.igCaption.length} / 2,200 文字`}</span>
                </Field>
              </>
            ) : null}
          </div>
        ) : null}
        {igAvailable && form.igEnabled ? <>
          <PostImagePanel target="instagram" filename={form.igMediaFilename} url={form.igMediaSourceUrl} editable={draftEditable} lockedReason={lockedReason} busy={!canEdit || busy !== null || upload.busy} onFile={(file) => chooseFile('instagram', file)} onMediaPick={() => { if (editable) setPicker('instagram') }} onAdjust={() => adjustCrop('instagram')} onUseGoogle={form.mediaId ? useGoogleImage : undefined} />
        </> : null}
        {upload.error ? <Notice tone="danger">{upload.error}</Notice> : null}
        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
        {draftEditable ? (
          <>
            <Notice tone="info" density="compact" icon={null} action={<Button onClick={() => void saveDraft()} lockedReason={lockedReason} disabled={!canEdit || busy !== null || upload.busy} busy={busy === 'save'}>下書きを保存する</Button>}>
              「公開内容を確認する」で、両方の画像を見比べてから公開します。
            </Notice>
            <div className={styles.formActions}>
              <Button onClick={() => go({ tab: 'posts' })} disabled={busy !== null || upload.busy}>キャンセル</Button>
              <Button variant="primary" onClick={() => void openConfirm()} lockedReason={lockedReason} disabled={!canEdit || busy !== null || upload.busy} busy={busy === 'confirm'} busyLabel="確認中…"><Send aria-hidden className={styles.icon16} />公開内容を確認する</Button>
            </div>
          </>
        ) : (
          <div className={styles.formActions}></div>
        )}
      </Card>
      <UnsavedLeaveDialog open={leaveTarget !== null} onConfirm={confirmLeave} onCancel={cancelLeave} />
      {picker ? <PostMediaPickerDialog target={picker} accountId={accountId} onClose={() => setPicker(null)} onSelect={selectRegisteredMedia} /> : null}
      {crop ? <PostImageCrop target={crop.target} source={crop.source} onClose={() => setCrop(null)} onConfirm={confirmCrop} /> : null}
    </></SaveErrorScope>
  )
}

/** 公開前の最終確認（今の画面 jqSak と同じ動き。V8 の絵はまだ無い）。 */
export function PostConfirm({ accountId, id, go }: { accountId: string; id: string; go: GoogleNav }) {
  const saveErrors = useSaveFormErrors()

  const [post, setPost] = useState<GooglePost | null>(null)
  const [igPreview, setIgPreview] = useState<{ filename: string; url: string } | null>(null)
  const [storeName, setStoreName] = useState('')
  const [storeId, setStoreId] = useState('')
  const [writeEnabled, setWriteEnabled] = useState(true)
  const [canPublish, setCanPublish] = useState(false)
  const { allowed: canSend, lockedReason } = useGooglePermission('manager', canPublish)
  const { allowed: canEdit, lockedReason: editReason } = useGooglePermission()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [sent, setSent] = useState<{ alreadyPublished: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await restaurantGoogleApi.post(accountId, id)
      setPost(response.post)
      const instagramMediaId = response.post.instagram?.mediaId
      if (instagramMediaId && instagramMediaId === response.post.media[0]?.mediaId) {
        setIgPreview({ filename: response.post.media[0].filename, url: response.post.media[0].sourceUrl })
      } else if (instagramMediaId) {
        const media = await api.media.detail(instagramMediaId, accountId)
        setIgPreview(media.success ? media.data.item : null)
      } else setIgPreview(null)
      setStoreName(response.store.name)
      setStoreId(response.store.id)
      setWriteEnabled(response.writeEnabled)
      setCanPublish(response.canPublish)
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setLoadError(errorMessage(err, '投稿を読み込めませんでした。')) }
    } finally {
      setLoading(false)
    }
  }, [accountId, id, saveErrors])

  useEffect(() => { void load() }, [load])

  const publish = async () => {
    if (!canSend || !writeEnabled || !checked || busy || !post || ['published', 'accepted', 'rejected', 'cancelled'].includes(post.status)) return
    setBusy(true)
    setActionError('')
    try {
      const response = await restaurantGoogleApi.publishPost(accountId, id)
      setPost(response.post)
      setSent({ alreadyPublished: response.alreadyPublished })
    } catch (err) {
      const fieldFailure = saveErrors.capture(err);

      if (err instanceof ApiError && err.status === 502) {
        { if (!fieldFailure)
        setActionError('Googleへの送信結果を確認できませんでした。重複を防ぐため、次に「この内容で予約する」を押したときはGoogle側の状態を照合してから送ります。') }
        await load()
      } else {
        { if (!fieldFailure)
        setActionError(errorMessage(err, 'Googleへの投稿に失敗しました。')) }
      }
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <SaveErrorScope errors={saveErrors}><div className={styles.stateBox}><ListState kind="loading" title="投稿を読み込んでいます" /></div></SaveErrorScope>
  if (loadError || !post) return <SaveErrorScope errors={saveErrors}><ListState kind="error" title="投稿を表示できませんでした" description={loadError} onRetry={() => void load()} /></SaveErrorScope>

  const done = post.status === 'published' || post.status === 'accepted' || post.status === 'rejected'
  const canPress = canSend && writeEnabled && checked && !busy && !done && post.status !== 'cancelled'

  return (
    <SaveErrorScope errors={saveErrors}><Card appearance="outlined" layout="vertical" padding="default" gap="normal" data-design-node="jqSak">
      <SectionHeader size="small" title={<>{done ? 'この投稿をGoogleに送信しました' : 'この投稿を予約しますか？'}</>} />
      <p className={styles.muted}>Googleに公開される内容と日時を確認してください。</p>
      <OperationTargetSummary accounts={[{ id: accountId }]} store={{ id: storeId, name: storeName }} />
      {sent ? <Notice tone="success">{sent.alreadyPublished ? 'この内容はすでにGoogleに届いていました。送信はしていません。' : post.status === 'published' ? 'Googleに投稿を送信し、公開を確認しました。' : 'Googleに投稿を送信しました。反映を確認できるまで「審査中」と表示します。'}</Notice> : null}
      {post.status === 'rejected' ? <Notice tone="danger">Googleの審査で公開されませんでした。{canEdit ? '内容を見直して作り直してください。' : '管理者に内容の確認を依頼してください。'}</Notice> : null}
      {post.status === 'pending_confirm' && !sent ? <Notice tone="warn">前回の送信結果を確認できていません。{canSend && writeEnabled ? '「この内容で予約する」を押すと、先にGoogle側の状態を照合してから送信します。' : 'Google側の状態を確認してください。'}</Notice> : null}
      {!writeEnabled ? <Notice tone="warn">この環境ではGoogleへの投稿が許可されていません。内容の確認まではできます。</Notice> : null}
      {writeEnabled && !canPublish ? <Notice tone="warn">Googleへの投稿は店舗管理者以上が行います。この下書きは保存されているので、管理者が確認して投稿できます。</Notice> : null}
      {post.instagram?.status === 'failed' ? <Notice tone="warn">{`Instagram へは出せませんでした${post.instagram.error ? `（${post.instagram.error}）` : ''}。Google への公開はそのまま残っています。${canSend ? '投稿一覧の「…」から「Instagram へ再送」でもう一度送れます。' : '管理者に確認を依頼してください。'}`}</Notice> : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      <dl className={styles.facts}>
        <div className={styles.factRow}><dt className={styles.factKey}>投稿先</dt><dd className={styles.factValue}>{storeName}</dd></div>
        <div className={styles.factRow}><dt className={styles.factKey}>種類</dt><dd className={styles.factValue}>{KIND_LABELS[post.kind]}</dd></div>
        <div className={styles.factRow}><dt className={styles.factKey}>公開予定</dt><dd className={styles.factValue}>今すぐ（日本時間）</dd></div>
        {post.cta ? <div className={styles.factRow}><dt className={styles.factKey}>ボタン</dt><dd className={styles.factValue}>{`${CTA_LABELS[post.cta.type]}${post.cta.url ? ` → ${post.cta.url}` : ''}`}</dd></div> : null}
        {post.media[0] ? <div className={styles.factRow}><dt className={styles.factKey}>Google画像</dt><dd className={styles.factValue}><div className={styles.confirmImage}><div className={`${styles.confirmThumb} ${styles.confirmThumbGoogle}`}><img src={post.media[0].sourceUrl} alt="Google用画像" /></div><div><strong>Google ビジネス ・4:3</strong><span>{post.media[0].filename}</span>{post.status === 'draft' ? <div className={styles.confirmImageLinks}><Button variant="text" lockedReason={editReason} disabled={!canEdit || busy} onClick={() => { if (canEdit && !busy) go({ tab: 'posts', view: 'edit', id }) }}>画像を変更</Button><Button variant="text" lockedReason={editReason} disabled={!canEdit || busy} onClick={() => { if (canEdit && !busy) go({ tab: 'posts', view: 'edit', id, adjust: 'google' }) }}>切り取りを調整</Button></div> : null}</div></div></dd></div> : null}
        {post.instagram ? <div className={styles.factRow}><dt className={styles.factKey}>Instagram</dt><dd className={styles.factValue}>{instagramFact(post.instagram)}</dd></div> : null}
        {post.instagram?.enabled ? <div className={styles.factRow}><dt className={styles.factKey}>Instagram本文</dt><dd className={styles.factValue}>{post.instagram.caption || post.summary}</dd></div> : null}
        {post.instagram?.enabled && igPreview ? <div className={styles.factRow}><dt className={styles.factKey}>Instagram画像</dt><dd className={styles.factValue}><div className={styles.confirmImage}><div className={`${styles.confirmThumb} ${styles.confirmThumbInstagram}`}><img src={igPreview.url} alt="Instagram用画像" /></div><div><strong>Instagram ・4:5</strong><span>{igPreview.filename}</span>{post.status === 'draft' ? <div className={styles.confirmImageLinks}><Button variant="text" lockedReason={editReason} disabled={!canEdit || busy} onClick={() => { if (canEdit && !busy) go({ tab: 'posts', view: 'edit', id }) }}>画像を変更</Button><Button variant="text" lockedReason={editReason} disabled={!canEdit || busy} onClick={() => { if (canEdit && !busy) go({ tab: 'posts', view: 'edit', id, adjust: 'instagram' }) }}>切り取りを調整</Button></div> : null}</div></div></dd></div> : null}
      </dl>
      {post.title ? <SectionHeader size="small" title={post.title} /> : null}
      <p className={styles.preText}>{post.summary}</p>
      {!done && post.status !== 'cancelled' ? (
        <>
          <SaveErrorField names={["checked"]}><Checkbox checked={checked} onCheckedChange={setChecked}>公開先・本文・画像・切り取り位置・日時を確認しました</Checkbox></SaveErrorField>
          <p className={styles.grayNote}>予約後も編集・取消できます。送信後はGoogleとInstagramの状態を確認できます。</p>
          <div className={styles.formActions}>
            <Button lockedReason={editReason} onClick={() => { if (canEdit && !busy) go({ tab: 'posts', view: 'edit', id }) }} disabled={!canEdit || busy}>修正する</Button>
            <Button variant="primary" onClick={() => void publish()} lockedReason={lockedReason} disabled={!canPress} busy={busy} busyLabel="送信中…">この内容で予約する</Button>
          </div>
        </>
      ) : (
        <div className={styles.formActions}></div>
      )}
    </Card></SaveErrorScope>
  )
}
