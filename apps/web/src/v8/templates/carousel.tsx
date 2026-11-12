'use client'
import { requiredInputReason } from '@/lib/required-input-reason'

import Card, { CardHeader } from '@/components/shared/card'
import { CreatePage } from '@/components/templates/create-page'

import { notifySaved } from '@/components/shared/toast'
import { createPageReturnHref } from '@/components/shared/create-page'
import { tapExtrasError, type TapExtras } from '@line-crm/shared'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { Suspense, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import Link from '@/components/shared/list-navigation'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Copy, Plus, Send, Trash2, TriangleAlert, Zap } from 'lucide-react'
import type { Folder, MediaItem, MessageTemplateMediaDefinition } from '@line-crm/shared'
import { api, ApiError } from '@/lib/api'
import { isForbiddenOrRateLimited, loadFailureNotice } from '@/components/shared/api-error-message'
import { useActionOptions } from '@/components/auto-replies/inline-action-list'
import { readInlineActions } from '@/components/auto-replies/draft-fields'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog from '@/components/shared/dialog'
import LinePreview from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { FieldError } from '@/components/shared/form-controls'
import CarouselOrderChip from './carousel-order-chip'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { useFormErrors } from '@/lib/use-form-errors'
import { useTapActionSources } from '@/components/shared/use-tap-action-sources'
import { TAP_ACTION_KINDS, tapActionDef, type TapActionKind } from '@/lib/tap-actions'
import FolderSelect, { folderById, folderCreator, hostFolderCreate } from '@/components/shared/folder-select'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { TemplateEditFrame } from '@/v8/template-edit/public/frame/index'
import type { TemplateEditHost } from '@/v8/template-edit/public/host/index'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import { CarouselImage } from '@/v8/template-edit/public/carousel-image/index'
import { uploadCarouselImage } from '@/v8/template-edit/public/carousel-image-upload/index'
import te from '../template-edit/edit.module.css'
import {
  MAX_ACTIONS, MAX_COLUMNS, TEXT_MAX_WITH_IMAGE, TEXT_MAX_WITHOUT_IMAGE, TITLE_MAX,
  MESSAGE_TEXT_MAX, buildCarouselActions, buildCarouselContent, carouselSnapshot, choiceFromUri, emptyChoice, emptyPanel,
  needsLiff, saveCarousel, visualPanels, type ChoiceKind, type Panel,
} from './carousel-core'
import styles from './question-new.module.css'
import own from './carousel.module.css'
import { Field } from '@/components/shared/form-controls'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { TextField } from '@/components/shared/text-field'
import SegmentedControl from '@/components/shared/segmented'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import CarouselButtons from './carousel-buttons'
import { formatNumber } from '@/lib/format'
export { inlineActionsText } from './carousel-button-options'

/*
 * ★V8 テンプレート「カルーセルを作る・編集」（Pencil ）。
 *
 * 外枠はテンプレートの作る画面と同じ（src/v8/template-edit/frame）。左に段「名前とフォルダ」「カード」（札で選ぶ・つまんで並べ替え）
 * 「カード N の中身」（画像・タイトル・本文・ボタン最大3つ）と案内の帯、絵に無い「押せる回数」は下に。
 * 右の列に「気をつけること」と「届き方」。下の帯はキャンセル・下書きを保存・保存して公開。
 * 読み込み・保存（作成だけ済んだあとのやり直しは作り直さない）・公開（使用先があれば確認の窓 ）・離れる確認は
 * 現役の組み立てと保存の正本は carousel-core。
 * ボタンの「動きを実行する」は要約からその場の設定を開く。保存する処理は InlineActionList で編集する。
 * ボタンの「押したら」（絵 JkLOF・2026-10-08）：URLを開く／テキストを送る／回答フォームを開く／予約ページを開く／予約履歴を開く／
 * 動きを実行する（店だけ）。回答フォーム・予約・予約履歴はそのアカウントの LIFF の URL を保存の時点で作る（LIFF の無いアカウントでは出さない）。
 * 統括（host）は URLを開く・テキストを送るだけ（配った先で LIFF ID・回答フォームの ID を付け替える口がまだ無いため）。
 * 受け付ける URL：`/templates/carousel`・`?id=<テンプレート>`・`?visual=1`（見本の3枚で開く。撮影用）。
 */

/** 札の名前：タイトルの書きを外した短い名前（絵：「夏の定番セット（送料込み）」→「夏の定番セット」）。 */
export function chipName(title: string): string {
  return title.replace(/[（(][^）)]*[）)]\s*$/, '').trim() || title.trim()
}

/** 保存してある本文（LINE のカルーセルの列）をカードの形に戻す。壊れていれば投げる。 */
export function panelsFromContent(messageContent: string, storedActions: Record<string, Record<string, unknown[]>> | null = null): Panel[] {
  const parsed = JSON.parse(messageContent) as unknown
  const columns = Array.isArray(parsed) ? parsed : ((parsed as { columns?: unknown })?.columns ?? [])
  if (!Array.isArray(columns)) return []
  return columns.map((c, i) => {
    const col = c as Partial<Panel>
    return {
      thumbnailImageUrl: col.thumbnailImageUrl ?? '',
      title: col.title ?? '',
      text: col.text ?? '',
      actions: Array.isArray(col.actions) && col.actions.length > 0
        ? (col.actions as unknown as Array<Record<string, unknown>>).map((a, ai) => {
          const tapExtras = a.tapExtras as TapExtras | undefined
          const label = typeof a.label === 'string' ? a.label : ''
          const actions = readInlineActions((storedActions?.[String(i)]?.[String(ai)] as unknown[]) ?? null)
          if (a.type === 'message') return { tapExtras, label, kind: 'message' as const, uri: '', text: typeof a.text === 'string' ? a.text : '', formId: '', actions }
          const isUri = a.type === 'uri' || typeof a.uri === 'string'
          if (!isUri) return { tapExtras, label, kind: 'action' as const, uri: '', text: '', formId: '', actions }
          const uri = typeof a.uri === 'string' ? a.uri : ''
          const page = choiceFromUri(uri)
          /* LIFF のページは種類に戻す（URL は保存のときにアカウントの LIFF ID で作り直す）。それ以外は URL のまま。 */
          return { tapExtras, label, kind: page.kind, uri: page.kind === 'uri' ? uri : '', text: '', formId: page.formId, actions }
        })
        : [emptyChoice()],
    }
  })
}

/** 統括の編集（host.initialContent）：保存してあるカルーセルをカードに戻す。読めなければ null。 */
function hostCarouselInitial(host: TemplateEditHost | undefined) {
  const content = host?.initialContent
  if (!content || content.kind !== 'carousel') return null
  try {
    const panels = panelsFromContent(content.messageContent, content.carouselActions ?? null)
    return panels.length ? { name: content.name, panels, tapLimitMode: content.tapLimitMode, tapLimitText: content.tapLimitText ?? '' } : null
  } catch {
    return null
  }
}

/*
 * 「押したら」は共通の欄（TapActionField・YPzmo）。店は6つ＋「動きを実行する」、LIFF が無くても6つとも出し、
 * LIFF の要る動きを選ぶと中身の欄に案内が出る（保存の前にも carouselChoiceProblems で止める）。
 * 統括は URL を開く・テキストを送るだけ（配った先で LIFF ID・回答フォームの ID を付け替える口がまだ無いため。
 * 口ができたら HOST_CHOICE_KINDS を6つにする）。
 */
const HOST_CHOICE_KINDS: readonly TapActionKind[] = ['uri', 'message']

/** 出す「押したら」（並びは絵の順・いま選んでいる種類は消さない）。 */
export function choiceKindOptions(opts: { host: boolean; current?: ChoiceKind }): ChoiceKind[] {
  const kinds: ChoiceKind[] = opts.host ? [...HOST_CHOICE_KINDS] : [...TAP_ACTION_KINDS, 'action']
  return opts.current && !kinds.includes(opts.current) ? [...kinds, opts.current] : kinds
}
const ACTION_EXTRA_KIND = [{ value: 'action', label: '動きを実行する', description: 'タグを付ける・シナリオを始めるなど', icon: Zap }] as const

/** 統括で保存できない「押したら」。 */
const HOST_ALLOWED: readonly ChoiceKind[] = HOST_CHOICE_KINDS

/** 1つのボタンの誤り（文字のあるボタンだけ見る）。欄の真下に出すので「カード〇のボタン〇」は付けない。 */
function buttonProblem(a: Panel['actions'][number], liffId: string | null, hqHost: boolean): string | null {
  if (!a.label.trim()) return null
  const extrasError = tapExtrasError(a.tapExtras)
  if (extrasError) return extrasError
  if (hqHost && !HOST_ALLOWED.includes(a.kind)) return '統括のカルーセルのボタンは「URLを開く」か「テキストを送る」にしてください'
  if (a.kind === 'message') {
    if (!a.text.trim()) return '送る文を入力してください'
    if ([...a.text.trim()].length > MESSAGE_TEXT_MAX) return `送る文は${MESSAGE_TEXT_MAX}文字までです`
  }
  if (a.kind === 'form' && !a.formId) return '回答フォームを選んでください'
  if (needsLiff(a.kind) && !liffId) return `このアカウントに LIFF が登録されていないため、「${tapActionDef(a.kind)?.label}」は開けません`
  return null
}

function Carousel({ host }: { host?: TemplateEditHost }) {
  const saveErrors = useSaveFormErrors()

  const inline = Boolean(host?.composer)
  const hqHost = Boolean(host && !host.composer?.accountId)
  const router = useRouter()
  const { selectedAccountId, selectedAccount, accounts } = useAccount()
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const params = useSearchParams()
  /* 統括の入口（host）では店のテンプレートを読まない（新しく作るだけ）。 */
  const id = host ? null : params.get('id')
  const visual = params.get('visual') === '1'
  usePageTitle(inline ? null : host ? 'テンプレート' : id ? 'カルーセルを編集' : 'カルーセルを作る', !host?.composer)
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'テンプレート', href: '/templates' }], !host)

  const [hostInitial] = useState(() => hostCarouselInitial(host))
  const [name, setName] = useState(hostInitial ? hostInitial.name : inline ? 'カルーセル' : visual ? '夏の定番5点' : '')
  const [panels, setPanels] = useState<Panel[]>(() => hostInitial ? hostInitial.panels : visual ? visualPanels() : [emptyPanel()])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(Boolean(id))
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const uploadLock = useRef(false)
  const [uploadedMedia, setUploadedMedia] = useState<MessageTemplateMediaDefinition[]>(host?.initialContent?.kind === 'carousel' ? host.initialContent.media ?? [] : [])
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const editVersion = useRef<{ expectedVersion?: number; expectedDraftRevision?: number }>({})
  const savingRef = useRef(false)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [templateAccountId, setTemplateAccountId] = useState<string | null>(null)
  const [tapLimitMode, setTapLimitMode] = useState<'none' | 'once'>(hostInitial ? hostInitial.tapLimitMode : 'none')
  const [tapLimitText, setTapLimitText] = useState(hostInitial ? hostInitial.tapLimitText : '')
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null)
  const [snapshotTaken, setSnapshotTaken] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [publishCheck, setPublishCheck] = useState<{ id: string; usageCount: number; accountId: string; generation: number; publishedVersion: number; draftRevision: number } | null>(null)
  const publishTicket = useRef<object | null>(null)
  const renderedPublishTicket = publishTicket.current
  const [publishError, setPublishError] = useState('')
  const canMutate = useFeatureAccess('templates')
  const canMutateRef = useRef(canMutate)
  canMutateRef.current = canMutate
  const readOnly = host ? Boolean(host.readOnly) : !canMutate
  const readOnlyReason = usePermissionLockReason(!readOnly)
  const actionOptions = useActionOptions()

  const folderAccountId = host?.composer?.accountId ?? (id ? templateAccountId : selectedAccountId)
  /* 回答フォーム・予約・予約履歴の URL に入れる LIFF ID（テンプレートのアカウントのもの）。統括は使わない。 */
  const liffId = hqHost ? null : (accounts.find((account) => account.id === folderAccountId)?.liffId ?? null) || null
  /* 押したらの中身で選ぶ回答フォーム・予約メニュー・スタンプカード（店・店の作成の引き出し）。 */
  const tapSources = useTapActionSources(hqHost ? null : folderAccountId)
  useEffect(() => {
    setFolders([])
    if (!folderAccountId || host) return
    let cancelled = false
    void api.folders.list('template', folderAccountId).then((res) => {
      if (!cancelled && res.success) setFolders(res.data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [folderAccountId])
  /* H-18原文の再読込対策：入力が変わるたび呼ぶ側へ一時下書きを渡す。保存と同じ形。 */
  const carouselDraftSnapshot = JSON.stringify([name, panels, tapLimitMode, tapLimitText, uploadedMedia])
  useEffect(() => {
    if (!host?.onDraftChange) return
    try {
      host.onDraftChange({ kind: 'carousel', name, messageContent: buildCarouselContent(panels, hqHost ? 'hq' : (createdId ?? ''), liffId), tapLimitMode, tapLimitText: tapLimitText.trim() || null, templateId: createdId ?? '', carouselActions: buildCarouselActions(panels), media: uploadedMedia.filter((media) => panels.some((p) => p.thumbnailImageUrl === media.publicUrl)) })
    } catch { /* 組み立て不可の途中入力は通知しない */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carouselDraftSnapshot])

  useEffect(() => {
    if (!id) return
    const markLoadFailed = (caught?: unknown) => {
      setLoadFailed(true)
      setError(isForbiddenOrRateLimited(caught) ? loadFailureNotice(caught, 'カルーセル') : '読み込めませんでした。開き直してください。')
    }
    void api.templates.get(id)
      .then((res) => {
        if (!res.success) { markLoadFailed(); return }
        editVersion.current = { expectedVersion: res.data.publishedVersion, expectedDraftRevision: res.data.draftRevision }
        setName(res.data.name)
        setTemplateAccountId(res.data.accountId ?? null)
        setFolderId(res.data.folderId ?? null)
        setTapLimitMode(res.data.carouselTapLimitMode === 'once' ? 'once' : 'none')
        setTapLimitText(res.data.carouselTapLimitText ?? '')
        const storedActions = (res.data.carouselActions ?? null) as Record<string, Record<string, unknown[]>> | null
        try {
          const loaded = panelsFromContent(res.data.messageContent, storedActions)
          if (loaded.length > 0) setPanels(loaded)
        } catch (saveFailure) {
          const fieldFailure = saveErrors.capture(saveFailure)

          { if (!fieldFailure)

          setError('いまの中身を読み取れませんでした。保存すると上書きされます。') }
        }
      })
      .catch((caught: unknown) => markLoadFailed(caught))
      .finally(() => setLoading(false))
  }, [id, saveErrors])

  useEffect(() => {
    if (loading || snapshotTaken) return
    setSavedSnapshot(carouselSnapshot({ name, panels, folderId, tapLimitMode, tapLimitText }))
    setSnapshotTaken(true)
  }, [loading, snapshotTaken, name, panels, folderId, tapLimitMode, tapLimitText])
  const dirty = uploading || (savedSnapshot !== null && savedSnapshot !== carouselSnapshot({ name, panels, folderId, tapLimitMode, tapLimitText }))
  const { leaveTarget, confirmLeave, cancelLeave, guarded, disarm } = useUnsavedGuard({ dirty, subject: 'カルーセルの作成内容', busy: saving || publishing || uploading || Boolean(host?.busy) })

  const update = (index: number, patch: Partial<Panel>) => setPanels((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  const moveTo = (from: number, to: number) => {
    if (uploadLock.current || from === to || to < 0 || to >= panels.length) return
    setPanels((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
    setSelected(to)
  }
  const duplicatePanel = (index: number) => setPanels((prev) => prev.length >= MAX_COLUMNS ? prev : [...prev.slice(0, index + 1), { ...prev[index], actions: [...prev[index].actions] }, ...prev.slice(index + 1)])
  const removePanel = (index: number) => {
    setPanels((prev) => prev.filter((_, j) => j !== index))
    setSelected((current) => Math.max(0, Math.min(current === index ? index - 1 : current > index ? current - 1 : current, panels.length - 2)))
  }
  const textMaxFor = (panel: Panel) => (panel.title.trim() || panel.thumbnailImageUrl.trim() ? TEXT_MAX_WITH_IMAGE : TEXT_MAX_WITHOUT_IMAGE)

  /*
   * 保存で落ちた欄（・オーナーの写真の指摘：「すべてのカードに本文を入力してください」の帯だけだった）。
   * 欄の真下に理由を出して赤くし、別のカードの欄ならそのカードを選んでから移る。カードの札には直す欄の数の赤い丸。
   */
  const fields = useFormErrors()
  if (!inline) fields.define('name', 'テンプレート名', () => (name.trim() ? null : '名前を入力してください'), { required: true })
  const someImage = panels.some((p) => p.thumbnailImageUrl.trim())
  panels.forEach((p, i) => {
    const opts = { reveal: () => setSelected(i), group: `card-${i}` }
    fields.define(`card-${i}-image`, `カード${i + 1}の画像`, () => (someImage && !p.thumbnailImageUrl.trim() ? '画像は全部のカードに入れるか、全部入れないかにしてください' : null), { ...(opts), required: someImage })
    fields.define(`card-${i}-title`, `カード${i + 1}のタイトル`, () => ([...p.title].length > TITLE_MAX ? `タイトルは${TITLE_MAX}文字までです（いま${formatNumber([...p.title].length)}文字）` : null), { ...(opts), required: false })
    fields.define(`card-${i}-text`, `カード${i + 1}の本文`, () => (
      !p.text.trim() ? '本文を入力してください'
        : [...p.text].length > textMaxFor(p) ? `本文は${textMaxFor(p)}文字までです（いま${formatNumber([...p.text].length)}文字）` : null
    ), { ...(opts), required: true })
    p.actions.forEach((a, ai) => {
      fields.define(`card-${i}-button-${ai}`, `カード${i + 1}のボタン${ai + 1}`, () => buttonProblem(a, liffId, hqHost), { ...(opts), required: true })
    })
  })

  /** 保存する。できたらテンプレートの id（URL の id または作成済み）を返す。 */
  const saveNow = async (): Promise<string | null> => {
    if (savingRef.current || uploadLock.current) return null
    if (loadFailed) { setError('読み込めませんでした。開き直してください。'); return null }
    if (!id && !createdId && !selectedAccountId) { setError('上のバーでLINE公式アカウントを選んでください'); return null }
    if (fields.submit().length > 0) { setError(''); return null }
    savingRef.current = true
    setSaving(true)
    setError('')
    setSaveFailed(false)
    try {
      const res = await saveCarousel({ ...editVersion.current, templateId: id ?? createdId, selectedAccountId, name, panels, folderId, tapLimitMode, tapLimitText, liffId })
      if (!res.ok) {
        if (res.createdId) { setCreatedId(res.createdId); editVersion.current = { expectedVersion: res.expectedVersion, expectedDraftRevision: res.expectedDraftRevision } }
        if (res.tapExtraError) fields.setServerErrors(Object.fromEntries(panels.flatMap((p, ci) => p.actions.flatMap((a, ai) => a.tapExtras ? [[`card-${ci}-button-${ai}`, res.tapExtraError]] : []))))
        else setError(res.error)
        setSaveFailed(true)
        return null
      }
      /* 作成だけ済んだあとのやり直しが「作り直し」にならないよう覚える。 */
      editVersion.current = { expectedVersion: res.expectedVersion, expectedDraftRevision: res.expectedDraftRevision }
      if (!id) setCreatedId(res.id)
      setSavedSnapshot(carouselSnapshot({ name, panels, folderId, tapLimitMode, tapLimitText }))
      return res.id
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const publishNow = async (templateId: string, generation: number, detail?: { publishedVersion: number; draftRevision: number }) => {
    const got = detail ? { success: true as const, data: detail } : await api.templates.get(templateId)
    if (!alive.current || !canMutateRef.current || generation !== accountScope.current.generation) return false
    if (!got.success || !got.data) { setPublishError('いまの状態を読み込めませんでした。もう一度お試しください。'); return false }
    try {
      const res = await api.templates.publish(templateId, { expectedVersion: got.data.publishedVersion ?? 0, expectedDraftRevision: got.data.draftRevision ?? 0 })
      if (!res.success) { setPublishError(res.error || '公開できませんでした。もう一度お試しください。'); return false }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setPublishError(caught instanceof ApiError && caught.status === 409 ? '他の人が先に更新したため、公開を止めました。画面を読み直して、もう一度お試しください。' : '公開できませんでした。もう一度お試しください。') }
      return false
    }
    return true
  }
  /* 保存して公開。使用先があるときは確認の窓を出してから公開する。 */
  const publishSaved = async (templateId: string, generation: number) => {
    setPublishing(true)
    setPublishError('')
    try {
      const detail = await api.templates.get(templateId)
      if (!alive.current || !canMutateRef.current || generation !== accountScope.current.generation) return
      if (!detail.success || !detail.data) { setPublishError('いまの状態を読み込めませんでした。一覧の詳細から公開してください。'); return }
      const usedBy = detail.data.usedBy
      const usageCount = usedBy ? Object.values(usedBy).reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0) : 0
      if (usageCount > 0) { publishTicket.current = {}; setPublishCheck({ id: templateId, usageCount, accountId: detail.data.accountId ?? '', generation, publishedVersion: detail.data.publishedVersion ?? 0, draftRevision: detail.data.draftRevision ?? 0 }); return }
      if (await publishNow(templateId, generation, detail.data) && alive.current && generation === accountScope.current.generation) { notifySaved('公開しました'); if (!id) { disarm(); router.push(createPageReturnHref('/templates', templateId)) } }
    } finally {
      setPublishing(false)
    }
  }
  /* 統括の入口：中身を組み立てて呼ぶ側へ渡す。選択肢は URL を開く・テキストを送るだけ（ほかは配った先で動かせない）。 */
  const hostSave = async (distribute: boolean) => {
    if (!host || uploadLock.current || host.busy || savingRef.current) return
    if (fields.submit().length > 0) { setError(''); return }
    setError('')
    let backingId = ''
    if (inline && !distribute && panels.some((p) => p.actions.some((a) => a.kind === 'action'))) { setError('「動きを実行する」を入れるときは、テンプレートとしても保存してください。'); return }
    if (!hqHost && (distribute || panels.some((p) => p.actions.some((a) => a.kind === 'action')))) {
      savingRef.current = true; setSaving(true)
      const saved = await saveCarousel({ ...editVersion.current, templateId: createdId, selectedAccountId: folderAccountId, name: panels[0].title.trim() || name, panels, folderId: null, tapLimitMode, tapLimitText, liffId })
      savingRef.current = false; setSaving(false)
      if (!saved.ok) { if (saved.createdId) { setCreatedId(saved.createdId); editVersion.current = { expectedVersion: saved.expectedVersion, expectedDraftRevision: saved.expectedDraftRevision } } setError(saved.error); return }
      editVersion.current = { expectedVersion: saved.expectedVersion, expectedDraftRevision: saved.expectedDraftRevision }
      backingId = saved.id; setCreatedId(saved.id)
    }
    savingRef.current = true; setSaving(true)
    try {
    const inserted = await host.onSave({ kind: 'carousel', name: inline ? panels[0].title.trim() || name : name.trim(), messageContent: buildCarouselContent(panels, hqHost ? 'hq' : backingId, liffId), tapLimitMode, tapLimitText: tapLimitText.trim() || null, templateId: backingId, carouselActions: buildCarouselActions(panels), media: uploadedMedia.filter((media) => panels.some((p) => p.thumbnailImageUrl === media.publicUrl)) }, distribute)
    if (inserted !== false) disarm()
    } finally { savingRef.current = false; setSaving(false) }
  }
  const onSaveDraft = async () => { if (host) { hostSave(false); return } const savedId = await saveNow(); if (savedId) { notifySaved('下書きを保存しました'); if (!id) { disarm(); router.push(createPageReturnHref('/templates', savedId)) } } }
  const onPublish = async () => { if (host) { hostSave(true); return } const generation = accountScope.current.generation; const savedId = await saveNow(); if (savedId && alive.current && canMutateRef.current && generation === accountScope.current.generation) await publishSaved(savedId, generation) }

  const panel = panels[selected] ?? panels[0]
  const selectedIndex = panels[selected] ? selected : 0

  if (readOnly) {
    return (
      <SaveErrorScope errors={saveErrors}><CreatePage boardId="J60utH" title="カルーセル" help="カルーセルの作成・変更はオーナーと管理者だけができます" readOnly footerActions={null}>
        <p className={styles.note}>一覧で中身を確認できます。</p>
        <div className={own.chipRow} aria-label="カードの順番">
          {panels.map((item, index) => <CarouselOrderChip key={index} index={index}
            label={`${index + 1} ${chipName(item.title) || `カード ${index + 1}`}`} src={item.thumbnailImageUrl}
            errorCount={fields.countIn(`card-${index}`)} aria-pressed={index === selectedIndex}
            lockedReason={readOnlyReason} disabled={!readOnlyReason} draggable={false} />)}
        </div>

      </CreatePage></SaveErrorScope>
    )
  }

  const inputReason = loading || loadFailed ? null : requiredInputReason([
    { label: 'テンプレート名', value: inline || name },
    ...panels.flatMap((panel, index) => [
      { label: `カード ${index + 1} の本文`, value: panel.text },
      { label: `カード ${index + 1} の画像`, value: !someImage || panel.thumbnailImageUrl, select: true },
      ...panel.actions.flatMap((action, actionIndex) => !action.label.trim() ? [] : [
        { label: `カード ${index + 1} のボタン ${actionIndex + 1} の送る文`, value: action.kind !== 'message' || action.text },
        { label: `カード ${index + 1} のボタン ${actionIndex + 1} の回答フォーム`, value: action.kind !== 'form' || action.formId, select: true },
      ]),
    ]),
  ])
  const busy = saving || publishing || uploading || Boolean(host?.busy)
  const onChipKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (busy) return
    if (event.key === 'ArrowLeft' && event.altKey) { event.preventDefault(); moveTo(index, index - 1) }
    if (event.key === 'ArrowRight' && event.altKey) { event.preventDefault(); moveTo(index, index + 1) }
  }
  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault()
    if (busy) return
    if (dragIndex !== null) moveTo(dragIndex, index)
    setDragIndex(null)
  }
  /* 届き方：アイコンと横に並ぶカード（いま開いているカードを先頭に、次のカードの端を見せる）。 */
  const sender = host ? host.accountName || '公式アカウント' : selectedAccount?.name ?? '公式アカウント'
  const shown = panels.slice(selectedIndex, selectedIndex + 2)
  const phone = (
    <LinePreview title={null} note="カルーセルの見え方（横にスワイプして見えます）" accountName={sender} caption="配信日 10:00">
      <div className={own.talkRow}>
        <span className={own.avatar} aria-hidden="true">{sender.slice(0, 1)}</span>
        <div className={own.slides}>
          {shown.map((item, index) => (
            <div key={index} className={own.slide} data-peek={index > 0 || undefined}>
              {/^https?:\/\//.test(item.thumbnailImageUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img width={240} height={110} src={item.thumbnailImageUrl} alt="" className={own.slideImage} />
              ) : <span className={own.slideImage}>{chipName(item.title)}</span>}
              {index === 0 ? (
                <>
                  <span className={own.slideBody}>
                    <span className={own.slideTitle}>{item.title || '（タイトル）'}</span>
                    <span className={own.slideText}>{item.text}</span>
                  </span>
                  {item.actions.map((action, ai) => <span key={ai} className={own.slideButton}>{action.label || '（ボタン）'}</span>)}
                </>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {panels.length > 1 ? <p className={own.swipe}><span>横にスワイプして見えます</span></p> : null}
    </LinePreview>
  )

  return (
    <SaveErrorScope errors={saveErrors}><>
      <TemplateEditFrame
        inputReason={inputReason}
        composerHost={host ? { ...host, busy, onCancel: () => guarded(host.onCancel) } : undefined}
        onComposerInsert={(alsoSave) => void hostSave(alsoSave)}
        boardId="J60utH"
        title={id ? 'カルーセルを編集' : 'カルーセルを作る'}
        status={host || loading || loadFailed ? undefined : saving ? '保存しています' : saveFailed ? '保存できませんでした' : dirty ? '未保存の変更があります' : id || createdId ? '保存済み' : '下書きはまだ保存していません'}
        description={`横にめくるカード。最大 ${MAX_COLUMNS} 枚`}
        side={(
          <>
            {inline ? null : <CreateSummaryCard title="気をつけること" rows={[{ label: 'カードの数', value: `${formatNumber(panels.length)} / ${MAX_COLUMNS}` }, { label: '画像', value: `${formatNumber(panels.length)} 枚とも同じ比率` }, { label: '押された数', value: 'ボタンごとに数える' }]} />}
            <h2 className={te.previewHead}>届き方</h2>
            <div className={te.phone}>{phone}</div>
          </>
        )}
        footerActions={(
          <>
            <Button type="button" onClick={() => (host ? host.onCancel() : requestUnsavedAction(() => router.push('/templates')))} disabled={busy}>キャンセル</Button>
            <Button type="button" onClick={() => onSaveDraft()} disabled={busy || loadFailed} busy={saving && !publishing}>下書きを保存</Button>
            <Button type="button" variant="primary" onClick={() => onPublish()} disabled={busy || loadFailed || Boolean(inputReason)} disabledReason={inputReason} busy={publishing || Boolean(host?.busy)}>{host ? null : <Send size={16} aria-hidden="true" />}{host ? host.primaryLabel ?? '保存する' : '保存して公開'}</Button>
          </>
        )}
      >
        {host?.notice}
        {error ? <Notice tone="danger" message={error} /> : null}
        {publishError ? <Notice tone="danger" message={publishError} /> : null}
        {saveFailed ? <Notice tone="warn" message="入力した内容はそのまま残っています。もう一度保存を押してください。" /> : null}
        {loading ? <ListState kind="loading" title="カルーセルを読み込んでいます" /> : (
          <>
            {inline ? null : <Card variant="form" gap="normal" aria-labelledby="cr-name">
              <CardHeader size="stacked" title="名前とフォルダ" titleId="cr-name" />
              <SettingsFormRow layout="name-folder">
                <Field label="テンプレート名" htmlFor="cr-name-input" requirement={fields.requirement('name')}><SaveErrorField names={["name"]}><TextField {...fields.bind('name')} id="cr-name-input" value={name} placeholder="例：夏の定番5点" aria-invalid={fields.invalid('name') || undefined} aria-describedby={fields.invalid('name') ? 'cr-name-input-error' : undefined} onChange={(event) => setName(event.target.value)} /></SaveErrorField><FieldError id="cr-name-input-error">{fields.error('name')}</FieldError></Field>
                <Field label="フォルダ">
                  <SaveErrorField names={["folder","host.folder","folderId","folder_id"]}><FolderSelect
                    size="full"
                    aria-label="フォルダ"
                    value={host ? host.folder : folderId ?? ''}
                    onChange={host ? host.onFolderChange : (value) => setFolderId(value || null)}
                    folders={host ? host.folders : folders.map(folderById)}
                    colors
                    onCreate={host
                      ? hostFolderCreate(host)
                      : canMutate && folderAccountId
                        ? folderCreator((name, color) => api.folders.create({ kind: 'template', name, color, accountId: folderAccountId }), folderById, (created) => setFolders((current) => [...current, created]))
                        : undefined}
                  /></SaveErrorField>
                </Field>
              </SettingsFormRow>
            </Card>}

            <Card variant="form" gap="normal" aria-labelledby="cr-cards">
              <CardHeader title="カード" titleId="cr-cards" size="stacked" meta="左から順に出ます。つまんで並べ替えられます。" />
              <div className={own.chipRow}>
                {panels.map((item, index) => (
                  <CarouselOrderChip
                    index={index}
                    label={`${index + 1} ${chipName(item.title) || `カード ${index + 1}`}`}
                    src={item.thumbnailImageUrl}
                    errorCount={fields.countIn(`card-${index}`)}
                    key={index}
                    type="button"
                    data-composer={inline || undefined}
                    aria-pressed={index === selectedIndex}
                    draggable={!busy}
                    disabled={busy}
                    title={`${item.title || `カード ${index + 1}`}（つまんで並べ替え・Alt＋← → でも動かせます）`}
                    onClick={() => setSelected(index)}
                    onKeyDown={(event) => onChipKey(event, index)}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => onDrop(event, index)}
                  />
                ))}
                <Button type="button" variant="text" disabled={busy || panels.length >= MAX_COLUMNS} onClick={() => { setPanels((prev) => [...prev, emptyPanel()]); setSelected(panels.length) }}>
                  <Plus size={16} aria-hidden="true" />カードを足す
                </Button>
                <span className={own.count}>{`${panels.length} / ${MAX_COLUMNS} 枚`}</span>
              </div>
            </Card>

            {panel ? (
              <Card variant="form" gap="normal" aria-labelledby="cr-panel">
                <CardHeader size="stacked" title={`カード ${selectedIndex + 1} の中身`} titleId="cr-panel" />
                <div className={own.panelRow}>
                  <div className={own.imageCol} {...fields.bind(`card-${selectedIndex}-image`)} aria-describedby={fields.invalid(`card-${selectedIndex}-image`) ? 'cr-image-error' : undefined}>
                  <CarouselImage
                    url={panel.thumbnailImageUrl} disabled={busy || loading || loadFailed || (!host && !folderAccountId)} maxMB={hqHost ? 8 : 10}
                    scope={`${host ? 'hq' : folderAccountId}-${id ?? 'new'}-${selectedIndex}`}
                    onBusyChange={(value) => { uploadLock.current = value; setUploading(value) }}
                    upload={async (file) => {
                      if (hqHost && host) {
                        if (!host.uploadCarouselImage) throw new Error('統括の画像の受け取り口を利用できません。')
                        const media = await host.uploadCarouselImage(file)
                        setUploadedMedia((current) => [...current.filter((item) => item.id !== media.id), media])
                        if (!media.publicUrl) throw new Error('登録した画像のURLを確認できませんでした。時間をおいて、もう一度お試しください。')
                        return media.publicUrl
                      }
                      if (!folderAccountId) throw new Error('上のバーでLINE公式アカウントを選んでください。')
                      return uploadCarouselImage(file, folderAccountId)
                    }}
                    onUploaded={(url) => update(selectedIndex, { thumbnailImageUrl: url })}
                    onMediaPick={hqHost ? undefined : () => setPickerOpen(true)}
                    onUrl={() => setUrlOpen((open) => !open)}
                  />
                  <FieldError id="cr-image-error">{fields.error(`card-${selectedIndex}-image`)}</FieldError>
                  </div>
                  <div className={own.textCol}>
                    <div className={styles.field}><Field label={<>{`タイトル（${TITLE_MAX}文字まで）`}</>} htmlFor="cr-title"><SaveErrorField names={["title","panel.title"]}><TextField {...fields.bind(`card-${selectedIndex}-title`)} id="cr-title" value={panel.title} aria-invalid={fields.invalid(`card-${selectedIndex}-title`) || undefined} aria-describedby={fields.invalid(`card-${selectedIndex}-title`) ? 'cr-title-error' : undefined} onChange={(event) => update(selectedIndex, { title: event.target.value })} /></SaveErrorField>
<FieldError id="cr-title-error">{fields.error(`card-${selectedIndex}-title`)}</FieldError></Field></div>
                    <div className={styles.field}><Field label={<>{panel.title.trim() || panel.thumbnailImageUrl.trim() ? `本文（タイトルか画像があると${TEXT_MAX_WITH_IMAGE}文字まで）` : `本文（${TEXT_MAX_WITHOUT_IMAGE}文字まで）`}</>} htmlFor="cr-text"><SaveErrorField names={["text","panel.text"]}><TextField {...fields.bind(`card-${selectedIndex}-text`)} id="cr-text" value={panel.text} aria-invalid={fields.invalid(`card-${selectedIndex}-text`) || undefined} aria-describedby={fields.invalid(`card-${selectedIndex}-text`) ? 'cr-text-error' : undefined} onChange={(event) => update(selectedIndex, { text: event.target.value })} /></SaveErrorField>
<FieldError id="cr-text-error">{fields.error(`card-${selectedIndex}-text`)}</FieldError></Field></div>
                    {[...panel.title].length > TITLE_MAX || [...panel.text].length > textMaxFor(panel) ? (
                      <p className={own.over} role="alert">{`タイトル ${[...panel.title].length} / ${TITLE_MAX}・本文 ${[...panel.text].length} / ${textMaxFor(panel)} 文字。多すぎる分を減らしてください。`}</p>
                    ) : null}
                  </div>
                </div>
                {urlOpen ? (
                  <Field label="画像の URL"><SaveErrorField names={["thumbnailImageUrl","panel.thumbnailImageUrl","thumbnail_image_url","panel.thumbnail_image_url"]}><TextField type="url" value={panel.thumbnailImageUrl} placeholder="https://example.com/a.png" onChange={(event) => update(selectedIndex, { thumbnailImageUrl: event.target.value })} /></SaveErrorField></Field>
                ) : null}

                <span className={styles.pickLabel}>{`ボタン（最大 ${MAX_ACTIONS} つ）`}</span>
                <CarouselButtons key={selectedIndex} actions={panel.actions} selectedIndex={selectedIndex} fields={fields}
                  hqHost={hqHost} host={Boolean(host)} folderAccountId={folderAccountId} liffId={liffId}
                  sources={tapSources} actionOptions={actionOptions} kindOptions={current => choiceKindOptions({ host: hqHost, current })} extraKinds={hqHost ? [] : ACTION_EXTRA_KIND}
                  onChange={actions => update(selectedIndex, { actions })} />
                <div className={own.toolRow}>
                  <Button type="button" variant="text" disabled={panel.actions.length >= MAX_ACTIONS} title={panel.actions.length >= MAX_ACTIONS ? `ボタンは${MAX_ACTIONS}つまでです。` : undefined} onClick={() => update(selectedIndex, { actions: [...panel.actions, emptyChoice()] })}><Plus size={16} aria-hidden="true" />ボタンを足す</Button>
                  <span className={own.spacer} />
                  <Button type="button" variant="text" disabled={busy || panels.length >= MAX_COLUMNS} title={panels.length >= MAX_COLUMNS ? `カードは${MAX_COLUMNS} 枚までです` : undefined} onClick={() => duplicatePanel(selectedIndex)}><Copy size={16} aria-hidden="true" />このカードを複製</Button>
                  <Button type="button" variant="text" disabled={busy || panels.length <= 1} title={panels.length <= 1 ? 'カードは1枚必要です' : undefined} onClick={() => removePanel(selectedIndex)}><Trash2 size={16} aria-hidden="true" />このカードを消す</Button>
                </div>
                <Notice tone="warn" title="画像は横1024 × 縦678pxを推奨。本文はタイトルか画像があると60文字、両方なければ120文字までです。" icon={<TriangleAlert aria-hidden="true" />}>
                  画像は全部のカードに入れるか、全部入れないかにします。1枚だけ違うと、高さがそろわず崩れます。
                </Notice>
              </Card>
            ) : null}

            {/* 絵に無いが今ある設定：押せる回数（「動きを実行する」ボタンだけが対象）。統括の入口は URL だけなので出さない。 */}
            {hqHost || inline ? null : <Card variant="form" gap="normal" aria-labelledby="cr-limit">
              <CardHeader title="押せる回数" titleId="cr-limit" size="stacked" meta="「動きを実行する」ボタンだけが対象です。URLを開くボタンはLINEの外へ出るので数えられません。" />
              <SegmentedControl fit="content" aria-label="押せる回数" value={tapLimitMode} options={[{ value: 'none', label: '何度でも押せる' }, { value: 'once', label: '1人につき1回だけ' }]} onChange={setTapLimitMode} />
              {tapLimitMode === 'once' ? (
                <Field label="2回目に押されたときの返事空なら何も返さない"><SaveErrorField names={["tapLimitText","tap_limit_text"]}><TextField value={tapLimitText} placeholder="例：こちらはすでに受け付けています。" onChange={(event) => setTapLimitText(event.target.value)} /></SaveErrorField></Field>
              ) : null}
            </Card>}
          </>
        )}
      </TemplateEditFrame>

      <ConfirmDialog
        open={publishCheck !== null && publishCheck.generation === accountScope.current.generation}
        title="この内容を公開しますか？"
        description={`このテンプレートは ${publishCheck?.usageCount ?? 0}か所で使われています。公開すると、使っている場所へ新しい内容が届きます。`}
        confirmLabel="公開する"
        busy={publishing}
        error={publishError || undefined}
        designNode="cuR8I"
        onConfirm={async () => {
          if (!publishCheck || !renderedPublishTicket || renderedPublishTicket !== publishTicket.current || !alive.current || !canMutateRef.current || publishCheck.generation !== accountScope.current.generation) return
          setPublishing(true)
          setPublishError('')
          try {
            if (await publishNow(publishCheck.id, publishCheck.generation, publishCheck) && alive.current && publishCheck.generation === accountScope.current.generation) { publishTicket.current = null; setPublishCheck(null); notifySaved('公開しました'); if (!id) { disarm(); router.push(createPageReturnHref('/templates', publishCheck.id)) } }
          } finally {
            setPublishing(false)
          }
        }}
        onCancel={() => { publishTicket.current = null; setPublishCheck(null) }}
      >{publishCheck ? <OperationTargetSummary accounts={[{ id: publishCheck.accountId }]} /> : null}</ConfirmDialog>
      <MediaPickerDialog
        open={pickerOpen}
        accountId={folderAccountId}
        kind="image"
        onClose={() => setPickerOpen(false)}
        onSelect={(item: MediaItem) => { update(selectedIndex, { thumbnailImageUrl: item.url }); setPickerOpen(false) }}
      />
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="カルーセルの変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </></SaveErrorScope>
  )
}

/** `host` を渡すと統括のテンプレートの入口から使う（template-edit/host.ts）。ボタンは URL を開く・テキストを送るだけ。 */
export default function CarouselV8({ host }: { host?: TemplateEditHost } = {}) {
  return (
    <Suspense fallback={<ListState kind="loading" title="カルーセルを読み込んでいます" />}>
      <Carousel host={host} />
    </Suspense>
  )
}
