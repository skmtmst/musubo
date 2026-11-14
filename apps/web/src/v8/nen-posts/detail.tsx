'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useEffect, useState } from 'react'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Card from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import NoteBar from '@/components/shared/note-bar'
import Notice from '@/components/shared/notice'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { FeatureLinkCard } from '@/components/shared/side-cards'
import StickyBar from '@/components/shared/sticky-bar'
import type { PhotoAssetStatus, PhotoDerivatives } from '@/lib/api'
import { formatPhotoReceivedAt } from './time'
import { safePhotoSrc } from './src'
import { photoPetDisplayName } from '@/components/shared/photo-display-name'
import { petAnimalTypeLabel } from '@/lib/nen-pets-api'
import { photoReviewReasonLabel, mileStatusLabel, text } from './text'
import { readSessionSnapshot } from '@/lib/session-snapshot'
import { formatDay, formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import { SaveErrorField } from '@/components/shared/save-form-errors'

const numberOrDash = (value: unknown) => Number.isFinite(Number(value)) ? formatNumber(Number(value)) : emptyValue('unknown')

export function PhotoReviewDetail({
  canEdit = true, photo, position, total, loading, loadKind, reviewing, notice, accountNotice, assetStatus, derivatives, assetsFailed, onReloadAssets, onReloadPhoto, assetProcessing, rotationSaving,
  onBack, onMove, onApprove, onReturn, onAdoptWithoutReward, onProcessReviewAsset, onSaveRotation, onDownloadOriginal, onPointAction, pointActionBusy,
}: {
  canEdit?: boolean
  photo: Record<string, unknown> | null
  position: number
  total: number
  loading: boolean
  loadKind: 'ready' | 'empty' | 'error' | 'forbidden'
  reviewing: boolean
  notice: string
  accountNotice: string
  assetStatus: PhotoAssetStatus | null
  derivatives: PhotoDerivatives | null
  assetsFailed: boolean
  onReloadAssets: () => void
  onReloadPhoto?: () => void
  assetProcessing: boolean
  rotationSaving: boolean
  onBack: () => void
  onMove: (direction: -1 | 1) => void
  onApprove: () => void
  onReturn: () => void
  // #817: 重複のときの「報酬なしで採用」。無いときは通常の採用へ倒す。
  onAdoptWithoutReward?: () => void
  onProcessReviewAsset: () => void
  onSaveRotation: (rotation: 0 | 90 | 180 | 270) => void
  onDownloadOriginal: (code: string) => Promise<void>
  // PHOTO-06: 止まったマイル手続きの再試行・ECとの照合。
  onPointAction: (action: 'retry' | 'reconcile') => void | Promise<void>
  pointActionBusy: 'retry' | 'reconcile' | null
}) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0)
  /*
   * 保存済みの向き。写真が変わる・保存が確定するたびに表示へ戻す。
   * 「回す」は見た目だけでなく、保存ボタンで残る（#931 N-309）。
   */
  const savedRotation = ([0, 90, 180, 270].includes(Number(photo?.display_rotation))
    ? Number(photo?.display_rotation)
    : 0) as 0 | 90 | 180 | 270
  useEffect(() => {
    setRotation(savedRotation)
    setScale(1)
  }, [photo?.id, savedRotation])
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [downloadCode, setDownloadCode] = useState('')
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  /* V-1: 二段階認証を使っている人は6桁、無い人はパスワードで確認する。 */
  const stepUpMethod = readSessionSnapshot()?.stepUpMethod ?? 'totp'
  const downloadReady = stepUpMethod === 'password' ? downloadCode.length > 0 : /^\d{6}$/.test(downloadCode)
  if (loading) return <div><DetailLoading label="写真を読み込んでいます" /></div>
  if (loadKind === 'forbidden') return <div><ListState kind="forbidden" onRetry={onReloadPhoto} /></div>
  if (loadKind === 'error') return <div><ListState kind="error" title="写真を読み込めませんでした" description="通信状態を確認して、もう一度読み込んでください。" onRetry={onReloadPhoto} /></div>
  if (!photo || loadKind === 'empty') return <div><ListState kind="empty" title="確認する写真はありません" /></div>

  const risks = Array.isArray(photo.risks) ? photo.risks as Array<Record<string, unknown>> : []
  /*
   * 採用履歴・報酬・公開先（Issue #1040 IDEA-22）。口が古い場合は
   * 項目ごとに「未取得」へ倒し、詳細自体は開いたままにする。
   */
  const history = Array.isArray(photo.history) ? photo.history as Array<Record<string, unknown>> : []
  const reward = photo.reward && typeof photo.reward === 'object'
    ? photo.reward as Record<string, unknown>
    : null
  const publication = photo.publication && typeof photo.publication === 'object'
    ? photo.publication as Record<string, unknown>
    : null
  const publicationPlacements = publication && Array.isArray(publication.placements)
    ? publication.placements as Array<Record<string, unknown>>
    : []
  const hasFaceRisk = risks.some((risk) => text(risk.flag) === 'face')
  const reviewDerivative = derivatives?.items.find((item) => item.kind === 'review') ?? null
  // 派生画像・原本どちらも検査を通す。だめな値は作り直し中の表示にする。
  const reviewUrl = safePhotoSrc(derivatives?.knownUrls.find((item) => item.kind === 'review')?.url)
    ?? safePhotoSrc(photo.image_url)
  const latestAssetJob = assetStatus?.jobs[0] ?? null
  /*
   * #817: 同じ中身の写真で、すでに採用されて報酬が付いた前の投稿。
   * 前の投稿と並べて見せ、選べるのは「却下」か「報酬なしで採用」。
   * 似ている写真は自動で却下せず、注意候補の札だけに留める。
   */
  const duplicate = photo.duplicate && typeof photo.duplicate === 'object'
    ? photo.duplicate as Record<string, unknown>
    : null
  const adoptWithoutReward = onAdoptWithoutReward ?? onApprove
  const duplicateDate = (() => {
    const date = new Date(String(duplicate?.createdAt ?? duplicate?.created_at ?? ''))
    if (Number.isNaN(date.getTime())) return '—'
    return formatDay(date)
  })()
  const duplicateImageUrl = safePhotoSrc(duplicate ? text(duplicate.imageUrl ?? duplicate.image_url) : '')
  return <div data-photo-view="detail">
    {notice && <Notice tone="danger" className="mb-4" message={notice} />}
    {accountNotice && <Notice tone="warn" className="mb-4" message={accountNotice} />}
    <div className="flex items-center justify-between gap-2 max-md:flex-col max-md:items-start">
      <div>
        <p className="text-xs font-medium text-ink-faint">写真審査</p>
        <h2 className="mt-1 text-2xl font-extrabold text-ink">{photoPetDisplayName(photo.pet_name, { callName: photo.pet_call_name, gender: photo.pet_gender })} の写真</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-2 text-xs font-medium text-ink-secondary">{total > 0 ? `${formatNumber(total)}枚のうち ${position + 1}枚目` : emptyValue('unknown')}</span>
        <Button disabled={position <= 0} onClick={() => onMove(-1)}>前の写真</Button>
        <Button disabled={position >= total - 1} onClick={() => onMove(1)}>次の写真</Button>
        <Button onClick={onBack}>並べて見るへ戻る</Button>
      </div>
    </div>

    {duplicate && <section aria-label="重複の確認" className="mt-4 rounded-card border border-hairline bg-canvas p-4">
      <Notice
        tone="warn"
        helpLabel="重複の意味"
        help="完全に同じ中身の写真だけを重複とします。似ている写真は自動で却下せず、注意候補の印だけに留めます。決めるのは人です。"
      >
        同じ写真がすでに採用されています（{duplicateDate}）。報酬を二重に付けないよう、却下か、報酬なしで採用を選んでください。
      </Notice>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <figure>
          <div className="grid h-48 place-items-center overflow-hidden rounded-card bg-canvas-sunken">
            {reviewUrl ? <img width={800} height={800}
              src={reviewUrl}
              alt="今回の投稿の写真"
              className="h-full w-full object-contain"
            /> : <p className="text-xs font-medium text-ink-faint">審査用の画像を作成中です</p>}
          </div>
          <figcaption className="mt-1 truncate text-xs font-medium text-ink" title={`今回の投稿 ${formatPhotoReceivedAt(photo.created_at)}`}>
            今回の投稿
          </figcaption>
          <p className="truncate text-xs text-ink-secondary" title={`${photoPetDisplayName(photo.pet_name, { callName: photo.pet_call_name, gender: photo.pet_gender })} ${formatPhotoReceivedAt(photo.created_at)}`}>
            {formatPhotoReceivedAt(photo.created_at)}・{photoPetDisplayName(photo.pet_name, { callName: photo.pet_call_name, gender: photo.pet_gender })}
          </p>
        </figure>
        <figure>
          <div className="grid h-48 place-items-center overflow-hidden rounded-card bg-canvas-sunken">
            {duplicateImageUrl ? <img width={800} height={800}
              src={duplicateImageUrl}
              alt="前に採用された同じ写真"
              className="h-full w-full object-contain"
            /> : <p className="text-xs font-medium text-ink-faint">前の写真を読み込めませんでした</p>}
          </div>
          <figcaption className="mt-1 truncate text-xs font-medium text-ink" title="前の投稿（採用済み）">
            前の投稿（採用済み）
          </figcaption>
          <p className="truncate text-xs text-ink-secondary" title={`${text(duplicate.petName ?? duplicate.pet_name)} ${formatPhotoReceivedAt(duplicate.createdAt ?? duplicate.created_at)}`}>
            {formatPhotoReceivedAt(duplicate.createdAt ?? duplicate.created_at)}・{text(duplicate.petName ?? duplicate.pet_name) || '名前未取得'}
          </p>
        </figure>
      </div>
    </section>}

    {hasFaceRisk && <div className="mt-4"><NoteBar tone="warn">うしろに人の顔が写っている可能性があります（自動で見つけました）</NoteBar></div>}

    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-4">
      <Card className="xl:col-span-3" overflow="hidden">
        <div className="grid h-96 place-items-center overflow-hidden bg-ink lg:h-160">
          {reviewUrl ? <img width={800} height={800}
            src={reviewUrl}
            alt={`${photoPetDisplayName(photo.pet_name, { callName: photo.pet_call_name, gender: photo.pet_gender })}の審査用写真`}
            className="h-full w-full object-contain transition-transform"
            style={{ transform: `scale(${scale}) rotate(${rotation}deg)` }}
          /> : <p className="text-xs font-medium text-ink-faint">審査用の画像を作成中です</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3">
          <Button onClick={() => setScale((value) => Math.min(1.5, value + 0.1))}>大きく</Button>
          <Button onClick={() => setScale((value) => Math.max(0.7, value - 0.1))}>小さく</Button>
          <Button onClick={() => setRotation((value) => ((value + 90) % 360) as 0 | 90 | 180 | 270)}>回す</Button>
          {/*
           * 直した向きは保存ボタンで残す（#931 N-309）。見た目だけだと、
           * 通したあと元の向きへ戻ってしまう。保存するまで元の向き。
           */}
          {/* 閲覧のみには押せない保存・作り直しを置かない。 */}
          {<PermissionGatedButton allowed={canEdit}
            disabled={rotation === savedRotation || rotationSaving}
            onClick={() => onSaveRotation(rotation)}
            title={rotation === savedRotation ? '回したあとに保存できます' : '回した向きをこの写真へ保存します'} busy={rotationSaving} busyLabel="保存中…">向きを保存する</PermissionGatedButton>}
          <Button disabled title="切り取りは派生画像の生成口を接続後に使えます">切り取る</Button>
          {<PermissionGatedButton allowed={canEdit} disabled={assetProcessing} onClick={onProcessReviewAsset} busy={assetProcessing} busyLabel="作成中…">審査用画像を作り直す</PermissionGatedButton>}
          <Button onClick={() => { setDownloadOpen(true); setDownloadCode(''); setDownloadError('') }}>もとの画像を保存する</Button>
        </div>
        <p className="px-4 pb-4 pt-1 text-xs text-ink-faint">{numberOrDash(reviewDerivative?.width ?? photo.image_width)} × {numberOrDash(reviewDerivative?.height ?? photo.image_height)} ／ {(reviewDerivative?.byteSize ?? photo.image_byte_size) == null ? '—（未取得）' : `${(Number(reviewDerivative?.byteSize ?? photo.image_byte_size) / 1024 / 1024).toFixed(1)}MB`} ／ {text(photo.captured_device) || '—（未取得）'}　派生画像：{reviewDerivative ? `審査用 第${reviewDerivative.sourceVersion}版` : latestAssetJob ? `${assetStatusLabel(latestAssetJob.status)}（第${latestAssetJob.requestedVersion}版）` : '未取得'}</p>
        {assetsFailed ? <div className="flex items-center gap-2 px-4 pb-4"><p className="text-xs text-ink-faint">審査用画像の状態を読み込めませんでした。</p><Button onClick={onReloadAssets}>状態を読み直す</Button></div> : null}
      </Card>

      <aside className="flex flex-col gap-3">
        <Card padding="default">
          <dl>
            <div><dt className="text-xs font-medium text-ink-faint">送ってくれた人</dt><dd className="mt-1 text-xs font-medium text-ink">{text(photo.owner_name) || '名前未取得'}</dd><small className="mt-1 block text-xs text-ink-faint">投稿 {numberOrDash(photo.submission_count)} 回目 ／ 見送ったこと {numberOrDash(photo.returned_count)} 回</small></div>
            <div className="mt-3 border-t border-hairline pt-3"><dt className="text-xs font-medium text-ink-faint">ペット</dt><dd className="mt-1 text-xs font-medium text-ink">{photoPetDisplayName(photo.pet_name, { fallback: '未取得', callName: photo.pet_call_name, gender: photo.pet_gender })}（{petAnimalTypeLabel(text(photo.animal_type))}・{text(photo.breed) || '品種未取得'}）</dd></div>
            <div className="mt-3 border-t border-hairline pt-3"><dt className="text-xs font-medium text-ink-faint">届いた日時</dt><dd className="mt-1 text-xs font-medium text-ink">{formatPhotoReceivedAt(photo.created_at)}</dd></div>
            <div className="mt-3 border-t border-hairline pt-3"><dt className="text-xs font-medium text-ink-faint">そえられた言葉</dt><dd className="mt-1 text-xs font-medium text-ink">{text(photo.caption) ? `「${text(photo.caption)}」` : 'コメントなし'}</dd></div>
          </dl>
        </Card>
        <Card padding="default">
          <h2 className="text-sm font-bold text-ink">自動で見つけたこと</h2>
          {risks.length === 0 ? <p className="mt-1 text-xs font-medium leading-relaxed text-ink-faint">注意候補はありません。公開の最終判断は人が行います。</p> : risks.map((risk, index) => <div key={`${text(risk.flag)}-${index}`} className="mt-3 border-t border-hairline pt-3">
            <strong>{text(risk.note) || text(risk.flag)}</strong>
            <span className="mt-1 block text-xs text-ink-faint">{risk.confidence == null ? '確からしさは未取得' : `可能性 ${Math.round(Number(risk.confidence) * 100)}%`}</span>
          </div>)}
        </Card>
        {/*
         * 採用1回に付与1回・撤回後に残る公開先を、この写真の記録として
         * その場で確認する（Issue #1040 IDEA-22）。口が古い場合は各項目が
         * 「未取得」側へ倒れるだけで、詳細の操作は止まらない。
         */}
        <Card padding="default">
          <h2 className="text-sm font-bold text-ink">採用・同意・公開の記録</h2>
          <dl className="text-xs">
            <div className="mt-3 border-t border-hairline pt-3">
              <dt className="font-medium text-ink-faint">審査の記録</dt>
              {history.length === 0
                ? <dd className="mt-1 font-bold text-ink">まだ審査の記録はありません</dd>
                : history.map((event, index) => <dd key={`${text(event.created_at)}-${index}`} className="mt-1 font-bold text-ink">
                  {text(event.to_status) === 'adopted' ? '採用' : '見送り'}
                  {text(event.reason_code) ? `（${photoReviewReasonLabel(event.reason_code)}）` : ''}
                  ・{text(event.reviewed_by_name) || '担当未取得'}・{formatPhotoReceivedAt(event.created_at)}
                  {Number(event.awarded_points) > 0 ? `・${Number(event.awarded_points)}マイル` : ''}
                  {text(event.notification_status) === 'failed' ? '・通知は失敗' : ''}
                </dd>)}
            </div>
            <div className="mt-3 border-t border-hairline pt-3">
              <dt className="font-medium text-ink-faint">公開の同意</dt>
              <dd className="mt-1 font-bold text-ink">
                {text(photo.publication_consent_at)
                  ? `${formatPhotoReceivedAt(photo.publication_consent_at)}に同意${text(photo.publication_consent_version) ? `（${text(photo.publication_consent_version)}）` : ''}`
                  : '未取得'}
              </dd>
              {text(photo.publication_withdrawn_at)
                ? <dd className="mt-1 font-bold text-status-warn-deep">ご本人が撤回：{formatPhotoReceivedAt(photo.publication_withdrawn_at)}</dd>
                : null}
            </div>
            <div className="mt-3 border-t border-hairline pt-3">
              <dt className="font-medium text-ink-faint">公開先</dt>
              {!publication
                ? <dd className="mt-1 font-bold text-ink">まだ公開先はありません</dd>
                : <>
                  {text(publication.status) === 'withdrawn'
                    ? <dd className="mt-1 font-bold text-ink">掲載先から外しました（{formatPhotoReceivedAt(publication.withdrawn_at)}{text(publication.withdrawn_by_name) ? `・${text(publication.withdrawn_by_name)}` : ''}）</dd>
                    : null}
                  {publicationPlacements.length === 0
                    ? <dd className="mt-1 font-bold text-ink">掲載先の登録はありません</dd>
                    : publicationPlacements.map((placement) => <dd key={text(placement.id)} className="mt-1 font-bold text-ink">
                      {text(placement.placement_label)}・{Number(placement.active) === 1
                        ? `掲載中（${formatPhotoReceivedAt(placement.created_at)}から）`
                        : `外した（${formatPhotoReceivedAt(placement.removed_at)}）`}
                    </dd>)}
                  <dd className="mt-1 font-medium text-ink-faint">公開の期限は設けていません。外す操作をするまで掲載され続けます。</dd>
                </>}
            </div>
            <div className="mt-3 border-t border-hairline pt-3">
              <dt className="font-medium text-ink-faint">マイル</dt>
              {/*
               * 派生状態（state）はサーバーが一覧と同じ分岐で出す
               * （PHOTO-06）。古い口から来た応答は生のstatusへ倒す。
               */}
              <dd className="mt-1 font-bold text-ink">
                {text(photo.status) === 'adopted'
                  ? reward
                    ? `${mileStatusLabel(text(reward.state) || reward.status, Number(reward.points) || 5)}${text(reward.synced_at) ? `（${formatPhotoReceivedAt(reward.synced_at)}）` : ''}`
                    : 'EC未接続・マイル対象外'
                  : 'マイルの対象は採用した写真だけです'}
              </dd>
              {reward && (text(reward.reason_label) || text(reward.last_error))
                ? <dd className="mt-1 font-semibold text-status-warn-deep">確認が必要：{text(reward.reason_label) || text(reward.last_error)}</dd>
                : null}
              {canEdit && reward && ['stale', 'failed_retryable'].includes(text(reward.state))
                ? <dd className="mt-2 flex flex-wrap gap-2">
                  <Button size="field" disabled={pointActionBusy !== null} onClick={() => void onPointAction('retry')} busy={pointActionBusy === 'retry'} busyLabel="送り直しています…">マイル手続きをもう一度送る
                  </Button>
                  <Button size="field" disabled={pointActionBusy !== null} onClick={() => void onPointAction('reconcile')} busy={pointActionBusy === 'reconcile'} busyLabel="照合しています…">EC側と照合する
                  </Button>
                </dd>
                : null}
              {text(photo.status) === 'adopted'
                ? <dd className="mt-1 font-medium text-ink-faint">採用1回につき付与は1回です。外しても付与済みのマイルは戻りません。</dd>
                : null}
            </div>
          </dl>
        </Card>
        <FeatureLinkCard items={[
          { label: 'ECマイル', note: 'ECとつながっていれば、採用したとき5マイルの手続きを始める' },
          { label: 'LINE通知', note: '審査結果を本人へ送る' },
          { label: '登録メディア', note: '公開用画像の置き場' },
        ]} />
      </aside>
    </div>
    <div className="mt-4">
      <StickyBar
        status={duplicate
          ? `${formatNumber(total)} 枚のうち ${position + 1} 枚目。重複のため、却下か報酬なしで採用を選んでください。`
          : `${formatNumber(total)} 枚のうち ${position + 1} 枚目。あと${Math.max(0, total - position - 1)} 枚あります。`}
        actions={!canEdit ? undefined : duplicate ? <>
        {/* 109: 断る側は赤い文字だけ。採用は主（右）のまま。 */}
        <Button variant="text" textTone="danger" disabled={reviewing} onClick={onReturn}>却下する</Button>
        <Button disabled title="切り取り版の生成口を接続後に使えます">切り取ってから採用</Button>
        <Button variant="primary" disabled={reviewing} onClick={adoptWithoutReward} busy={reviewing} busyLabel="処理中…">報酬なしで採用</Button>
        </> : <>
        <Button variant="text" textTone="danger" disabled={reviewing} onClick={onReturn}>見送る（理由を選ぶ）</Button>
        <Button disabled title="切り取り版の生成口を接続後に使えます">切り取ってから採用</Button>
        <Button variant="primary" disabled={reviewing} onClick={onApprove} busy={reviewing} busyLabel="処理中…">このまま採用</Button>
        </>}
      />
    </div>
    <Dialog
      open={downloadOpen}
      title="もとの画像を保存"
      description={stepUpMethod === 'none'
        ? '原本には個人情報が含まれる場合があります。この操作には二段階認証またはパスワードの設定が必要です。'
        : `原本には個人情報が含まれる場合があります。${stepUpMethod === 'password' ? 'パスワード' : '6桁の再認証コード'}を入力すると、一度だけ保存できます。`}
      busy={downloadBusy}
      error={downloadError}
      confirmLabel="再認証して保存する"
      cancelLabel="キャンセル"
      onCancel={() => { setDownloadOpen(false); setDownloadError('') }}
      onConfirm={stepUpMethod === 'none' ? undefined : () => {
        if (!downloadReady) { setDownloadError(stepUpMethod === 'password' ? 'パスワードを入力してください。' : '6桁の再認証コードを入力してください。'); return }
        setDownloadBusy(true)
        setDownloadError('')
        return onDownloadOriginal(downloadCode)
          .then(() => setDownloadOpen(false))
          .catch((error: unknown) => setDownloadError(describeApiFailure(error, '保存')))
          .finally(() => setDownloadBusy(false))
      }}
    >
      {stepUpMethod === 'none' ? null : stepUpMethod === 'password' ? (
        <Field label="パスワード" htmlFor="photo-download-password">
          <SaveErrorField names={["downloadCode","download_code"]}><TextField id="photo-download-password" type="password" value={downloadCode} onChange={(event) => { setDownloadCode(event.target.value); setDownloadError('') }} autoComplete="current-password" /></SaveErrorField>
        </Field>
      ) : (
        <Field label="再認証コード" htmlFor="photo-download-code">
          <SaveErrorField names={["downloadCode","download_code"]}><TextField id="photo-download-code" value={downloadCode} onChange={(event) => { setDownloadCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setDownloadError('') }} inputMode="numeric" autoComplete="one-time-code" placeholder="6桁のコード" /></SaveErrorField>
        </Field>
      )}
    </Dialog>
  </div>
}

function assetStatusLabel(status: string) {
  if (status === 'queued') return '作成待ち'
  if (status === 'processing') return '作成中'
  if (status === 'failed') return '作成失敗'
  return '作成済み'
}
