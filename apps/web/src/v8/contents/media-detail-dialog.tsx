'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { requiredText } from '@/lib/form-requirement'
const changeReasonRequirement = requiredText('変更理由を入力してください。')
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import type { MediaDeleteImpactReference, MediaItem } from '@line-crm/shared'
import { api, type MediaVersionBlocker, type MediaVersionPreview } from '@/lib/api'
import Button from '@/components/shared/button'
import DateField from '@/components/shared/date-field'
import MediaSlot from '@/components/shared/media-slot'
import Notice from '@/components/shared/notice'
import { isSaveConflict, SaveConflictBand } from '@/components/shared/save-conflict'
import Select from '@/components/shared/select'
import { formatMediaSize } from './media-usage-display'
import { checkedAtText, referenceKindText, referenceNameText } from './media-delete-impact'
import { setMediaUsageReference, type MediaUsageImpact, type MediaUsageReferenceItem, type MediaUsageReferenceState, type MediaUsageReferenceTarget } from './media-usage-references'
import { extractMediaMetadata, fileMatchesMediaKind, mediaAcceptForKind, putMediaFile, validateMediaFile } from './media-direct-upload'
import { formatDate as polishFormatDate } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import TextLink from '@/components/shared/text-link'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/** 版追加を止めた理由を、互換基準ごとに運用者へ説明する。 */
function versionBlockerText(blockers: MediaVersionBlocker[]): string {
  if (blockers.includes('different_kind')) {
    return 'ファイルの種類が違うため、このメディアへ追加できません。'
  }
  if (blockers.includes('upload_not_verified')) {
    return 'ファイルの確認が終わっていません。もう一度確認してください。'
  }
  const reasons: string[] = []
  if (blockers.includes('incompatible_dimensions')) reasons.push('寸法')
  if (blockers.includes('incompatible_duration')) reasons.push('長さ')
  if (blockers.includes('incompatible_pages')) reasons.push('ページ数')
  if (blockers.includes('incompatible_codec')) reasons.push('コーデック')
  if (reasons.length > 0) {
    return `現在のメディアと${reasons.join('・')}が違うため、このメディアへ追加できません。`
  }
  return '互換性を確かめるための内容情報（寸法・長さ・ページ数）が足りないため、このメディアへ追加できません。別のメディアとして新規登録してください。'
}

function formatDate(value: string): string {
  return polishFormatDate(value, { style: 'detail', fallback: '—（未取得）' })
}

function mediaKind(item: MediaItem): string {
  if (item.kind === 'image') return item.mimeType.split('/')[1]?.toUpperCase() || '画像'
  if (item.kind === 'video') return 'MP4'
  if (item.kind === 'audio') return item.mimeType.includes('mp4') ? 'M4A' : 'MP3'
  return 'PDF'
}

function mediaLimit(item: MediaItem): string {
  if (item.kind === 'image') return '画像は 10MB まで'
  if (item.kind === 'video') return '動画は 200MB まで'
  if (item.kind === 'audio') return '音声は 200MB まで'
  return 'PDFは 20MB まで'
}

function mediaDimensions(item: MediaItem): string {
  if (item.width != null && item.height != null) return `${item.width} × ${item.height} px`
  if (item.durationMs != null) {
    const totalSeconds = Math.round(item.durationMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`
  }
  return '—（未取得）'
}

/** 使用先の今の参照方法を短い言葉で。切替選択肢の現在値でも使う。 */
function usageModeText(reference: MediaUsageReferenceState | null): string {
  if (!reference) return '参照方法は未取得'
  switch (reference.mode) {
    case 'live':
      return '常に最新版（ライブ参照）'
    case 'pinned':
      return `第${reference.versionNo ?? '?'}版に固定`
    case 'mixed':
      return '複数の参照が混在しています'
    case 'unknown':
      return '参照の形を判別できません'
    default:
      return '参照の形を判別できません'
  }
}

/** 切替セレクトの現在値。ライブ・固定以外は選択肢を出さない。 */
function usageSelectValue(reference: MediaUsageReferenceState | null): string | null {
  if (!reference) return null
  if (reference.mode === 'live') return 'live'
  if (reference.mode === 'pinned' && reference.versionNo != null) return `v:${reference.versionNo}`
  return null
}

/** 記録された利用期限の表示。日付は端末の時間帯に流されず、そのまま出す。 */
function usageExpiryText(value: string | null | undefined): string {
  if (!value) return '不明（記録なし）'
  const [year, month, day] = value.split('-')
  return `${Number(year)}/${Number(month)}/${Number(day)}`
}

/** 記録された利用期限が今日（JST）より前なら、期限切れとして明示する。 */
function isUsageExpired(value: string | null | undefined): boolean {
  if (!value) return false
  const todayJst = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  return value < todayJst
}

/** 版のダウンロード名。どの版か分かるように a.png → a-v1.png とする。 */
function versionDownloadName(filename: string, versionNo: number): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0
    ? `${filename.slice(0, dot)}-v${versionNo}${filename.slice(dot)}`
    : `${filename}-v${versionNo}`
}

export default function MediaDetailDialog({
  item,
  accountId,
  folderName,
  canManage,
  onClose,
  onVersionCreated,
  onItemUpdated,
}: {
  item: MediaItem | null
  accountId: string | null
  folderName: string
  /** owner/admin のみ true。staff には押して失敗する口を見せない。 */
  canManage: boolean
  onClose: () => void
  onVersionCreated: (message: string) => void
  /** 利用期限・同意の記録を保存したとき、一覧側の表示を新しい行へ追従させる。 */
  onItemUpdated?: (item: MediaItem) => void
}) {
  const saveErrors = useSaveFormErrors()

  const fileInputId = useId()
  const requestRef = useRef(0)
  const [impact, setImpact] = useState<MediaUsageImpact | null>(null)
  const [usageSwitching, setUsageSwitching] = useState<string | null>(null)
  const [usageError, setUsageError] = useState('')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [versionFile, setVersionFile] = useState<File | null>(null)
  const [versionPhase, setVersionPhase] = useState<'idle' | 'uploading' | 'preview' | 'publishing' | 'error'>('idle')
  const [versionProgress, setVersionProgress] = useState(0)
  const [versionPreview, setVersionPreview] = useState<MediaVersionPreview | null>(null)
  const [changeReason, setChangeReason] = useState('')
  const [versionError, setVersionError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  /** 版ごとの取り出し。版番号で押し中を持ち、連打と混線を防ぐ。 */
  const [downloadingVersion, setDownloadingVersion] = useState<number | null>(null)
  const [versionDownloadError, setVersionDownloadError] = useState('')
  /*
    既知の利用期限・同意情報（IDEA-15）。記録された値だけを見せ、
    未記録は「不明」と出す。編集は記録係（owner/admin）だけ。
  */
  const [termsEditing, setTermsEditing] = useState(false)
  const [termsExpiresAt, setTermsExpiresAt] = useState('')
  const [termsConsentNote, setTermsConsentNote] = useState('')
  const [termsBusy, setTermsBusy] = useState(false)
  const [termsError, setTermsError] = useState('')
  const [termsConflict, setTermsConflict] = useState(false)
  const [termsDiscardOpen, setTermsDiscardOpen] = useState(false)
  const [versionNotice, setVersionNotice] = useState('')
  const [pendingVersionMessage, setPendingVersionMessage] = useState<string | null>(null)
  const termsDirty = termsEditing && (termsExpiresAt !== (item?.usageExpiresAt ?? '') || termsConsentNote !== (item?.usageConsentNote ?? ''))
  const editBusy = termsBusy || versionPhase === 'uploading' || versionPhase === 'publishing'
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({
    dirty: termsDirty || Boolean(versionFile || versionPreview || changeReason) || editBusy,
    busy: editBusy,
    onDiscard: () => { setTermsEditing(false); setVersionFile(null); setVersionPreview(null); setVersionPhase('idle'); setChangeReason('') },
  })
  useEffect(() => {
    if (!pendingVersionMessage) return
    const message = pendingVersionMessage
    setPendingVersionMessage(null)
    guard.guarded(() => onVersionCreated(message))
  }, [pendingVersionMessage, guard.guarded, onVersionCreated])

  /** 保存URLへ直接行かず、権限確認と監査を通る口から受け取って保存させる。 */
  const displaySrc = item && accountId ? api.media.contentUrl(item.id, accountId) : ''

  async function downloadItem() {
    if (!item || !accountId || downloading) return
    setDownloading(true)
    setDownloadError('')
    try {
      const blob = await api.media.download(item.id, accountId)
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = item.filename
      anchor.click()
      URL.revokeObjectURL(href)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setDownloadError(describeApiFailure(caught, 'ダウンロード')) }
    } finally {
      setDownloading(false)
    }
  }

  /** 指定した版を認証・監査つきの口から取り出す。第1版＝登録時の元ファイル。 */
  async function downloadVersion(versionNo: number) {
    if (!item || !accountId || downloadingVersion !== null) return
    setDownloadingVersion(versionNo)
    setVersionDownloadError('')
    try {
      const blob = await api.media.downloadVersion(item.id, versionNo, accountId)
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = versionDownloadName(item.filename, versionNo)
      anchor.click()
      URL.revokeObjectURL(href)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setVersionDownloadError(describeApiFailure(caught, 'ダウンロード')) }
    } finally {
      setDownloadingVersion(null)
    }
  }

  function startTermsEdit() {
    if (!item) return
    setTermsExpiresAt(item.usageExpiresAt ?? '')
    setTermsConsentNote(item.usageConsentNote ?? '')
    setTermsError('')
    setTermsConflict(false)
    setTermsEditing(true)
  }

  /** 利用期限・同意の記録。空欄は「記録なし＝不明」へ戻す。 */
  async function saveTerms() {
    if (!item || !accountId || termsBusy) return
    if (termsConflict) return
    if (!item.revision) {
      setTermsError('現在の版を確認できません。画面を開き直してから保存してください。')
      return
    }
    setTermsBusy(true)
    setTermsError('')
    try {
      const response = await api.media.update(item.id, accountId, {
        expectedRevision: item.revision,
        usageExpiresAt: termsExpiresAt || null,
        usageConsentNote: termsConsentNote.trim() || null,
      })
      if (!response.success) throw new Error(response.error)
      setTermsEditing(false)
      setTermsConflict(false)
      onItemUpdated?.(response.data)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      if (isSaveConflict(caught)) {
        setTermsError('')
        setTermsConflict(true)
      } else if (!fieldFailure) {
        setTermsError(describeApiFailure(caught, '保存'))
      }
    } finally {
      setTermsBusy(false)
    }
  }

  async function reloadTerms() {
    if (!item || !accountId || termsBusy) return
    setTermsBusy(true)
    setTermsError('')
    try {
      const response = await api.media.detail(item.id, accountId)
      if (!response.success || !response.data.item.revision) {
        setTermsError('最新の内容を読み込めませんでした。もう一度お試しください。')
        return
      }
      onItemUpdated?.(response.data.item)
      setTermsExpiresAt(response.data.item.usageExpiresAt ?? '')
      setTermsConsentNote(response.data.item.usageConsentNote ?? '')
      setTermsConflict(false)
    } catch (caught) {
      setTermsError(describeApiFailure(caught, '最新の内容の読み込み'))
    } finally {
      setTermsBusy(false)
    }
  }

  const loadImpact = useCallback(async () => {
    if (!item || !accountId) {
      setImpact(null)
      setPhase('error')
      return
    }
    const request = requestRef.current + 1
    requestRef.current = request
    setImpact(null)
    setPhase('loading')
    setUsageError('')
    try {
      const response = await api.media.deleteImpact(item.id, accountId)
      if (requestRef.current !== request) return
      if (!response.success) throw new Error('impact_failed')
      // 応答には使用先ごとの参照モードと版一覧が足されている。
      setImpact(response.data as MediaUsageImpact)
      setPhase('ready')
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (requestRef.current === request) setPhase('error')
    }
  }, [accountId, item, saveErrors])

  /** 1つの使用先だけを、ライブ参照または指定した版へ切り替える。 */
  async function switchUsageReference(reference: MediaUsageReferenceItem, value: string) {
    if (!item || !accountId || !reference.refKind || !reference.refId || usageSwitching) return
    let target: MediaUsageReferenceTarget | null = null
    if (value === 'live') {
      target = { refKind: reference.refKind, refId: reference.refId, mode: 'live' }
    } else if (value.startsWith('v:')) {
      const versionNo = Number.parseInt(value.slice(2), 10)
      if (Number.isInteger(versionNo) && versionNo >= 1) {
        target = { refKind: reference.refKind, refId: reference.refId, mode: 'pinned', versionNo }
      }
    }
    if (!target) return
    const request = `${reference.refKind}:${reference.refId}`
    setUsageSwitching(request)
    setUsageError('')
    try {
      const response = await setMediaUsageReference(item.id, accountId, target)
      if (!response.success) throw new Error(response.error)
      await loadImpact()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setUsageError(describeApiFailure(caught, '切り替え')) }
    } finally {
      setUsageSwitching(null)
    }
  }

  useEffect(() => {
    void loadImpact()
    return () => {
      requestRef.current += 1
    }
  }, [loadImpact])

  useEffect(() => {
    setVersionFile(null)
    setVersionPhase('idle')
    setVersionProgress(0)
    setVersionPreview(null)
    setChangeReason('')
    setVersionError('')
    setDownloadingVersion(null)
    setVersionDownloadError('')
    setTermsEditing(false)
    setTermsError('')
    setTermsConflict(false)
    setVersionNotice('')
    setPendingVersionMessage(null)
  }, [item?.id])

  function chooseVersionFile(file: File | null) {
    setVersionPreview(null)
    setVersionProgress(0)
    setVersionError('')
    if (!file || !item) {
      setVersionFile(null)
      setVersionPhase('idle')
      return
    }
    const validation = validateMediaFile(file)
    if (validation) {
      setVersionFile(null)
      setVersionPhase('error')
      setVersionError(validation)
      return
    }
    if (!fileMatchesMediaKind(file, item.kind)) {
      setVersionFile(null)
      setVersionPhase('error')
      setVersionError('いまのメディアと同じ種類のファイルを選んでください')
      return
    }
    setVersionFile(file)
    setVersionPhase('idle')
  }

  async function prepareVersion() {
    if (!item || !accountId || !versionFile || versionPhase === 'uploading') return
    setVersionPhase('uploading')
    setVersionProgress(0)
    setVersionError('')
    setVersionPreview(null)
    try {
      const prepared = await api.media.prepareUploads({
        accountId,
        files: [{
          filename: versionFile.name,
          mimeType: versionFile.type,
          sizeBytes: versionFile.size,
          targetMediaId: item.id,
          metadata: await extractMediaMetadata(versionFile),
        }],
      })
      const session = prepared.success ? prepared.data.sessions[0] : null
      if (!session) throw new Error('送信の準備結果を確認できませんでした。時間をおいて、もう一度お試しください。')
      const etag = await putMediaFile(session, versionFile, setVersionProgress)
      const completed = await api.media.completeUpload(session.id, { accountId, etag })
      if (!completed.success || completed.data.status !== 'verified') {
        throw new Error('差し替え用ファイルを確認できませんでした。時間をおいて、もう一度お試しください。')
      }
      const previewed = await api.media.previewVersion(item.id, {
        accountId,
        uploadSessionId: session.id,
      })
      if (!previewed.success) throw new Error(previewed.error)
      setVersionPreview(previewed.data)
      setVersionPhase('preview')
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      setVersionPhase('error')
      { if (!fieldFailure)
      setVersionError(describeApiFailure(caught, '読み込み')) }
    }
  }

  async function publishVersion() {
    if (!item || !accountId || !versionPreview?.canReplace || Boolean(changeReasonRequirement.check(changeReason))) return
    setVersionPhase('publishing')
    setVersionError('')
    try {
      const response = await api.media.createVersion(item.id, {
        accountId,
        uploadSessionId: versionPreview.uploadSessionId,
        previewToken: versionPreview.previewToken,
        changeReason: changeReason.trim(),
      })
      if (!response.success) throw new Error(response.error)
      const message = `「${item.filename}」へ第${response.data.versionNo}版を追加しました。使用先の固定版は変えていません。`
      setVersionFile(null)
      setVersionPreview(null)
      setChangeReason('')
      setVersionPhase('idle')
      setVersionNotice(message)
      setPendingVersionMessage(message)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      setVersionPhase('preview')
      { if (!fieldFailure)
      setVersionError(describeApiFailure(caught, '保存')) }
    }
  }

  if (!item) return null

  return (
    <SaveErrorScope errors={saveErrors}><div data-design-node="voJtX" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="現在位置" className="text-action flex flex-wrap items-center gap-2 text-xs font-semibold">
            <a
              href="/contents"
              onClick={(event) => {
                event.preventDefault()
                guard.guarded(onClose)
              }}
              className="hover:underline"
            >
              登録メディア
            </a>
            <span aria-hidden="true">›</span>
            <span>{folderName}</span>
            <span aria-hidden="true">›</span>
            <span className="text-ink-faint max-w-md truncate" ><TruncatedText value={String(item.filename ?? '')} /></span>
          </nav>
          <h2 className="text-ink mt-3 truncate text-xl font-bold" title={item.filename}>{item.filename}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void downloadItem()} disabled={downloading} busy={downloading} busyLabel="取得中…">ダウンロード
          </Button>
          {downloadError ? <Notice tone="danger" >{downloadError}</Notice> : null}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <div className="bg-canvas-sunken rounded-card flex min-h-96 items-center justify-center overflow-hidden border border-hairline">
            {item.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={displaySrc} alt={item.filename} className="max-h-96 max-w-full object-contain" />
            ) : item.kind === 'video' ? (
              <video src={displaySrc} controls className="max-h-96 max-w-full" />
            ) : item.kind === 'audio' ? (
              <audio src={displaySrc} controls />
            ) : (
              <TextLink external href={displaySrc}   className="text-action text-sm font-semibold">PDFへ</TextLink>
            )}
          </div>

          <section className="content-card rounded-card border bg-canvas p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-ink text-sm font-bold">この{item.kind === 'image' ? '画像' : 'メディア'}を差し替える</h3>
                <p className="text-ink-faint mt-1 text-xs">名前と管理用URLを保ったまま新しい版を追加します。</p>
              </div>
              <span className="bg-accent-soft text-accent-deep rounded-pill px-2 py-1 text-xs font-semibold">安全確認して追加</span>
            </div>
            <div className="mt-4">
              <MediaSlot
                kind={item.kind}
                title={`新しい${item.kind === 'image' ? '画像' : item.kind === 'video' ? '動画' : item.kind === 'audio' ? '音声' : 'ファイル'}を追加`}
                accept={mediaAcceptForKind(item.kind)}
                help="いまのメディアと同じ種類"
                busy={versionPhase === 'uploading'}
                progress={versionPhase === 'uploading' ? versionProgress : undefined}
                onFile={(file) => chooseVersionFile(file)}
              />
              {versionFile ? <p className="text-ink mt-2 truncate text-xs font-medium" title={versionFile.name}>{`選んだファイル：${versionFile.name}`}</p> : null}
            </div>
            {versionPreview ? (
              <Notice tone={versionPreview.canReplace ? 'success' : 'danger'}>
                {versionPreview.canReplace
                  ? `現在の第${versionPreview.currentVersionNo}版から第${versionPreview.currentVersionNo + 1}版へ追加できます。`
                  : versionBlockerText(versionPreview.blockers)}
              </Notice>
            ) : null}
            {versionPreview?.canReplace ? (
              <div className="mt-3"><Field label="変更理由" htmlFor={`${fileInputId}-reason`} requirement={changeReasonRequirement}><SaveErrorField names={["changeReason","change_reason"]}><SharedTextField id={`${fileInputId}-reason`} value={changeReason} onChange={(event) => setChangeReason(event.target.value)} maxLength={500} className="border-hairline rounded-control mt-1 min-h-10 w-full border px-3 text-sm" placeholder="例：秋の写真へ更新" /></SaveErrorField></Field></div>
            ) : null}
            {versionNotice ? <Notice tone="success" message={versionNotice} className="mt-3" /> : null}
            {versionError ? <Notice tone="danger" message={versionError} className="mt-3" /> : null}
            {impact && impact.usageCount > 0 ? (
              <Notice tone="warn" className="mt-3">
                新しい版を追加しても、現在このメディアを使っている{impact.usageCount}か所の固定版は変わりません。使う場所ごとに切り替えてください。
              </Notice>
            ) : null}
            <div className="mt-4 flex justify-end">
              {versionPreview?.canReplace ? (
                <Button type="button" variant="primary" onClick={() => void publishVersion()} disabled={Boolean(changeReasonRequirement.check(changeReason)) || versionPhase === 'publishing'} busy={versionPhase === 'publishing'} busyLabel="追加しています…">新しい版を追加する
                </Button>
              ) : (
                <Button type="button" variant="primary" onClick={() => void prepareVersion()} disabled={!versionFile || versionPhase === 'uploading'}>
                  差し替え内容を確認
                </Button>
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="content-card rounded-card border bg-canvas p-4">
            <h3 className="text-ink text-sm font-bold">ファイルのこと</h3>
            <dl className="mt-4 space-y-3 text-xs">
              {[
                ['種類', mediaKind(item)],
                ['大きさ', mediaDimensions(item)],
                ['容量', formatMediaSize(item.sizeBytes)],
                ['入れた日', formatDate(item.createdAt)],
                // R35: 内部ID（UUID）ではなく担当者の表示名を出す。
                // 退職・削除済みで引けないときは人に分かる言葉にし、IDは出さない。
                ['入れた人', item.uploadedByName ?? (item.uploadedBy ? '削除された担当者' : '—（未取得）')],
                ['LINEの上限', mediaLimit(item)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <dt className="text-ink-faint">{label}</dt>
                  <dd className="text-ink text-right font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="content-card rounded-card border bg-canvas p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-ink text-sm font-bold">利用の期限・同意</h3>
              {canManage && !termsEditing ? (
                <Button type="button" onClick={startTermsEdit}>記録する</Button>
              ) : null}
            </div>
            <dl className="mt-4 space-y-3 text-xs">
              <div className="flex items-start justify-between gap-3">
                <dt className="text-ink-faint">利用期限</dt>
                <dd className="text-ink text-right font-semibold">
                  {usageExpiryText(item.usageExpiresAt)}
                  {isUsageExpired(item.usageExpiresAt) ? (
                    <span className="text-danger ml-1">（期限を過ぎています）</span>
                  ) : null}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-ink-faint">同意・権利の記録</dt>
                <dd className="text-ink whitespace-pre-wrap text-right font-semibold">
                  {item.usageConsentNote ? item.usageConsentNote : '不明（記録なし）'}
                </dd>
              </div>
            </dl>
            <p className="text-ink-faint mt-3 text-xs leading-5">
              確認できたことだけを記録します。記録のない項目は「不明」のままにし、権利や期限を推測しません。
            </p>
            {termsEditing ? (
              <div className="border-hairline mt-3 space-y-3 border-t pt-3">
                <div><Field label="利用期限（分かる場合だけ）" htmlFor={`${fileInputId}-expires`}><SaveErrorField names={["termsExpiresAt","usageExpiresAt","terms_expires_at"]}><DateField
                    id={`${fileInputId}-expires`}
                    value={termsExpiresAt}
                    onChange={setTermsExpiresAt}
                    className="mt-1"
                  /></SaveErrorField></Field></div>
                <div><Field label="同意・権利の記録（確認した内容だけ）" htmlFor={`${fileInputId}-consent`}><SaveErrorField names={["termsConsentNote","usageConsentNote","terms_consent_note"]}><SharedTextField
                    id={`${fileInputId}-consent`}
                    type="text"
                    value={termsConsentNote}
                    onChange={(event) => setTermsConsentNote(event.target.value)}
                    maxLength={500}
                    className="border-hairline rounded-control mt-1 w-full border px-3 py-2 text-sm"
                    placeholder="例：出演者の同意書を確認済み（2026-01-10）"
                  /></SaveErrorField></Field></div>
                {termsError ? <Notice tone="danger" message={termsError} /> : null}
                {termsConflict ? <SaveConflictBand title="ほかの人が先に利用の期限・同意を変更しました" description="入力中の内容は保存されていません。最新を読み込んでから編集してください。" reloadVariant="secondary" onReload={() => void reloadTerms()} /> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" onClick={() => { if (termsDirty) setTermsDiscardOpen(true); else setTermsEditing(false) }} disabled={termsBusy}>キャンセル</Button>
                  <Button type="button" variant="primary" onClick={() => void saveTerms()} disabled={termsBusy || termsConflict} busy={termsBusy} busyLabel="保存しています…">保存する
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="content-card rounded-card border bg-canvas p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-ink text-sm font-bold">使われている場所</h3>
              {/* R34: 未確認の0件は「0か所」にしない。件数は「—」で出す。 */}
              <span className="text-action text-xs font-medium">
                {impact && (impact.verified !== false || impact.references.length > 0)
                  ? `${impact.usageCount}か所`
                  : emptyValue('unknown')}
              </span>
            </div>
            {phase === 'loading' ? (
              <p className="text-ink-faint mt-3 text-xs">使われている場所を確認しています…</p>
            ) : phase === 'error' ? (
              <Notice tone="danger" className="mt-3" action={<Button type="button" onClick={() => loadImpact()} busyLabel="処理中…">もう一度読み込む</Button>}>使われている場所を確認できませんでした。</Notice>
            ) : impact ? (
              <>
                {/*
                  R34: 未確認は「どこでも使っていない」と分けて出す。
                  見つかった使用先は実在するので一覧は残し、読み残しがある
                  旨と読み直しを添える。0件の未確認は未使用にしない。
                */}
                {impact.verified === false ? (
                  <div className="mt-3 space-y-2" role="status">
                    <p className="text-ink-secondary text-xs">
                      {impact.references.length > 0
                        ? 'ほかに確認できていない場所があります。'
                        : '使われている場所を確かめられませんでした。'}
                    </p>
                    <Button type="button" onClick={() => loadImpact()} busyLabel="処理中…">もう一度読み込む</Button>
                  </div>
                ) : null}
                {impact.references.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                {impact.references.map((reference: MediaDeleteImpactReference, index) => {
                  const usage = reference as MediaUsageReferenceItem
                  const selectValue = usageSelectValue(usage.reference)
                  const canSwitch = canManage
                    && usage.state === 'available'
                    && usage.refKind !== null
                    && usage.refId !== null
                    && usage.refKind !== 'webinar'
                    && usage.refKind !== 'booking_menu'
                    && usage.refKind !== 'booking_staff'
                    && usage.refKind !== 'booking_settings'
                    && selectValue !== null
                  const options = [
                    ...(usage.refKind === 'rich_menu' ? [] : [{ value: 'live', label: '常に最新版（ライブ参照）' }]),
                    ...(impact.versions ?? []).map((version) => ({
                      value: `v:${version.versionNo}`,
                      label: `第${version.versionNo}版に固定${version.isCurrent ? '（最新）' : ''}`,
                    })),
                  ]
                  const itemKey = `${usage.refKind}:${usage.refId}`
                  return (
                    <li key={`${reference.kind}-${index}`} className="border-hairline rounded-control border p-3 text-xs">
                      <p className="text-ink font-semibold">{referenceKindText(reference.kind)}「{referenceNameText(reference)}」</p>
                      <p className="text-ink-faint mt-1">{usageModeText(usage.reference)}</p>
                      {canSwitch ? (
                        <div className="mt-2">
                          <SaveErrorField names={["selectValue","select_value"]}><Select
                            aria-label="この場所の参照方法"
                            value={selectValue}
                            options={options}
                            onChange={(value) => void switchUsageReference(usage, value)}
                            disabled={usageSwitching !== null}
                          /></SaveErrorField>
                          {usageSwitching === itemKey ? (
                            <p className="text-ink-faint mt-1" aria-live="polite">切り替えています…</p>
                          ) : null}
                        </div>
                      ) : null}
                      {reference.href ? <a href={reference.href} className="text-action mt-2 inline-flex font-semibold">ここを開く</a> : <p className="text-ink-faint mt-2">この画面からは開けません</p>}
                    </li>
                  )
                })}
                  </ul>
                ) : impact.verified === false ? null : (
                  <p className="text-ink-faint mt-3 text-xs">どこでも使われていません。</p>
                )}
              </>
            ) : null}
            {usageError ? <Notice tone="danger" className="mt-3" >{usageError}</Notice> : null}
            {impact ? <p className="text-ink-faint mt-3 text-xs">{checkedAtText(impact.checkedAt)} 時点で確認</p> : null}
            {impact && impact.verified === false ? (
              <p className="text-ink-secondary mt-3 text-xs leading-5">確かめられないため削除できません。読み直してから、もう一度お試しください。</p>
            ) : impact && impact.usageCount > 0 ? (
              <p className="text-ink-faint mt-3 text-xs leading-5">使われているあいだは削除できません。先にこの{impact.usageCount}か所から外してください。</p>
            ) : null}
          </section>

          {impact && impact.versions.length > 0 ? (
            <section className="content-card rounded-card border bg-canvas p-4">
              <h3 className="text-ink text-sm font-bold">版と元ファイル</h3>
              <p className="text-ink-faint mt-1 text-xs leading-5">
                第1版は登録時の元ファイルです。差し替えても各版は残り、ここから取り戻せます。
              </p>
              <ul className="mt-3 space-y-2">
                {impact.versions.map((version) => (
                  <li key={version.versionNo} className="border-hairline rounded-control border p-3 text-xs">
                    <p className="text-ink font-semibold">
                      第{version.versionNo}版
                      {version.isCurrent ? '（最新）' : ''}
                      {version.versionNo === 1 ? '（元ファイル）' : ''}
                    </p>
                    <p className="text-ink-faint mt-1">
                      {formatMediaSize(version.sizeBytes)}・{version.mimeType}・{formatDate(version.createdAt)}
                    </p>
                    {version.changeReason ? (
                      <p className="text-ink-faint mt-1">変更理由：{version.changeReason}</p>
                    ) : null}
                    <div className="mt-2">
                      <Button
                        type="button"
                        onClick={() => void downloadVersion(version.versionNo)}
                        disabled={downloadingVersion !== null} busy={downloadingVersion === version.versionNo} busyLabel="取得中…">この版をダウンロード
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {versionDownloadError ? <Notice tone="danger" className="mt-2" >{versionDownloadError}</Notice> : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div><OverlayDepthContext.Provider value={depth + 2}>
      <UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={editBusy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
      <UnsavedLeaveDialog open={termsDiscardOpen} title="入力を破棄しますか？" description="利用期限と同意の入力が消えます。" discardLabel="破棄する" onConfirm={() => { setTermsDiscardOpen(false); setTermsEditing(false) }} onCancel={() => setTermsDiscardOpen(false)} />
    </OverlayDepthContext.Provider></SaveErrorScope>
  )
}
