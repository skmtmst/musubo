'use client'

import BulkBar from '@/components/shared/bulk-bar'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Card, { CardActionRow } from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import { Field,FieldError } from '@/components/shared/form-controls'
import HelpTip from '@/components/shared/help-tip'
import IconButton from '@/components/shared/icon-button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { photoPetDisplayName } from '@/components/shared/photo-display-name'
import Radio from '@/components/shared/radio'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SearchField from '@/components/shared/search-field'
import SegmentedControl from '@/components/shared/segmented'
import StatusBadge from '@/components/shared/status-badge'
import { TextArea } from '@/components/shared/text-field'
import TruncatedText from '@/components/shared/truncated-text'
import { PageContent } from '@/components/templates/page-frame'
import { formatNumber,formatListDay as polishFormatListDay } from '@/lib/format'
import { Check,Globe,Send,X } from 'lucide-react'
import { PhotoStatus,REVIEW_REASONS,ReviewReasonCode,SENT_REASON_LABELS } from './review-model'
import styles from './review.module.css'
import { safePhotoSrc } from './src'
import { mileStatusLabel,text } from './text'
import { formatPhotoReceivedAt } from './time'
import { withHonorific } from '@line-crm/shared'
import { ToggleField } from '@/components/shared/toggle'

export type ReviewListV8Props = {
  accountId: string
  status: PhotoStatus
  photos: Array<Record<string, unknown>>
  loading: boolean
  loadError: string
  loadForbidden: boolean
  canEdit: boolean
  reviewing: string | null
  notice: string
  searchInput: string
  searchQuery: string
  hasMorePhotos: boolean
  loadingMore: boolean
  policyPoints: number | null
  publicationPoints: number | null
  reasonCounts: Array<[string, number]>
  selectedPhotoIds: string[]
  selectedPendingCount: number
  totalPendingCount?: number
  allPhotosLoading: boolean
  allPhotosError: string
  onRetryAllPhotos: () => void
  onSelectAllPending: () => void
  selectedPhotosAreLowRisk: boolean
  bulkReviewing: boolean
  onSearchInput: (next: string) => void
  onSearchQuery: (next: string) => void
  onToggleSelect: (id: string) => void
  onClearSelection: () => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onRetryNotification: (id: string) => void
  onOpenDetail: () => void
  onPublish: (id: string) => void
  onOpenPublications: () => void
  onLoadMore: () => void
  onRetryLoad: () => void
  onBulkApprove: () => void
  onBulkReturn: () => void
}

/* 右の棚の「見送り理由の内訳」に、0件でも並べる理由（絵は3行）。 */
export const RAIL_REASON_CODES: ReviewReasonCode[] = ['quality', 'privacy', 'unrelated']

/**
 * 審査の札（・・見送り）と採用の札。
 * 審査待ちは「道具の段・写真3列・説明」の左の列＋右に決まりの棚（幅300）。
 * 採用は棚なしで、幅288のカードを左から並べる。
 */
export function ReviewListV8(props: ReviewListV8Props) {
  const { status, photos, loading, loadError, loadForbidden, canEdit, notice } = props
  const adopted = status === 'adopted'
  const showRail = status === 'pending'

  const toolbar = (
    <div className={styles.tools} data-design-node="photo-controls-v8">
      <form
        className={adopted ? styles.searchWide : styles.search}
        onSubmit={(event) => {
          event.preventDefault()
          props.onSearchQuery(props.searchInput.trim().slice(0, 100))
        }}
      >
        <SearchField
          aria-label="写真を探す"
          value={props.searchInput}
          onChange={(value) => { props.onSearchInput(value); props.onSearchQuery(value.trim().slice(0, 100)) }}
          onClear={() => { props.onSearchInput(''); props.onSearchQuery('') }}
          placeholder={status === 'pending' ? '飼い主・ペット名で探す' : '名前・ペット名・コメントで探す'}
          maxLength={100}
        />
      </form>
      <span className={styles.toolsSpace} aria-hidden="true" />
      {!adopted && status === 'pending' ? <HelpTip label="写真の見え方の説明">「1枚ずつ大きく見る」にすると、写真を大きくして順に確かめられます（← → で次へ）</HelpTip> : null}
      {adopted ? (
        <p className={styles.toolsNote}>写真を採用しても自動公開しません。本人の公開同意を確認したあと、公式サイト掲載で公開先を選びます。</p>
      ) : (
        <SegmentedControl size="small" className={styles.viewSwitch} aria-label="写真の見え方" options={[{ value: 'list', label: '並べて見る' }, { value: 'detail', label: '1枚ずつ大きく見る' }]} value="list" onChange={(next) => { if (next === 'detail' && photos.length > 0) props.onOpenDetail() }} />
      )}
    </div>
  )

  const state = loading && photos.length === 0 ? (
    <ListState kind="loading" title="写真を読み込んでいます" />
  ) : loadForbidden ? (
    <ListState kind="forbidden" title="写真を見る権限がありません" description="管理者へ写真審査の閲覧権限を確認してください。" />
  ) : loadError ? (
    <ListState kind="error" title="写真を読み込めませんでした" description="通信状態を確認して、もう一度読み込んでください。" onRetry={props.onRetryLoad} />
  ) : photos.length === 0 ? (
    <ListState kind="empty" emptyPreset="readonly" title="この状態の写真はありません" description="別の状態を選ぶか、新しい写真が届くまでお待ちください。掲載した写真は「公式サイト掲載」タブで確認できます。" />
  ) : null

  const cards = (
    <ul className={adopted ? styles.cardsAdopted : showRail ? styles.cards : styles.cardsWide} data-design-node="photo-cards-v8">
      {photos.map((photo) => (
        <PhotoCardV8 key={text(photo.id)} photo={photo} {...props} />
      ))}
    </ul>
  )

  const more = !loading && !loadError && props.hasMorePhotos ? (
    <div>
      <Button variant="secondary" disabled={props.loadingMore} onClick={props.onLoadMore} busy={props.loadingMore} busyLabel="読み込み中…">
        {`さらに読み込む（いま${formatNumber(photos.length)} 枚）`}
      </Button>
    </div>
  ) : null

  const leftColumn = (
    <div className={adopted ? styles.adoptedColumn : styles.leftColumn}>
      {toolbar}
      {notice ? <Notice tone="danger" message={notice} /> : null}
      {props.searchQuery ? <p className={styles.toolsNote}>{`「${props.searchQuery}」で絞り込んでいます`}</p> : null}
      {state ?? cards}
      {more}
    </div>
  )

  return (
    <PageContent>
      {showRail ? (
        <div className={styles.reviewGrid}>
          {leftColumn}
          <aside className={styles.rail} data-design="Right" data-design-node="photo-rail-v8">
            <section className={styles.railCard} aria-label="報酬の決まり">
              <h2 className={styles.railTitle}>報酬の決まり</h2>
              <p className={styles.railRow}><span>採用したら</span><strong>{props.policyPoints == null ? emptyValue('unknown') : `${formatNumber(props.policyPoints)} マイル`}</strong></p>
              <p className={styles.railRow}><span>公式サイトに載ったら</span><strong title={props.publicationPoints == null ? '掲載時の追加報酬は決まっていません' : undefined}>{props.publicationPoints == null ? emptyValue('unknown') : props.publicationPoints === 0 ? emptyValue('none') : `さらに ${formatNumber(props.publicationPoints)} マイル`}</strong></p>
              <p className={styles.railNote}>採用すると、投稿した人に LINE でお知らせします</p>
            </section>
            <section className={styles.railCard} aria-label="確認する順">
              <h2 className={styles.railTitle}>確認する順</h2>
              <p className={styles.railRow}><span>古いものから</span><strong>いまの順</strong></p>
              <p className={styles.railRow}><span>会員ランクが高い人を先に</span><strong>しない</strong></p>
            </section>
            <section className={styles.railCard} aria-label="見送り理由の内訳">
              <h2 className={styles.railTitle}>見送り理由の内訳（今月）</h2>
              {[
                ...RAIL_REASON_CODES.map((code) => [code, props.reasonCounts.find(([c]) => c === code)?.[1] ?? 0] as [string, number]),
                ...props.reasonCounts.filter(([code]) => !RAIL_REASON_CODES.includes(code as ReviewReasonCode)),
              ].map(([code, count]) => (
                <p className={styles.railRow} key={code}>
                  <span>{REVIEW_REASONS.find((reason) => reason.value === code)?.label ?? '理由未記録'}</span>
                  <strong>{count}</strong>
                </p>
              ))}
            </section>
          </aside>
        </div>
      ) : leftColumn}

      {status === 'pending' && canEdit ? (
        <BulkBar count={props.selectedPendingCount} total={props.totalPendingCount} onSelectAll={props.onSelectAllPending} onClear={props.onClearSelection} unit="枚" hint={props.allPhotosLoading ? '全ページの写真を確認しています…' : props.allPhotosError ? <><span role="alert">{props.allPhotosError}</span><Button size="compact" onClick={props.onRetryAllPhotos}>もう一度読み込む</Button></> : '審査待ちの写真だけをまとめて処理します'}>
            <Button variant="secondary" disabled={props.bulkReviewing} onClick={props.onBulkReturn}>
              まとめて見送り
            </Button>
            <Button
              variant="primary"
              disabled={!props.selectedPhotosAreLowRisk || props.bulkReviewing}
              title={!props.selectedPhotosAreLowRisk ? 'まとめて採用できるのは、注意候補がない写真だけです' : undefined}
              onClick={props.onBulkApprove}
              busy={props.bulkReviewing}
              busyLabel="処理中…"
            >
              <Check size={16} aria-hidden="true" />まとめて採用
            </Button>
            <IconButton aria-label="選択するのをやめる" title="選ぶのをやめる" onClick={props.onClearSelection}><X size={16} aria-hidden="true" /></IconButton>
        </BulkBar>
      ) : null}
    </PageContent>
  )
}

export function PhotoCardV8({ photo, status, ...props }: { photo: Record<string, unknown>; status: PhotoStatus } & ReviewListV8Props) {
  const photoId = text(photo.id)
  const name = photoPetDisplayName(photo.pet_name, { callName: photo.pet_call_name, gender: photo.pet_gender })
  const selected = props.selectedPhotoIds.includes(photoId)
  const imageSrc = safePhotoSrc(photo.image_url)
  const busy = props.reviewing === photoId
  const consented = Boolean(text(photo.publication_consent_at)) && !text(photo.publication_withdrawn_at)
  const notificationFailed = text(photo.review_notification_status) === 'failed'
  const adopted = status === 'adopted'
  const owner = text(photo.owner_name)
  const ownerLine = `${owner ? withHonorific(owner) : '名前未取得'}${text(photo.customer_id) ? `・EC-${text(photo.customer_id)}` : ''}`
  const received = Date.parse(text(photo.created_at))
  return (
    <li className={styles.cardItem}><Card as="article" layout="vertical" padding="default" gap="normal" selected={selected} aria-label={`${name}の投稿写真`}>
      <div className={styles.cardPhoto}>
        {imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- お客様が投稿した写真
          <img width={240} height={240} src={imageSrc} alt={`${name}の投稿写真`} loading="lazy" />
        ) : (
          <div className={styles.cardPhotoEmpty}>画像を表示できません</div>
        )}
        {status === 'pending' && props.canEdit ? (
          <span className={styles.cardPick}>
            <SaveErrorField names={["selected"]}><Checkbox checked={selected} onCheckedChange={() => props.onToggleSelect(photoId)} aria-label={`${name}の写真を選ぶ`}>選ぶ</Checkbox></SaveErrorField>
          </span>
        ) : null}
      </div>
      <div className={styles.cardNameRow}>
        <p className={styles.cardName} ><TruncatedText value={String(name ?? '')} /></p>
        <span className={styles.cardDate} title={formatPhotoReceivedAt(photo.created_at)}>{Number.isFinite(received) ? polishFormatListDay(new Date(received)) : '日時不明'}</span>
      </div>
      <p className={styles.cardOwner} title={ownerLine}>{ownerLine}</p>
      {!adopted && text(photo.caption) ? <p className={styles.cardCaption} title={text(photo.caption)}>{`「${text(photo.caption)}」`}</p> : null}
      {adopted ? (
        <>
          <div className={styles.cardChips}>
            <StatusBadge tone="success">採用</StatusBadge>
            <span className={styles.cardOwner}>{Number.isFinite(Number(photo.awarded_points)) && photo.awarded_points != null && text(photo.point_sync_status) === 'synced' ? `${formatNumber(Number(photo.awarded_points))} マイル付与済み` : mileStatusLabel(photo.point_sync_status)}</span>
          </div>
          <div className={styles.cardChips}>
            {consented ? <StatusBadge tone="success">公開の同意あり</StatusBadge> : <StatusBadge tone="neutral">公開しない</StatusBadge>}
          </div>
        </>
      ) : null}
      {status === 'rejected' && text(photo.review_reason_code) ? (
        <p className={styles.rejectReason}>
          見送った理由：{REVIEW_REASONS.find((reason) => reason.value === text(photo.review_reason_code))?.label ?? '理由未記録'}
          {text(photo.review_reason_note) ? `／${text(photo.review_reason_note)}` : ''}
        </p>
      ) : null}
      {status === 'pending' ? (
        props.canEdit ? (
          <CardActionRow>
            <Button variant="secondary" disabled={busy} aria-label={`${name}の写真を見送る`} onClick={() => props.onReject(photoId)}><X size={16} aria-hidden="true" />見送る</Button>
            <Button variant="primary" fullWidth disabled={busy} aria-label={`${name}の写真を採用する`} onClick={() => props.onApprove(photoId)} busy={busy} busyLabel="処理中…"><Check size={16} aria-hidden="true" />採用する</Button>
          </CardActionRow>
        ) : (
          /* 閲覧のみには押せないボタンを置かない。場所だけ空けて、並びをそろえる。 */
          <span className={styles.cardActionSpace} aria-hidden="true" />
        )
      ) : null}
      {adopted && props.canEdit && (consented || notificationFailed) ? (
        <div className={styles.cardActionSingle}>
          {consented ? (
            <Button variant="secondary" disabled={busy} onClick={() => props.onPublish(photoId)}><Globe size={16} aria-hidden="true" />公式サイトに出す</Button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => props.onRetryNotification(photoId)} busy={busy} busyLabel="再送中…"><Send size={16} aria-hidden="true" />LINE通知を再送</Button>
          )}
        </div>
      ) : null}
      {adopted && props.canEdit && consented && notificationFailed ? (
        <div className={styles.cardActionSingle}>
          <Button variant="secondary" disabled={busy} onClick={() => props.onRetryNotification(photoId)} busy={busy} busyLabel="再送中…"><Send size={16} aria-hidden="true" />LINE通知を再送</Button>
        </div>
      ) : null}
      {status !== 'adopted' && props.canEdit && notificationFailed ? (
        <div className={styles.cardActionSingle}>
          <Button variant="secondary" disabled={busy} onClick={() => props.onRetryNotification(photoId)} busy={busy} busyLabel="再送中…"><Send size={16} aria-hidden="true" />LINE通知を再送</Button>
        </div>
      ) : null}
    </Card></li>
  )
}

/**
 * この写真を見送る。真ん中の小窓。
 * 理由をえらぶとお客様への文章が自動でつくられる。
 * 見送ってもマイルは減らない。
 */
export function RejectDialogV8({
  accountId,
  photo,
  reasonCode,
  reasonNote,
  reasonError,
  reasonFieldError,
  resubmitInvite,
  watchSubmitter,
  busy,
  onReasonCode,
  onReasonNote,
  onResubmitInvite,
  onWatchSubmitter,
  onClose,
  onConfirm,
}: {
  accountId: string
  photo: Record<string, unknown> | null
  reasonCode: ReviewReasonCode
  reasonNote: string
  reasonError: string
  reasonFieldError: string
  resubmitInvite: boolean
  watchSubmitter: boolean
  busy: boolean
  onReasonCode: (next: ReviewReasonCode) => void
  onReasonNote: (next: string) => void
  onResubmitInvite: (next: boolean) => void
  onWatchSubmitter: (next: boolean) => void
  onClose: () => void
  onConfirm: () => void
}) {
  const name = photo ? photoPetDisplayName(photo.pet_name, { callName: photo.pet_call_name, gender: photo.pet_gender }) : '写真'
  const preview = photo
    ? [
      'お写真をご投稿いただきありがとうございます。',
      `今回は「${SENT_REASON_LABELS[reasonCode]}」のため、掲載を見送らせていただきました。`,
      ...(reasonNote.trim() ? [reasonNote.trim()] : []),
      ...(resubmitInvite ? ['内容をご確認のうえ、よろしければ別のお写真をご投稿ください。'] : []),
    ].join('\n')
    : ''
  const imageSrc = photo ? safePhotoSrc(photo.image_url) : null
  const owner = photo ? text(photo.owner_name) : ''
  const received = photo ? Date.parse(text(photo.created_at)) : Number.NaN
  const sub = photo
    ? `${owner ? withHonorific(owner) : 'お名前は未取得'}${text(photo.customer_id) ? `・EC-${text(photo.customer_id)}` : ''}・${Number.isFinite(received) ? polishFormatListDay(new Date(received)) : '日時不明'}${text(photo.caption) ? `「${text(photo.caption)}」` : ''}`
    : ''
  return (
    <Dialog open designNode="ujcar" designWidth={620} designTop={90} title="この写真を見送りますか？" description="理由をえらぶと、お客様への文章が自動でつくられます。見送っても、この方のマイルは減りません。" confirmation tone="destructive" busy={busy} error={reasonError} onCancel={onClose} onConfirm={onConfirm} confirmLabel="見送る">
      <OperationTargetSummary accounts={[{ id: accountId }]} />
      <div className={styles.dialogStack}>
        {photo ? (
          <div className={styles.dialogPhoto}>
            {imageSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- お客様が投稿した写真
              <img width={44} height={44} src={imageSrc} alt="" className={styles.dialogPhotoThumb} />
            ) : <span className={styles.dialogPhotoThumb} aria-hidden="true" />}
            <div className={styles.dialogPhotoText}>
              <p className={styles.dialogPhotoName}>{name}</p>
              <p className={styles.dialogPhotoSub} title={sub}>{sub}</p>
            </div>
          </div>
        ) : null}
        <div className={styles.pillGroup} role="radiogroup" aria-labelledby="nen-posts-reject-reason">
          <p id="nen-posts-reject-reason" className={styles.fieldTitle}>見送った理由</p>
          {REVIEW_REASONS.map((reason) => (
            <SaveErrorField names={["photo-reject-reason","reasonCode","value","reason.value"]} key={reason.value}><Radio key={reason.value} name="photo-reject-reason" checked={reasonCode === reason.value} onChange={() => { onReasonCode(reason.value); onReasonNote(reason.value === 'other' ? '' : reason.message) }}>{reason.label}</Radio></SaveErrorField>
          ))}
        </div>
        <Field label="お客様に届く補足（直せます）"><SaveErrorField names={["reasonNote","reason_note"]}><TextArea id="photo-reject-note" size="short" invalid={Boolean(reasonFieldError)} aria-describedby={reasonFieldError ? 'photo-reject-note-error' : undefined} aria-label="お客様に届く補足" value={reasonNote} maxLength={500} rows={2} placeholder={reasonCode === 'other' ? 'お客様に送る文章を書いてください' : '必要な場合だけ補足します'} onChange={(event) => onReasonNote(event.target.value)} /></SaveErrorField>
<FieldError id="photo-reject-note-error">{reasonFieldError}</FieldError></Field>
        {/* 絵に無い「次の投稿は人が見る」は、同じ行の右に小さく置く（行を増やさない）。 */}
        <div className={styles.checkLine}>
          <SaveErrorField names={["resubmitInvite","resubmit_invite"]}><ToggleField checked={resubmitInvite} onChange={onResubmitInvite}>もう一度 送ってもらえるようお願いする</ToggleField></SaveErrorField>
          <span className={styles.checkSub}><SaveErrorField names={["watchSubmitter","watch_submitter"]}><ToggleField checked={watchSubmitter} onChange={onWatchSubmitter}>この人の次の投稿は、必ず人が見る</ToggleField></SaveErrorField></span>
        </div>
        <div className={styles.fieldLabel}>
          <p className={styles.fieldTitle}>投稿者に届く内容</p>
          <div className={styles.previewBox}><p title={preview}><span>{preview}</span></p></div>
        </div>
      </div>
    </Dialog>
  )
}
