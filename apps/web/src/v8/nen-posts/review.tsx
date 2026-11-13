'use client'

import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { DetailV8 } from './review-detail'
import { RejectDialogV8,ReviewListV8 } from './review-list'
import { PHOTO_PAGE_SIZE,PhotoPageResponse,PhotoStatus,PhotoView,REVIEW_REASONS,ReviewReasonCode,boardNode,photoPagePath } from './review-model'

import { describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import { collectUncountedListRows } from '@/components/shared/collect-list-rows'
import Dialog from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import { Field,FieldError } from '@/components/shared/form-controls'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import { photoPetDisplayName } from '@/components/shared/photo-display-name'
import Radio from '@/components/shared/radio'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import { Tabs } from '@/components/shared/tabs'
import { TextArea } from '@/components/shared/text-field'
import { notifySaved, notifyToast } from '@/components/shared/toast';
import { ListPage } from '@/components/templates'
import { ApiError,api,fetchApi,type PhotoBulkReviewResult,type PhotoReviewMetrics } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { formatMinutesRough,formatWaitRough } from '@/lib/format-duration'
import { focusFormField } from '@/lib/use-field-validation'
import { HelpCircle,History,Undo2 } from 'lucide-react'
import { useCallback,useEffect,useRef,useState } from 'react'
import { photoNoticeFor } from './notice'
import PhotoPolicyHistoryV8 from './policy-history'
import { photoReviewEntryFrom,photoReviewSearch,type PhotoReviewEntry } from './query'
import { PhotoReviewHelp, PublicationRules } from './review-summary';
import styles from './review.module.css'
import { reviewVersionOf,text } from './text'
import Checkbox from '@/components/shared/checkbox';
import Chip from '@/components/shared/chip';
import ConfirmDialog from '@/components/shared/confirm-dialog';
import Disclosure from '@/components/shared/disclosure';
import Notice from '@/components/shared/notice';
import OperationTargetSummary from '@/components/shared/operation-target-summary';
import { RowActions } from '@/components/shared/row-actions';
import StatusBadge from '@/components/shared/status-badge';
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table';
import { DetailColumns } from '@/components/templates/detail-columns';
import { safePhotoSrc } from './src';
import { formatPhotoReceivedAt } from './time';

/** 確認を閉じた後やアカウント・権限が変わった後の確定を無効にする。 */
function usePhotoConfirmWindow(accountId: string | null, canEdit: boolean) {
  const scope = useRef({ accountId, canEdit })
  if (scope.current.accountId !== accountId || scope.current.canEdit !== canEdit) scope.current = { accountId, canEdit }
  const ticket = useRef<{ scope: typeof scope.current } | null>(null)
  const rendered = ticket.current
  useEffect(() => () => { ticket.current = null }, [])
  return {
    open: () => { ticket.current = { scope: scope.current } },
    close: () => { ticket.current = null },
    valid: () => Boolean(rendered && ticket.current === rendered && rendered.scope === scope.current && scope.current.canEdit),
  }
}

function isThisMonth(value: string): boolean {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return false
  const month = (date: Date) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric' }).format(date)
  return month(new Date(time)) === month(new Date())
}

/**
 * 投稿の V8 画面。外枠（見出し・版の履歴・札・数の帯）は全部の札で同じ。
 */
export default function PhotoReviewV8({ accountId }: { accountId: string | null }) {
  const saveErrors = useSaveFormErrors()
  const [photos, setPhotos] = useState<Array<Record<string, unknown>>>([])
  const [reviewMetrics, setReviewMetrics] = useState<PhotoReviewMetrics | null>(null)
  const [policyPoints, setPolicyPoints] = useState<number | null>(null)
  // 掲載されたときの追加マイル（版に無いときは null＝「—」）。
  const [publicationPoints, setPublicationPoints] = useState<number | null>(null)
  const [publishedCount, setPublishedCount] = useState<number | null>(null)
  const [entry, setEntry] = useState<PhotoReviewEntry>(() => photoReviewEntryFrom(typeof window === 'undefined' ? '' : window.location.search))
  const [status, setStatus] = useState<PhotoStatus>(entry.status)
  const [view, setView] = useState<PhotoView>(entry.view)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadForbidden, setLoadForbidden] = useState(false)
  const [hasMorePhotos, setHasMorePhotos] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [notice, setNotice] = useState('')
  const [searchInput, setSearchInput] = useState(entry.q ?? '')
  const [searchQuery, setSearchQuery] = useState(entry.q ?? '')
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([])
  const [allPhotoRows, setAllPhotoRows] = useState<Array<Record<string, unknown>> | null>(null)
  const [allPhotosError, setAllPhotosError] = useState('')
  const [allPhotosLoading, setAllPhotosLoading] = useState(false)
  const [reviewing, setReviewing] = useState<string | null>(null)
  // 審査・見送りの口は owner/admin だけ。staff は見るだけ。
  const canEdit = canManageRole(useStaffRole())
  const [historyOpen, setHistoryOpen] = useState(false)
  const loadSequence = useRef(0)
  const accountGeneration = useRef(0)
  const reviewKeys = useRef(new Map<string, string>())
  const retryKeys = useRef(new Map<string, string>())
  const [bulkFailed, setBulkFailed] = useState<Array<{ photoId: string; petName: string; error: string }>>([])



  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setAllPhotoRows(null)
    setAllPhotosError('')
    setAllPhotosLoading(false)
    if (!accountId) {
      setPhotos([])
      setReviewMetrics(null)
      setPolicyPoints(null)
      setPublicationPoints(null)
      setPublishedCount(null)
      setLoadError('')
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    setLoadForbidden(false)
    setHasMorePhotos(false)
    const [photosResult, metricsResult, policyResult, publicationsResult] = await Promise.allSettled([
      fetchApi<PhotoPageResponse>(photoPagePath(accountId, 0, searchQuery)),
      api.nenMembers.photoReviewMetrics(accountId),
      api.nenMembers.photoRewardPolicyVersions(),
      api.nenMembers.photoPublications(accountId),
    ])
    if (sequence !== loadSequence.current) return
    if (metricsResult.status === 'fulfilled' && metricsResult.value.success) {
      setReviewMetrics(metricsResult.value.data)
    } else {
      setReviewMetrics(null)
    }
    if (policyResult.status === 'fulfilled' && policyResult.value.success && Array.isArray(policyResult.value.data)) {
      const current = policyResult.value.data.find((v) => v.status === 'in_use') ?? null
      setPolicyPoints(current ? current.points : null)
      setPublicationPoints(current && typeof current.publicationPoints === 'number' ? current.publicationPoints : null)
    } else {
      setPolicyPoints(null)
      setPublicationPoints(null)
    }
    if (publicationsResult.status === 'fulfilled' && publicationsResult.value.success && !Array.isArray(publicationsResult.value.data)) {
      setPublishedCount(publicationsResult.value.data?.summary?.publishedCount ?? null)
    } else {
      setPublishedCount(null)
    }
    try {
      if (photosResult.status === 'rejected') throw photosResult.reason
      const response = photosResult.value
      if (sequence !== loadSequence.current) return
      if (!response.success) throw new Error('load_failed')
      setPhotos(response.data)
      setHasMorePhotos(response.data.length === PHOTO_PAGE_SIZE)
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (sequence === loadSequence.current) {
        setPhotos([])
        setHasMorePhotos(false);

        const forbidden = error instanceof ApiError && error.status === 403
        setLoadForbidden(forbidden)
        { if (!fieldFailure)
        setLoadError(forbidden ? permissionDeniedMessage('store') : '写真を読み込めませんでした。') }
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [accountId, searchQuery, saveErrors])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    accountGeneration.current += 1
    setNotice(''); setSelectedPhotoIds([]); setHistoryOpen(false)
    setRejectingPhotoId(null); setBulkApproveOpen(false); setBulkReturnOpen(false); setBulkFailed([])
    setReviewing(null); setLoadingMore(false)
    const next = photoReviewEntryFrom(window.location.search)
    setEntry(next); setStatus(next.status); setView(next.view)
    setSearchInput(next.q ?? ''); setSearchQuery(next.q ?? '')
    reviewKeys.current.clear(); retryKeys.current.clear()
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(`nen-photo-review:selection:${accountId}`) ?? '[]')
      setSelectedPhotoIds(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [])
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);
 setSelectedPhotoIds([]) }
  }, [accountId, saveErrors]);


  const selectionAccount = useRef(accountId)
  useEffect(() => {
    if (selectionAccount.current !== accountId) { selectionAccount.current = accountId; return }
    if (!accountId) return
    try { window.sessionStorage.setItem(`nen-photo-review:selection:${accountId}`, JSON.stringify(selectedPhotoIds)) } catch (saveFailure) {
      saveErrors.capture(saveFailure) /* 選択操作は続けられる。 */ }
  }, [accountId, selectedPhotoIds, saveErrors])
  useEffect(() => {
    const restore = () => {
      const next = photoReviewEntryFrom(window.location.search)
      setEntry(next); setStatus(next.status); setView(next.view)
      setSearchInput(next.q ?? ''); setSearchQuery(next.q ?? '')
    }
    window.addEventListener('popstate', restore)
    return () => { window.removeEventListener('popstate', restore); loadSequence.current += 1; accountGeneration.current += 1 }
  }, [])
  const navigate = (next: PhotoReviewEntry) => {
    window.history.pushState(null, '', `${window.location.pathname}?${photoReviewSearch(next)}`)
    setEntry(next); setStatus(next.status); setView(next.view)
  }

  const loadMore = useCallback(async () => {
    if (!accountId || loadingMore || !hasMorePhotos) return
    const sequence = loadSequence.current
    setLoadingMore(true)
    try {
      const response = await fetchApi<PhotoPageResponse>(photoPagePath(accountId, photos.length, searchQuery))
      if (sequence !== loadSequence.current) return
      if (!response.success) throw new Error('load_failed')
      setPhotos((current) => [...current, ...response.data])
      setHasMorePhotos(response.data.length === PHOTO_PAGE_SIZE)
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (sequence === loadSequence.current) {
        { if (!fieldFailure)
        setNotice(photoNoticeFor(error, '続きの写真を読み込めませんでした。')) }
      }
    } finally {
      if (sequence === loadSequence.current) setLoadingMore(false)
    }
  }, [accountId, loadingMore, hasMorePhotos, photos.length, searchQuery, saveErrors])

  const counts = {
    pending: photos.filter((photo) => text(photo.status) === 'pending').length,
    adopted: photos.filter((photo) => text(photo.status) === 'adopted').length,
    rejected: photos.filter((photo) => text(photo.status) === 'rejected').length,
  }
  const visiblePhotos = photos.filter((photo) => text(photo.status) === status)
  const countsReady = Boolean(accountId) && !loading && !loadError
  const adoptedThisMonth = photos.filter((photo) => text(photo.status) === 'adopted' && isThisMonth(text(photo.reviewed_at))).length
  const rejectedThisMonth = photos.filter((photo) => text(photo.status) === 'rejected' && isThisMonth(text(photo.reviewed_at)))
  const reasonCounts = (() => {
    const tally = new Map<string, number>()
    for (const photo of rejectedThisMonth) {
      const code = text(photo.review_reason_code)
      if (!code) continue
      tally.set(code, (tally.get(code) ?? 0) + 1)
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])
  })()
  const topReason = reasonCounts[0]?.[0]
    ? REVIEW_REASONS.find((reason) => reason.value === reasonCounts[0][0])?.label ?? '理由未記録'
    : emptyValue('unknown')

  const publicationWindow = usePhotoConfirmWindow(accountId, canEdit)
  const [publicationCandidate, setPublicationCandidate] = useState<{id: string; version: number; key: string} | null>(null)
  const preparePublication = async (id: string) => {
    if (!accountId || !canEdit || reviewing) return
    const generation = accountGeneration.current
    setReviewing(id)
    setNotice('')
    try {
      const detail = await api.nenMembers.photo(id, accountId)
      if (generation !== accountGeneration.current) return
      if (!detail.success) throw new Error(detail.error)
      publicationWindow.open()
      setPublicationCandidate({ id, version: Number(detail.data.publication?.version ?? 0), key: crypto.randomUUID() })
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);
 if (generation === accountGeneration.current) { if (!fieldFailure) setNotice(photoNoticeFor(error, '掲載状態を読み込めませんでした。')) } }
    finally { if (generation === accountGeneration.current) setReviewing(null) }
  }
  const confirmPublication = async () => {
    if (!accountId || !publicationCandidate || reviewing) return
    const generation = accountGeneration.current
    setReviewing(publicationCandidate.id)
    setNotice('')
    try {
      const response = await api.nenMembers.publishPhoto(publicationCandidate.id, { accountId, expectedVersion: publicationCandidate.version }, publicationCandidate.key)
      if (generation !== accountGeneration.current) return
      if (!response.success) throw new Error(response.error)
      publicationWindow.close(); setPublicationCandidate(null)
      notifySaved('公式サイトへの掲載を保存しました。追加報酬の手続き状況は掲載一覧で確認できます。')
      await load()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);
 if (generation === accountGeneration.current) { if (!fieldFailure) setNotice(photoNoticeFor(error, '掲載できませんでした。掲載状態と同意を読み直してください。')) } }
    finally { if (generation === accountGeneration.current) setReviewing(null) }
  }
  useEffect(() => { setPublicationCandidate(null) }, [accountId])

  const review = async (
    id: string,
    nextStatus: 'adopted' | 'rejected',
    rejection?: { reasonCode: ReviewReasonCode; reasonNote: string; resubmitInvite: boolean; watchSubmitter: boolean },
  ) => {
    if (!accountId || !canEdit) return
    const generation = accountGeneration.current
    const idempotencyKey = reviewKeys.current.get(id) ?? crypto.randomUUID()
    reviewKeys.current.set(id, idempotencyKey)
    setReviewing(id)
    try {
      const response = await api.nenMembers.reviewPhoto(id, {
        accountId,
        status: nextStatus,
        expectedVersion: reviewVersionOf(photos.find((photo) => text(photo.id) === id) ?? (text(rejectingPhoto?.id) === id ? rejectingPhoto : null)),
        ...(rejection
          ? {
              reasonCode: rejection.reasonCode,
              reasonNote: rejection.reasonNote,
              resubmitInvite: rejection.resubmitInvite,
              watchSubmitter: rejection.watchSubmitter,
            }
          : {}),
      }, idempotencyKey)
      if (generation !== accountGeneration.current) return
      if (!response.success) throw new Error(response.error)
      reviewKeys.current.delete(id)
      setNotice('')
      const notification = response.data.notificationStatus === 'sent'
        ? '投稿者へLINEで通知しました。'
        : '審査結果は保存しましたが、LINE通知は送れませんでした。一覧から再送できます。'
      /*
       * マイルの手続きは EC 会員とつながっている採用だけで始まる。
       * つながっていない採用に「手続きを始めました」と伝えるのは、
       * できていない約束をすることになる（#931 N-307）。
       */
      const adoptedNote = response.data.rewardSkipped === 'duplicate'
        ? '同じ写真はすでに報酬付きで採用されているため、点数は付けずに採用しました。'
        : response.data.rewardSkipped === 'requested'
          ? '報酬なしで採用しました。点数は付けていません。'
          : response.data.pointSync === 'pending'
            ? `ECへ${response.data.awardedPoints}マイルを付ける手続きを始めました。`
            : response.data.pointSync === 'needs_attention'
              ? 'EC会員とつながっていないため、マイルの手続きはまだ始まっていません。'
              : ''
      notifySaved(nextStatus === 'adopted'
        ? `写真を採用しました。${adoptedNote}公開は本人の同意がある場合だけ行います。${notification}`
        : `見送り理由を保存しました。${notification}`)
      rejectWindow.close(); setRejectingPhotoId(null)
      await load()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (generation === accountGeneration.current) {
        const message = photoNoticeFor(error, '審査結果を保存できませんでした。')
        { if (!fieldFailure)
        setNotice(message) }
        // WEB225：見送りの窓が開いたままなら、失敗の理由を窓の中に出す（裏の一覧にだけ出さない）。
        if (nextStatus === 'rejected') { if (!fieldFailure) setReasonError(message) }
        if (error instanceof ApiError && error.status === 409) {
          reviewKeys.current.delete(id)
          await load()
        }
      }
    } finally { setReviewing(null) }
  }

  const rejectWindow = usePhotoConfirmWindow(accountId, canEdit)
  const [rejectingPhotoId, setRejectingPhotoId] = useState<string | null>(null)
  const [rejectingPhoto, setRejectingPhoto] = useState<Record<string, unknown> | null>(null)
  const [bulkApproveOpen, setBulkApproveOpen] = useState(false)
  const [bulkReturnOpen, setBulkReturnOpen] = useState(false)
  const [bulkReviewing, setBulkReviewing] = useState(false)
  const [reasonCode, setReasonCode] = useState<ReviewReasonCode>('quality')
  const [reasonNote, setReasonNote] = useState('')
  const [reasonError, setReasonError] = useState('')
  const [reasonFieldError, setReasonFieldError] = useState('')
  const [resubmitInvite, setResubmitInvite] = useState(true)
  const [watchSubmitter, setWatchSubmitter] = useState(false)

  const openRejectDialog = (id: string) => {
    rejectWindow.open()
    setRejectingPhotoId(id)
    setRejectingPhoto(photos.find((photo) => text(photo.id) === id) ?? null)
    if (accountId && !photos.some((photo) => text(photo.id) === id)) {
      const generation = accountGeneration.current
      void api.nenMembers.photo(id, accountId).then((response) => {
        if (generation === accountGeneration.current && response.success && !Array.isArray(response.data)) setRejectingPhoto(response.data)
      }).catch(() => undefined)
    }
    setReasonCode('quality')
    setReasonNote('')
    setReasonError(''); setReasonFieldError('')
    setResubmitInvite(true)
    setWatchSubmitter(false)
  }

  const readAllPhotos = useCallback(async () => {
    if (!accountId) return
    const sequence = loadSequence.current
    setAllPhotosLoading(true)
    setAllPhotosError('')
    try {
      const rows = await collectUncountedListRows(PHOTO_PAGE_SIZE, async (offset) => {
        const response = await fetchApi<PhotoPageResponse>(photoPagePath(accountId, offset, searchQuery))
        if (!response.success) throw new Error('load_failed')
        return response.data.map(photo => ({ ...photo, id: text(photo.id) }))
      })
      if (sequence === loadSequence.current) setAllPhotoRows(rows)
    } catch {
      if (sequence === loadSequence.current) setAllPhotosError('すべての写真を読み込めませんでした。')
    } finally {
      if (sequence === loadSequence.current) setAllPhotosLoading(false)
    }
  }, [accountId, searchQuery])

  useEffect(() => {
    if (loading || selectedPhotoIds.length === 0 || allPhotoRows || allPhotosLoading || allPhotosError) return
    if (!hasMorePhotos) setAllPhotoRows(photos)
    else void readAllPhotos()
  }, [loading, selectedPhotoIds.length, allPhotoRows, allPhotosLoading, allPhotosError, hasMorePhotos, photos, readAllPhotos])

  const selectAllPendingPhotos = () => {
    if (!allPhotoRows) return
    setPhotos(allPhotoRows)
    setHasMorePhotos(false)
    setSelectedPhotoIds(allPhotoRows.filter(photo => text(photo.status) === 'pending').map(photo => text(photo.id)))
  }

  const pendingPhotos = photos.filter((photo) => text(photo.status) === 'pending')
  const selectedPendingPhotos = pendingPhotos.filter((photo) => selectedPhotoIds.includes(text(photo.id)))
  const bulkScope = useRef({ accountId, canEdit })
  if (bulkScope.current.accountId !== accountId || bulkScope.current.canEdit !== canEdit) bulkScope.current = { accountId, canEdit }
  const bulkTicket = useRef<{ kind: 'approve' | 'return'; scope: typeof bulkScope.current; signature: string } | null>(null)
  const bulkBusy = useRef(false)
  const bulkSignature = JSON.stringify(selectedPendingPhotos.map(photo => [text(photo.id), reviewVersionOf(photo)]))
  const bulkLive = useRef({ accountId, signature: bulkSignature, canEdit })
  bulkLive.current = { accountId, signature: bulkSignature, canEdit }
  const renderedBulkTicket = bulkTicket.current
  const validBulkTicket = (kind: 'approve' | 'return') => Boolean(renderedBulkTicket && bulkTicket.current === renderedBulkTicket && renderedBulkTicket.kind === kind && renderedBulkTicket.scope === bulkScope.current && renderedBulkTicket.signature === bulkLive.current.signature && bulkLive.current.canEdit && !bulkBusy.current)
  useEffect(() => () => { bulkTicket.current = null }, [])
  const selectedPhotosAreLowRisk = selectedPendingPhotos.length > 0
    && selectedPendingPhotos.every((photo) => ['safe', 'none', 'low'].includes(text(photo.latest_risk_flag)))

  const togglePhotoSelection = (id: string) => {
    setSelectedPhotoIds((current) => current.includes(id)
      ? current.filter((photoId) => photoId !== id)
      : [...current, id])
  }

  const bulkReview = async (
    decision: 'approve' | 'return',
    rejection?: { reasonCode: ReviewReasonCode; reasonNote: string },
  ) => {
    if (!accountId || selectedPendingPhotos.length === 0 || bulkBusy.current) return
    bulkBusy.current = true
    const generation = accountGeneration.current
    setBulkReviewing(true)
    try {
      const response = await api.nenMembers.bulkReviewPhotos({
        lineAccountId: accountId,
        decisions: selectedPendingPhotos.map((photo) => ({
          photoId: text(photo.id),
          decision,
          expectedVersion: reviewVersionOf(photo),
          reasonCode: rejection?.reasonCode ?? null,
          reasonNote: rejection?.reasonNote || null,
        })),
      }, crypto.randomUUID())
      if (generation !== accountGeneration.current) return
      if (!response.success) throw new Error(response.error)
      const data = response.data as Partial<PhotoBulkReviewResult>
      const count = typeof data.updatedCount === 'number' ? data.updatedCount : selectedPendingPhotos.length
      const names = new Map(selectedPendingPhotos.map((photo) => [text(photo.id), photoPetDisplayName(photo.pet_name, { callName: photo.pet_call_name, gender: photo.pet_gender })]))
      const failed = Array.isArray(data.notificationFailures) ? data.notificationFailures : []
      const failedPhotos = failed.map((item) => {
        const photoId = text((item as { photoId?: unknown })?.photoId)
        const error = text((item as { error?: unknown })?.error) || '通知できませんでした'
        return { photoId, petName: names.get(photoId) ?? '写真', error }
      }).filter((item) => item.photoId)
      setBulkFailed(failedPhotos)
      if (failedPhotos.length === 0) {
        notifySaved(`${formatNumber(count)}枚の審査結果を保存し、投稿者へLINEで通知しました。`)
      } else {
        setNotice(`${formatNumber(count)} 枚の審査結果は保存済みです。${formatNumber(failedPhotos.length)} 枚のLINE通知は送れませんでした（通知だけ再送できます）。`)
      }
      setSelectedPhotoIds([])
      bulkTicket.current = null
      setBulkApproveOpen(false)
      setBulkReturnOpen(false)
      setReasonCode('quality')
      setReasonNote('')
      setReasonError(''); setReasonFieldError('')
      await load()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (generation === accountGeneration.current) {
        const message = photoNoticeFor(error, 'まとめて審査できませんでした。')
        { if (!fieldFailure)
        setNotice(message) }
        // WEB225：まとめて見送りの窓の中にも出す。
        if (decision === 'return') { if (!fieldFailure) setReasonError(message) }
      }
    } finally {
      bulkBusy.current = false
      setBulkReviewing(false)
    }
  }

  const retryNotification = async (id: string) => {
    if (!accountId || !canEdit) return
    const generation = accountGeneration.current
    const idempotencyKey = retryKeys.current.get(id) ?? crypto.randomUUID()
    retryKeys.current.set(id, idempotencyKey)
    setReviewing(id)
    try {
      const response = await api.nenMembers.retryPhotoReviewNotification(id, accountId, idempotencyKey)
      if (generation !== accountGeneration.current) return
      if (!response.success) throw new Error(response.error)
      retryKeys.current.delete(id)
      setBulkFailed((items) => items.filter((item) => item.photoId !== id))
      setNotice('審査結果を投稿者へLINEで再送しました。')
      await load()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (generation === accountGeneration.current) {
        { if (!fieldFailure)
        setNotice(describeApiFailure(error, '保存')) }
      }
    } finally {
      setReviewing(null)
    }
  }

  const changeTab = (next: PhotoStatus | 'publications') => {
    if (next === 'publications') {
      navigate({ view: 'publications', status })
      return
    }
    navigate({ view: 'list', status: next, q: searchQuery || undefined })
    setSelectedPhotoIds([])
    setBulkApproveOpen(false)
    setBulkReturnOpen(false)
  }

  const tabLabel = (base: string, count: number) => (!countsReady ? base : hasMorePhotos ? `${base} ${count}+` : `${base} ${count}`)


  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      boardId={boardNode(view, status, canEdit)}
      headingSize="regular"
      title="投稿"
      help={<PhotoReviewHelp pending={`まだ決めていない写真の枚数です。注意候補 ${reviewMetrics?.attentionCount ?? emptyValue('unknown')}件・投稿から審査までの日数：${reviewMetrics?.averageReviewMinutes == null ? emptyValue('unknown') : formatMinutesRough(reviewMetrics.averageReviewMinutes)}`}
        adopted={hasMorePhotos ? '読み込んだ写真の集計です。続きの写真は含みません' : '今月 採用した写真の枚数です'}
        rejected={hasMorePhotos ? '読み込んだ写真の集計です。理由の内訳も続きの写真は含みません' : '今月 見送った写真の枚数です'} />}
      actions={<Button type="button" variant="secondary" onClick={() => setHistoryOpen(true)}><History size={16} aria-hidden="true" />版の履歴を見る</Button>}
      tabs={
        <div className={styles.tabs} data-design-node="photo-tabs-v8">
          <Tabs
            label="投稿の状態"
            items={[
              { label: tabLabel('審査待ち', counts.pending), current: view === 'list' && status === 'pending', onClick: () => changeTab('pending') },
              { label: tabLabel('採用', counts.adopted), current: view === 'list' && status === 'adopted', onClick: () => changeTab('adopted') },
              { label: tabLabel('見送り', counts.rejected), current: view === 'list' && status === 'rejected', onClick: () => changeTab('rejected') },
              { label: '公式サイト掲載', current: view === 'publications', onClick: () => changeTab('publications') },
            ]}
          />
        </div>
      }
      stats={
        <>
          {!canEdit ? (
            <div className={styles.viewerRow}>
              <ReadOnlyNotice role="status" data-design-node="photo-viewer-band">閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice>
            </div>
          ) : null}
          <div className={styles.stats}>
            <KpiBand data-design="KPIs" aria-label="投稿の数の帯">
              <KpiCard presentation="band" title="審査待ち" icon={<History size={16} aria-hidden="true" />}
                value={countsReady ? reviewMetrics?.pendingCount ?? counts.pending : null} unit="枚"
                detail={reviewMetrics?.oldestPendingAt ? `いちばん古いもの ${formatWaitRough((Date.now() - Date.parse(reviewMetrics.oldestPendingAt)) / 60000)}` : 'いちばん古いもの —'} />
              <KpiCard presentation="band" title="今月 採用" icon={<HelpCircle size={16} aria-hidden="true" />}
                value={countsReady ? adoptedThisMonth : null} unit={hasMorePhotos ? '枚以上' : '枚'}
                detail={policyPoints == null ? '1 枚ごとに —' : `1 枚ごとに ${formatNumber(policyPoints)} マイル`} />
              <KpiCard presentation="band" title="今月 見送り" icon={<HelpCircle size={16} aria-hidden="true" />}
                value={countsReady ? rejectedThisMonth.length : null} unit={hasMorePhotos ? '枚以上' : '枚'}
                detail={`理由：${topReason}`} />
              <KpiCard presentation="band" title="公式サイト掲載" icon={<Undo2 size={16} aria-hidden="true" />}
                value={publishedCount} unit={publishedCount == null ? '' : '枚'} detail="いま載っている写真" />
            </KpiBand>
          </div>
        </>
      }
      overlays={
        <>
          {rejectingPhotoId ? (
            <RejectDialogV8
              accountId={accountId ?? ''}
              photo={rejectingPhoto}
              reasonCode={reasonCode}
              reasonNote={reasonNote}
              reasonError={reasonError}
              reasonFieldError={reasonFieldError}
              resubmitInvite={resubmitInvite}
              watchSubmitter={watchSubmitter}
              busy={reviewing !== null}
              onReasonCode={(next) => { setReasonCode(next); setReasonFieldError('') }}
              onReasonNote={(next) => { setReasonNote(next); setReasonFieldError('') }}
              onResubmitInvite={setResubmitInvite}
              onWatchSubmitter={setWatchSubmitter}
              onClose={() => { rejectWindow.close(); setRejectingPhotoId(null); setReasonError(''); setReasonFieldError('') }}
              onConfirm={() => {
                if (!rejectWindow.valid()) return
                if (reasonCode === 'other' && !reasonNote.trim()) { setReasonFieldError('そのほかの理由を入力してください'); focusFormField('photo-reject-note'); return }
                return review(rejectingPhotoId, 'rejected', { reasonCode, reasonNote: reasonNote.trim(), resubmitInvite, watchSubmitter })
              }}
            />
          ) : null}

          <Dialog open={bulkApproveOpen} title={`${formatNumber(selectedPendingPhotos.length)}枚をまとめて採用`} description="選択した写真の件数、マイル、公開範囲を確認してください。" busy={bulkReviewing} confirmLabel="まとめて採用" cancelLabel="審査へ戻る" onCancel={() => { bulkTicket.current = null; setBulkApproveOpen(false) }} onConfirm={() => validBulkTicket('approve') ? bulkReview('approve') : undefined}>
            <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
            <dl className={styles.bulkSummary}>
              <div><dt>写真</dt><dd>{formatNumber(selectedPendingPhotos.length)}枚</dd></div>
              <div><dt>付与するマイル</dt><dd>合計 {policyPoints == null ? emptyValue('unknown') : `${formatNumber(selectedPendingPhotos.length * policyPoints)} マイル`}</dd></div>
              <div><dt>公開範囲</dt><dd>公開しない</dd></div>
            </dl>
            <p className={styles.railNote}>写真を採用しても自動公開しません。本人の公開同意を確認したあと、公式サイト掲載画面で公開先を選びます。</p>
          </Dialog>
          <Dialog open={bulkReturnOpen} title={`${formatNumber(selectedPendingPhotos.length)} 枚をまとめて見送り`} description="選んだ理由と補足は、選択した写真すべてに記録され、投稿者へLINEで届きます。" tone="destructive" busy={bulkReviewing} error={reasonError} confirmLabel="この理由でまとめて見送り" cancelLabel="審査へ戻る" onCancel={() => { bulkTicket.current = null; setBulkReturnOpen(false); setReasonError(''); setReasonFieldError('') }} onConfirm={() => {
            if (!validBulkTicket('return')) return
            if (reasonCode === 'other' && !reasonNote.trim()) { setReasonFieldError('そのほかの理由を入力してください'); focusFormField('photo-reject-note'); return }
            return bulkReview('return', { reasonCode, reasonNote: reasonNote.trim() })
          }}>
            <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
            <div role="radiogroup" aria-label="見送り理由" className={styles.pillGroup}>
              {REVIEW_REASONS.map((reason) => (
                <SaveErrorField names={["photo-reject-reason","reasonCode","value","reason.value"]} key={reason.value}><Radio key={reason.value} name="photo-reject-reason" checked={reasonCode === reason.value} onChange={() => { setReasonCode(reason.value); setReasonError(''); setReasonFieldError('') }}>{reason.label}</Radio></SaveErrorField>
              ))}
            </div>
            <Field label="投稿者に届く補足（直せます）"><SaveErrorField names={["reasonNote","reason_note"]}><TextArea id="photo-reject-note" size="short" invalid={Boolean(reasonFieldError)} aria-describedby={reasonFieldError ? 'photo-reject-note-error' : undefined} value={reasonNote} onChange={(event) => { setReasonNote(event.target.value.slice(0, 500)); setReasonError(''); setReasonFieldError('') }} rows={3} placeholder={reasonCode === 'other' ? '理由を入力してください' : '必要な場合だけ入力します'} /></SaveErrorField>
<FieldError id="photo-reject-note-error">{reasonFieldError}</FieldError></Field>
          </Dialog>

          <Dialog open={Boolean(publicationCandidate)} title="公式サイトに掲載しますか？"
            description="公開の同意と採用状態を確認して、公開用画像を掲載します。追加報酬は初回掲載の版で写真ごとに一度だけ手続きします。"
            confirmLabel="公式サイトに掲載する" error={notice} busy={Boolean(reviewing)} onConfirm={() => publicationWindow.valid() ? confirmPublication() : undefined}
            onCancel={() => { if (!reviewing) { publicationWindow.close(); setPublicationCandidate(null) } }}>
            <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
          </Dialog>
          <PhotoPolicyHistoryV8 canEdit={canEdit}
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            onChanged={() => void load()}
          />
        </>
      }
    >
      {bulkFailed.length > 0 ? <section className={styles.deliveryFailures} aria-label="LINE通知を送れなかった写真"><p>LINE通知を送れなかった写真（{formatNumber(bulkFailed.length)} 枚）・通知だけ再送できます</p>{bulkFailed.map((item) => <div key={item.photoId}><span>{item.petName}</span>{canEdit ? <Button variant="secondary" disabled={reviewing !== null} onClick={() => void retryNotification(item.photoId)}>LINE通知を再送</Button> : null}</div>)}</section> : null}
      {!accountId ? (
        <div className={styles.stateBox}>
          <ListState
            kind="empty"
            title="LINEアカウントを選んでください"
            description="上のバーから、写真審査を行うLINEアカウントを選びます。"
          />
        </div>
      ) : view === 'publications' ? (
        <div className={styles.pubBody}>
          <PublicationsV8
            accountId={accountId}
            canEdit={canEdit}
            publishedCount={publishedCount}
            onChanged={() => void load()}
          />
        </div>
      ) : view === 'detail' ? (
        <div className={styles.pubBody}>
          <DetailV8
            key={accountId}
            accountId={accountId}
            initialPhotoId={entry.photoId}
            canEdit={canEdit}
            onPhotoChange={(photoId) => navigate({ view: 'detail', status, photoId, q: searchQuery || undefined })}
            onReject={(id) => { setView('list'); openRejectDialog(id) }}
            photos={visiblePhotos}
            onBack={() => navigate({ view: 'list', status, q: searchQuery || undefined })}
            onReload={() => void load()}
          />
        </div>
      ) : (
        <ReviewListV8
          accountId={accountId}
          status={status}
          photos={visiblePhotos}
          loading={loading}
          loadError={loadError}
          loadForbidden={loadForbidden}
          canEdit={canEdit}
          reviewing={reviewing}
          notice={notice}
          searchInput={searchInput}
          searchQuery={searchQuery}
          hasMorePhotos={hasMorePhotos}
          loadingMore={loadingMore}
          policyPoints={policyPoints}
          publicationPoints={publicationPoints}
          reasonCounts={reasonCounts}
          selectedPhotoIds={selectedPhotoIds}
          selectedPendingCount={selectedPendingPhotos.length}
          totalPendingCount={allPhotoRows?.filter(photo => text(photo.status) === 'pending').length}
          allPhotosLoading={allPhotosLoading}
          allPhotosError={allPhotosError}
          onRetryAllPhotos={() => void readAllPhotos()}
          onSelectAllPending={selectAllPendingPhotos}
          selectedPhotosAreLowRisk={selectedPhotosAreLowRisk}
          bulkReviewing={bulkReviewing}
          onSearchInput={setSearchInput}
          onSearchQuery={(q) => { setSearchQuery(q); navigate({ view: 'list', status, q: q || undefined }); }}
          onToggleSelect={togglePhotoSelection}
          onClearSelection={() => setSelectedPhotoIds([])}
          onApprove={(id) => void review(id, 'adopted')}
          onReject={openRejectDialog}
          onRetryNotification={(id) => void retryNotification(id)}
          onOpenDetail={() => navigate({ view: 'detail', status, photoId: text(visiblePhotos[0]?.id), q: searchQuery || undefined })}
          onOpenPublications={() => navigate({ view: 'publications', status })}
          onPublish={(id) => void preparePublication(id)}
          onLoadMore={() => void loadMore()}
          onRetryLoad={() => void load()}
          onBulkApprove={() => { bulkTicket.current = { kind: 'approve', scope: bulkScope.current, signature: bulkSignature }; setBulkApproveOpen(true) }}
          onBulkReturn={() => { bulkTicket.current = { kind: 'return', scope: bulkScope.current, signature: bulkSignature }; setBulkReturnOpen(true) }}
        />
      )}
    </ListPage></SaveErrorScope>
  )
}


type PublicationItem = Record<string, unknown> & { placements?: Array<Record<string, unknown>> }

function placementLabels(item: PublicationItem): string {
  const placements = Array.isArray(item.placements) ? item.placements : []
  const active = placements.filter((p) => Number(p.active ?? 1) === 1)
  if (active.length === 0) return 'どこにも出していません'
  return active.map((p) => text(p.placement_label) || text(p.placement_type)).join('・')
}

function viewsText(value: unknown): string {
  return value == null ? emptyValue('unknown') : `${formatNumber(Number(value))}`
}

/**
 * 公式サイト掲載。列：写真・ペット・どこで使っているか・
 * 過去30日に見た・公開の同意・掲載先から外す。右に出すときの決めごと。
 * 30日集計は日別の記録から表示し、記録がなければ「—」。掲載先の編集・撤回の整理・外した履歴を保つ。
 */
function PublicationsV8({
  accountId,
  canEdit,
  publishedCount,
  onChanged,
}: {
  accountId: string
  canEdit: boolean
  publishedCount: number | null
  onChanged: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const [rulesOpen, setRulesOpen] = useState(false)
  const withdrawWindow = usePhotoConfirmWindow(accountId, canEdit)
  const placementWindow = usePhotoConfirmWindow(accountId, canEdit)
  const [withdrawTarget, setWithdrawTarget] = useState<PublicationItem | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading')
  const [items, setItems] = useState<PublicationItem[]>([])
  const [orderItems, setOrderItems] = useState<PublicationItem[] | null>(null)
  const [topPhotoId, setTopPhotoId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [pendingWithdrawals, setPendingWithdrawals] = useState<PublicationItem[]>([])
  const [withdrawnItems, setWithdrawnItems] = useState<PublicationItem[]>([])
  const [editing, setEditing] = useState<PublicationItem | null>(null)
  const [selectedPlacements, setSelectedPlacements] = useState<string[]>([])
  const generation = useRef(0)
  const loadSequence = useRef(0)
  const placementChoices = [{ type: 'site', label: 'サイト' }, { type: 'column', label: 'NENコラム' }, { type: 'rich_menu', label: 'リッチメニュー' }, { type: 'form', label: '回答フォーム' }] as const
  const openPlacements = (item: PublicationItem) => {
    placementWindow.open(); setEditing(item); setNotice('')
    setSelectedPlacements((item.placements ?? []).filter((placement) => Number(placement.active ?? 1) === 1).map((placement) => text(placement.placement_type)))
  }
  const savePlacements = async () => {
    if (!editing || !canEdit || busyId) return
    const accountGeneration = generation.current
    setBusyId(text(editing.id)); setNotice('')
    try {
      const response = await api.nenMembers.updatePhotoPublicationPlacements(text(editing.id), {
        accountId, expectedVersion: Number(editing.version), placements: placementChoices.filter((choice) => selectedPlacements.includes(choice.type)),
      }, crypto.randomUUID())
      if (accountGeneration !== generation.current) return
      if (!response.success) throw new Error(response.error)
      placementWindow.close(); setEditing(null); await load(); onChanged()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);
 if (accountGeneration === generation.current) { if (!fieldFailure) setNotice('使う場所を保存できませんでした。最新の状態を読み直してください。') } }
    finally { if (accountGeneration === generation.current) setBusyId('') }
  }


  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setState('loading')
    try {
      const response = await api.nenMembers.photoPublications(accountId)
      if (sequence !== loadSequence.current) return
      if (!response.success) throw new Error(response.error)
      if (Array.isArray(response.data)) {
        setItems([])
        setTopPhotoId(null)
      } else {
        setItems(response.data.items ?? [])
        setPendingWithdrawals(response.data.pendingWithdrawals ?? [])
        setWithdrawnItems(response.data.withdrawnItems ?? [])
        setTopPhotoId(response.data.summary.topPhoto30Days ? text(response.data.summary.topPhoto30Days.id) : null)
      }
      setState('ready')
    } catch (error) {
      if (sequence !== loadSequence.current) return
      const fieldFailure = saveErrors.capture(error)
      setItems([])
      { if (!fieldFailure)
      setState(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }
  }, [accountId, saveErrors])

  useEffect(() => { void load(); return () => { generation.current += 1; loadSequence.current += 1 } }, [load])

  const withdraw = async (item: PublicationItem) => {
    if (!canEdit || busyId) return
    const accountGeneration = generation.current
    setBusyId(text(item.id))
    setNotice('')
    try {
      const response = await api.nenMembers.withdrawPhotoPublication(text(item.id), {
        accountId, expectedVersion: Number(item.version),
      }, crypto.randomUUID())
      if (accountGeneration !== generation.current) return
      if (!response.success) throw new Error(response.error)
      withdrawWindow.close(); setWithdrawTarget(null)
      notifyToast('写真をすべての掲載先から外しました。審査と同意の履歴、付与済みのマイルは残ります。')
      await load()
      onChanged()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure)
      setNotice(error instanceof ApiError && error.status === 409
        ? '別の人が先に掲載状態を変更しました。最新の状態を読み直してください。'
        : '写真を掲載先から外せませんでした。') }
    } finally { setBusyId('') }
  }

  const openOrder = async () => {
    if (!canEdit || busyId) return
    const token = generation.current
    setBusyId('order-load')
    try {
      const response = await api.nenMembers.photoPublicationOrder(accountId)
      if (token !== generation.current) return
      if (!response.success) throw new Error(response.error)
      setOrderItems(response.data.items)
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);
 if (token === generation.current) { if (!fieldFailure) setNotice(photoNoticeFor(error, '掲載順を読み込めませんでした。')) } }
    finally { if (token === generation.current) setBusyId('') }
  }
  const moveOrder = (index: number, delta: number) => {
    setOrderItems((current) => {
      if (!current || index+delta < 0 || index+delta >= current.length) return current
      const copy = [...current]; [copy[index], copy[index+delta]] = [copy[index+delta], copy[index]]
      return copy
    })
  }
  const saveOrder = async () => {
    if (!orderItems || busyId) return
    const token = generation.current
    setBusyId('order')
    setNotice('')
    try {
      const response = await api.nenMembers.savePhotoPublicationOrder({ accountId, items: orderItems.map(item => ({ id: text(item.id), expectedVersion: Number(item.version) })) })
      if (token !== generation.current) return
      if (!response.success) throw new Error(response.error)
      setOrderItems(null)
      setBusyId('')
      notifySaved('掲載順を保存しました。')
      await load()
      onChanged()
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (token === generation.current) { if (!fieldFailure) setNotice(error instanceof ApiError && error.status === 409
        ? '掲載の集合か版が変わりました。キャンセルして最新の全件を読み直してください。'
        : '掲載順を保存できませんでした。時間をおいて、もう一度お試しください。') }
    } finally { if (busyId === 'order' || token === generation.current) setBusyId('') }
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
      <ConfirmDialog open={withdrawTarget !== null} title="この写真を掲載先から外しますか？"
        description="すべての掲載先から外します。審査と公開同意の履歴、付与済みのマイルは残ります。"
        confirmLabel="掲載先から外す" busy={Boolean(busyId)} error={notice || undefined}
        onCancel={() => { if (!busyId) { withdrawWindow.close(); setWithdrawTarget(null); setNotice('') } }}
        onConfirm={() => { if (withdrawTarget && withdrawWindow.valid()) void withdraw(withdrawTarget) }}>
        <OperationTargetSummary accounts={[{ id: accountId }]} />
      </ConfirmDialog>
      <Dialog open={orderItems !== null} title="掲載順を変える" description="上から順に公式サイトへ表示します。全件と確認した版をまとめて保存します。"
        confirmLabel="並び順を保存する" error={notice} busy={busyId === 'order'} onConfirm={() => saveOrder()}
        onCancel={() => { if (!busyId) { setOrderItems(null); void load() } }}>
        <ol>{orderItems?.map((item, index) => <li key={text(item.id)} className={styles.orderRow}>
          <span className={styles.orderName}>{index+1}・{photoPetDisplayName(item.pet_name, { honorific: false })}</span>
          <span className={styles.orderButtons}><Button disabled={index === 0 || Boolean(busyId)} title={busyId ? '処理が終わるまでお待ちください' : index === 0 ? 'これより上には移動できません' : undefined} aria-label={`${text(item.pet_name)}を上へ`} onClick={() => moveOrder(index,-1)}>上へ</Button>
          <Button disabled={index === orderItems.length-1 || Boolean(busyId)} title={busyId ? '処理が終わるまでお待ちください' : index === orderItems.length-1 ? 'これより下には移動できません' : undefined} aria-label={`${text(item.pet_name)}を下へ`} onClick={() => moveOrder(index,1)}>下へ</Button></span>
        </li>)}</ol>
      </Dialog>
      {notice && !withdrawTarget && !editing && !orderItems ? <Notice tone="danger" message={notice} /> : null}
      {state === 'loading' ? (
        <ListState kind="loading" title="公式サイト掲載中の写真を読み込んでいます" />
      ) : state === 'forbidden' ? (
        <ListState kind="forbidden" />
      ) : state === 'error' ? (
        <ListState kind="error" title="公式サイト掲載中の写真を読み込めませんでした" onRetry={() => void load()} />
      ) : items.length === 0 && pendingWithdrawals.length === 0 && withdrawnItems.length === 0 ? (
        <ListState kind="empty" emptyPreset="readonly" title="公式サイト掲載中の写真はありません" description="同意のある写真を掲載すると、使っている場所と表示回数がここに出ます。" />
      ) : (
        <DetailColumns presentation="card" asideLabel="出すときの決めごと" expanded={rulesOpen} onExpandedChange={setRulesOpen}
          aside={<PublicationRules canEdit={canEdit} busy={Boolean(busyId)} onOrder={() => void openOrder()} />}>
          <section data-design-node="photo-pubs-table-v8">
            <div className={styles.tableWrap}>
              <DataTable columnSizing="content" columnLayout={{ headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--polish-space-field)', padding: '0 var(--polish-space-card)', collapseScope: 'page' }}>
                <thead>
                  <TableHeadRow data-table-layout="columns">
                    <Th>写真</Th>
                    <Th grow>ペット</Th>
                    <Th help="この写真を使っている掲載先です。複数の場所は行にまとめて表示します。">掲載先</Th>
                    <Th align="right"><span title="30日間の集計は未接続です。累計の回数には置き換えません">過去30日に見た</span></Th>
                    <Th>公開の同意</Th>
                    <Th align="right">操作</Th>
                  </TableHeadRow>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const imageSrc = safePhotoSrc(item.image_url)
                    const name = photoPetDisplayName(item.pet_name, { fallback: 'ペット名未取得', honorific: false })
                    const consented = Boolean(text(item.publication_consent_at)) && !text(item.publication_withdrawn_at)
                    return (
                      <Tr key={text(item.id)} data-table-layout="columns">
                        <Td>
                          {imageSrc ? (
                            // eslint-disable-next-line @next/next/no-img-element -- 掲載中の公開写真
                            <img width={56} height={56} src={imageSrc} alt={`${name}の公開写真`} loading="lazy" className={styles.pubThumb} />
                          ) : (
                            <span aria-hidden="true" className={styles.pubThumb} />
                          )}
                        </Td>
                        <Td grow>
                          <span className={styles.pubNameRow}>
                            <span className={styles.petNameV8}>{name}</span>
                            {topPhotoId === text(item.id) ? <Chip tone="info">いちばん見られた</Chip> : null}
                          </span>
                          <span className={styles.petSubV8}>{Number(item.hide_owner_name) === 0 ? '名前を出しています' : '名前は伏せています'}</span>
                        </Td>
                        <Td><span className={styles.pubCell} title={placementLabels(item)}>{placementLabels(item)}</span></Td>
                        <Td align="right" data-list-number>{viewsText(item.view_count_30_days)}</Td>
                        <Td><StatusBadge tone={consented ? 'success' : 'neutral'} size="compact">{consented ? '同意あり' : '未取得'}</StatusBadge></Td>
                        <ActionCell>
                          {canEdit ? <RowActions subjectName={name}
                            detail={{ label: busyId === text(item.id) ? '外しています…' : '掲載先から外す', disabled: busyId === text(item.id), onClick: () => { setNotice(''); withdrawWindow.open(); setWithdrawTarget(item) } }}
                            menuItems={[{ id: 'placements', label: '使う場所', onSelect: () => openPlacements(item) }]} /> : null}
                        </ActionCell>
                      </Tr>
                    )
                  })}
                </tbody>
              </DataTable>
            </div>
            <p className={styles.listHint}>{`公式サイト掲載中 ${publishedCount ?? emptyValue('unknown')}枚のうち ${formatNumber(items.length)}枚を表示（使っている場所で絞る：サイト・NENコラム・リッチメニュー・回答フォーム・登録メディア）`}</p>
            <Disclosure className={styles.publicationHistory} appearance="inset" size="compact" title={`掲載の整理と外した履歴（${pendingWithdrawals.length + withdrawnItems.length}件）`}>
              {pendingWithdrawals.map((item) => <div className={styles.publicationHistoryItem} key={text(item.id)}><strong>{text(item.pet_name) || '写真'}</strong><p>{text(item.publication_withdrawn_at) ? 'ご本人が公開の同意を撤回しました' : '公開の同意と採用状態を確認してください'}</p><p>まだ残っている掲載先：{placementLabels(item)}</p>{canEdit ? <Button variant="secondary" disabled={Boolean(busyId)} onClick={() => { setNotice(''); withdrawWindow.open(); setWithdrawTarget(item) }} busy={Boolean(busyId)} busyLabel="処理中…">掲載先から外す</Button> : null}</div>)}
              {withdrawnItems.map((item) => <div className={styles.publicationHistoryItem} key={text(item.id)}><strong>{text(item.pet_name) || '写真'}</strong><p>外した日時：{formatPhotoReceivedAt(item.withdrawn_at)}・{text(item.withdrawn_by_name) || '—'}</p>{(item.placements ?? []).map((placement) => <p key={text(placement.id)}>{text(placement.placement_label)}・{text(placement.removed_at) ? `${formatPhotoReceivedAt(placement.removed_at)}に外しました` : '記録あり'}</p>)}</div>)}
            </Disclosure>
          </section>
        </DetailColumns>
      )}
      <Dialog open={Boolean(editing)} title="使う場所" description="同意のある写真の掲載先を選びます。原本は公開しません。" busy={Boolean(busyId)} error={notice} confirmLabel="保存する" onCancel={() => { if (!busyId) { placementWindow.close(); setEditing(null) } }} onConfirm={() => placementWindow.valid() ? savePlacements() : undefined}>
        <OperationTargetSummary accounts={[{ id: accountId }]} />
        {placementChoices.map((choice, saveFieldIndex) => <SaveErrorField names={[`placementChoices.${saveFieldIndex}.type`,"type","choice.type","selectedPlacements","selected_placements"]} key={choice.type}><Checkbox key={choice.type} checked={selectedPlacements.includes(choice.type)} onCheckedChange={(checked) => setSelectedPlacements((current) => checked ? [...current, choice.type] : current.filter((type) => type !== choice.type))}>{choice.label}</Checkbox></SaveErrorField>)}
      </Dialog>
    </></SaveErrorScope>
  )
}
