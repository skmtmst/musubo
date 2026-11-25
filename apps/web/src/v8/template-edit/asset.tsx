'use client'
import { requiredInputReason } from '@/lib/required-input-reason'

import { type ResearchFormat, type ResearchQuestion, visualQuestions, assetInitial } from './asset-initial'
export type { ResearchQuestion } from './asset-initial'
export { assetInitial } from './asset-initial'

import CouponSettings, { CouponGuide } from './coupon-settings'
import { couponDraftPayload, couponDraftProblems, initialCouponDraft } from './coupon-draft'
import StoredAssetEditor from './stored-asset-editor'
import { AssetPublishError, useCouponPersistence } from './use-coupon-persistence'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import CouponPreview from '@/components/shared/coupon-preview'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import type { BroadcastMessageAsset } from '@/lib/api'
import type { BroadcastAssetFolder } from '@/lib/api/types/broadcasts'
import { defaultCouponInstructions } from '@line-crm/shared'

import { SettingsFormRow } from '@/components/shared/settings-form-card'

import Toggle from '@/components/shared/toggle'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { createPageReturnHref } from '@/components/shared/create-page'
import { notifySaved } from '@/components/shared/toast'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { GripVertical, Plus, Trash2, Upload, X } from 'lucide-react'
import { hasTapExtras, tapExtrasError, type TapExtras, type Folder, type MediaItem, type FormBlock, type FormLayout } from '@line-crm/shared'
import { tapExtraSaveError } from '@/lib/tap-actions'
import { api } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useAccount } from '@/contexts/account-context'
import { usePageTitle } from '@/components/shell/page-chrome'
import TapExtrasField from '@/components/shared/tap-extras-field'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import Card, { CardHeader } from '@/components/shared/card'
import ActionMenu from '@/components/shared/action-menu'
import ReorderHandle, { useReorder } from '@/components/shared/reorder-handle'
import Combobox from '@/components/shared/combobox'
import DateTimeField from '@/components/shared/date-time-field'
import LinePreview from '@/components/shared/line-preview'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import FolderSelect, { folderByName, folderCreator, hostFolderCreate, FolderCreateError } from '@/components/shared/folder-select'
import { TextField } from '@/components/shared/text-field'
import InlineActionRowsV8 from '@/components/auto-replies/inline-action-rows-v8'
import { useActionOptions } from '@/components/auto-replies/inline-action-list'
import { readInlineActions, toActionPayload, type InlineAction } from '@/components/auto-replies/draft-fields'
import { TemplateEditFrame, TemplatePublishNote } from './frame'
import ChoiceExtrasRows from './choice-extras'
import { FormPhone } from '@/v8/form-edit/public/phone/index'
import type { TemplateEditHost } from './host'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import MediaSlot from '@/components/shared/media-slot'
import { FieldError, Field } from '@/components/shared/form-controls'
import { useFormErrors } from '@/lib/use-form-errors'
import { uploadToMediaLibrary } from '@/components/shared/media-library-upload'
import styles from './edit.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ImageFrame from '@/components/shared/image-frame'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { InputFieldFrame, TextField as SharedTextField } from '@/components/shared/text-field'

/*
 * ★V8「クーポンを作る」・「リサーチを作る」。
 *
 * 保存は今の画面（app/templates/asset-editor-v8.tsx・template-asset-editor.tsx）と
 * 同じ口（POST /api/broadcast-message-assets）・同じ形の payload。違いは置き場と
 * 見せ方だけ（BEHAVIOR.md）。リッチメッセージは今の画面のまま（入口が渡す）。
 */

export type AssetKind = 'coupon' | 'research'

/* 今の画面と同じ値（template-asset-editor.tsx から写した）。 */
const META: Record<AssetKind, { title: string; heading: string; lead: string; board: string; folder: string }> = {
  coupon: { title: 'クーポン', heading: 'クーポンを作る', lead: '特典・使える期間・回数を決めます。公開しても、この操作では友だちへ送信しません。', board: 'S6FEuB', folder: '03_販促・クーポン' },
  research: { title: 'リサーチ', heading: 'リサーチを作る', lead: 'LINEの中で答える短い質問。住所や画像も聞くなら回答フォーム', board: 'EsYo4', folder: '02_健康フォロー' },
}
export const MAX_QUESTIONS = 10
/** LINE のクイックリプライは13件まで。 */
export const MAX_CHOICES = 13
const FORMAT_OPTIONS: Array<{ value: ResearchFormat; label: string }> = [
  { value: 'single', label: '1つだけ選ぶ' },
  { value: 'multiple', label: 'いくつでも選ぶ' },
  { value: 'free', label: '自由に書く' },
]
const newQuestion = (): ResearchQuestion => ({ key: crypto.randomUUID(), text: '', format: 'single', required: true, choices: ['', ''] })

/** `2026-08-01T00:00` → `8/1`（見本の札に出す短い日付）。 */
function shortDate(value: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(value)
  return m ? `${Number(m[1])}/${Number(m[2])}` : ''
}

export function couponPeriodLine(startsAt: string, endsAt: string, once: boolean): string {
  const period = startsAt || endsAt ? `${shortDate(startsAt) || emptyValue('unconfigured')}〜${shortDate(endsAt) || emptyValue('unconfigured')}` : '期間 未設定'
  return `${period}・${once ? '1人1回' : '何回でも'}`
}

/**
 * `host` を渡すと、統括のテンプレートの入口から同じ画面を使う（host.ts）。保存は呼ぶ側、主ボタンは［保存して配る］、
 * 店のアカウントに結びつく欄（登録メディア・行うこと・答えてもらう人）は出さない。
 */
type EditorProps = { kind: AssetKind; visual?: boolean; host?: TemplateEditHost; existing?: BroadcastMessageAsset }
export default function TemplateAssetEditor({ id, ...props }: EditorProps & { id?: string | null }) {
  if (id && props.kind === 'coupon' && !props.host) return <StoredAssetEditor id={id}>{asset => <TemplateAssetForm key={`${asset.id}:${asset.lineAccountId}`} {...props} existing={asset} />}</StoredAssetEditor>
  return <TemplateAssetForm {...props} />
}

function TemplateAssetForm({ kind, visual = false, host, existing }: EditorProps) {
  const saveErrors = useSaveFormErrors()
  const meta = META[kind]
  const router = useRouter()
  const role = useStaffRole()
  const featureAccess = useFeatureAccess('templates')
  const canMutate = host ? !host.readOnly : featureAccess
  const permissionReason = usePermissionLockReason(canMutate)
  const { selectedAccountId, accounts } = useAccount()
  const persistAsset = useCouponPersistence(selectedAccountId, existing, kind)
  usePageTitle(host ? 'テンプレート' : existing && kind === 'coupon' ? 'クーポンを編集する' : meta.heading)
  const actionOptions = useActionOptions()

  /* 統括の編集：保存してある payload から欄を埋める（同じ形で保存し直す）。 */
  const initialPayload = host?.initialContent && host.initialContent.kind === kind && 'payload' in host.initialContent ? (host.initialContent.editorState && Object.keys(host.initialContent.payload).length === 0 ? undefined : host.initialContent.payload) : existing?.payload
  const draftState = host?.initialContent && 'editorState' in host.initialContent && host.initialContent.kind === kind ? host.initialContent.editorState : undefined
  const init = initialPayload ? { name: host?.initialContent?.name ?? existing?.name ?? '', ...assetInitial(initialPayload) } : null
  const [couponDraft, setCouponDraft] = useState(() => draftState?.couponDraft ?? (initialCouponDraft(initialPayload, visual)))
  const [name, setName] = useState(host?.initialContent?.name ?? (init ? init.name : visual ? (kind === 'coupon' ? '夏の20%オフ' : '定期便のご満足度') : ''))
  const [folder, setFolder] = useState(kind === 'coupon' ? existing?.folderId ?? '' : visual ? meta.folder : '')
  const [folderTouched, setFolderTouched] = useState(false)
  const [assetFolders, setAssetFolders] = useState<BroadcastAssetFolder[]>([])
  const [folderProblem, setFolderProblem] = useState(false)
  const [folderAttempt, setFolderAttempt] = useState(0)
  const [folders, setFolders] = useState<Folder[]>([])
  const [description, setDescription] = useState(draftState?.description ?? (init ? init.description : visual ? (kind === 'coupon' ? '会計時にこの画面をご提示ください。他の割引との併用はできません。' : 'いつもありがとうございます。3問だけ聞かせてください。') : ''))
  // クーポン
  const [couponTitle, setCouponTitle] = useState(draftState?.couponTitle ?? (init ? init.couponTitle : visual && kind === 'coupon' ? '夏の20%オフ' : ''))
  const [imageUrl, setImageUrl] = useState(draftState?.imageUrl ?? (init ? init.imageUrl : ''))
  const [tapExtras, setTapExtras] = useState<TapExtras | undefined>(draftState?.tapExtras ?? (init?.tapExtras))
  const [pickedMedia, setPickedMedia] = useState<MediaItem | null>(draftState?.pickedMedia ?? (null))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [couponOnce, setCouponOnce] = useState<'once' | 'unlimited' | 'limited'>(draftState?.couponOnce ?? (typeof initialPayload?.maxUsesPerFriend === 'number' && initialPayload.maxUsesPerFriend > 1 ? 'limited' : init ? init.couponOnce : 'once'))
  const [countTouched, setCountTouched] = useState(draftState?.countTouched ?? (false))
  const [couponVisibility, setCouponVisibility] = useState<'friends' | 'link'>(draftState?.couponVisibility ?? (init ? init.couponVisibility : 'friends'))
  const [lottery, setLottery] = useState(draftState?.lottery ?? (init ? init.lottery : false))
  const [lotteryRate, setLotteryRate] = useState(draftState?.lotteryRate ?? (init ? init.lotteryRate : '20'))
  const [winnerLimit, setWinnerLimit] = useState(draftState?.winnerLimit ?? (init ? init.winnerLimit : '500'))
  const [couponStartsAt, setCouponStartsAt] = useState(draftState?.couponStartsAt ?? (init ? init.startsAt : visual ? '2026-08-01T00:00' : ''))
  const [couponEndsAt, setCouponEndsAt] = useState(draftState?.couponEndsAt ?? (init ? init.endsAt : visual ? '2026-08-31T23:59' : ''))
  const [couponUseActions, setCouponUseActions] = useState<InlineAction[]>(() => draftState?.couponUseActions ?? (readInlineActions(initialPayload?.useActions as unknown[] | undefined)))
  const initialUseActions = useRef(couponUseActions)
  // リサーチ
  const [researchStartsAt, setResearchStartsAt] = useState(draftState?.researchStartsAt ?? (init ? init.startsAt : visual ? '2026-10-01T10:00' : ''))
  const [researchEndsAt, setResearchEndsAt] = useState(draftState?.researchEndsAt ?? (init ? init.endsAt : visual ? '2026-10-15T23:59' : ''))
  const [targetTagId, setTargetTagId] = useState(() => draftState?.targetTagId ?? (host?.initialContent && 'payload' in host.initialContent && typeof host.initialContent.payload.targetTagId === 'string' ? host.initialContent.payload.targetTagId : ''))
  const [questions, setQuestions] = useState<ResearchQuestion[]>(() => draftState?.questions ?? ((init?.questions.length ? init.questions : visual ? visualQuestions() : [newQuestion()])))
  const [answerActions, setAnswerActions] = useState<InlineAction[]>(() => draftState?.answerActions ?? (readInlineActions(host?.initialContent && 'payload' in host.initialContent ? host.initialContent.payload.answerActions as unknown[] | undefined : undefined)))
  const [orderMenu, setOrderMenu] = useState<string | null>(null)
  const orderAnchor = useRef<HTMLButtonElement | null>(null)

  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (host || existing) return
    setPickedMedia(null)
    setImageUrl('')
    // 統括では上のバーのアカウントに結びつかない（編集で読み込んだ画像を消さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId])

  useEffect(() => {
    setFolders([]); setAssetFolders([]); setFolderProblem(false)
    if (!selectedAccountId || host) return
    let current = true
    if (kind === 'coupon') {
      void api.broadcastMessageAssets.folders.list(selectedAccountId).then(response => {
        if (!current) return
        if (response.success) setAssetFolders(response.data)
        else setFolderProblem(true)
      }).catch(() => { if (current) setFolderProblem(true) })
    } else {
      void api.folders.list('template', selectedAccountId).then(response => {
        if (!current) return
        if (response.success) setFolders(response.data)
        else setFolderProblem(true)
      }).catch(() => { if (current) setFolderProblem(true) })
    }
    return () => { current = false }
  }, [selectedAccountId, host, kind, folderAttempt])

  const snapshot = useMemo(() => JSON.stringify({
    tapExtras, name, folder, folderTouched, countTouched, description, couponTitle, imageUrl, pickedMedia, couponOnce, couponVisibility, lottery, lotteryRate, winnerLimit,
    couponDraft, couponStartsAt, couponEndsAt, couponUseActions, researchStartsAt, researchEndsAt, targetTagId, questions, answerActions,
  }), [tapExtras, name, folder, folderTouched, countTouched, description, couponTitle, imageUrl, pickedMedia, couponOnce, couponVisibility, lottery, lotteryRate, winnerLimit, couponDraft, couponStartsAt, couponEndsAt, couponUseActions, researchStartsAt, researchEndsAt, targetTagId, questions, answerActions])
  const [clean, setClean] = useState(() => snapshot)
  const dirty = snapshot !== clean && !saved
  const { leaveTarget, confirmLeave, cancelLeave, disarm } = useUnsavedGuard({ dirty, busy: saving || publishing })

  const [pickedChoice, setPickedChoice] = useState<Record<string, number>>({})
  const activeChoice = (question: ResearchQuestion) => {
    const failing = question.choices.findIndex((_, ci) => fields.error(`extra-${question.key}-${ci}`))
    if (failing >= 0) return failing
    const picked = pickedChoice[question.key]
    if (picked !== undefined && picked < question.choices.length) return picked
    const withExtras = question.choiceTapExtras?.findIndex((extra) => hasTapExtras(extra)) ?? -1
    return withExtras >= 0 && withExtras < question.choices.length ? withExtras : -1
  }
  const updateQuestion = (index: number, patch: Partial<ResearchQuestion>) =>
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)))
  /*
   * 質問の並べ替え（共通の並び替え）。つまみのドラッグ・上下キー・つまみを押して出る
   * 「上へ／下へ」は同じ入口を通る（押して出す並べ替えは、ドラッグできない人の代わりの操作）。
   */
  const questionOrder = useReorder({
    items: questions,
    idOf: (question) => question.key,
    disabledReason: questions.length < 2 ? '質問が1つのときは並び替えできません' : null,
    onReorder: ({ ids }) => setQuestions((prev) => {
      const byKey = new Map(prev.map((q) => [q.key, q]))
      const next = ids.map((key) => byKey.get(key)).filter((q): q is ResearchQuestion => Boolean(q))
      return next.length === prev.length ? next : prev
    }),
  })

  /*
   * 保存で落ちた欄：帯ではなく欄を赤くし、真下に理由を出して1つ目へ移る。
   * 組み立て（buildPayload）の決まりと同じ中身を欄ごとに持つ。
   */
  const fields = useFormErrors()
  fields.define('name', 'テンプレート名', () => (name.trim() ? null : `${meta.title}名を入力してください`), { required: true })
  const couponExtras = couponDraftPayload(couponDraft, initialPayload)
  const couponProblems = couponDraftProblems(couponDraft, initialPayload)
  if (kind === 'coupon') {
    fields.define('couponTitle', 'クーポン名', () => !couponTitle.trim() && (!initialPayload || Boolean(initialPayload.title)) ? 'クーポン名を入力してください' : couponTitle.length > 60 && (couponTitle !== init?.couponTitle || 'couponType' in couponExtras) ? 'クーポン名は60文字以内で入力してください' : null, { required: !initialPayload || Boolean(initialPayload.title) })
    for (const [key, label] of [['benefit', '割引の内容'], ['conditions', '利用条件'], ['code', 'クーポンコード'], ['instructions', '利用ガイド']] as const) fields.define(key, label, () => couponProblems[key])
    fields.define('tapExtras', 'ボタンの追加処理', () => tapExtrasError(tapExtras))
    fields.define('start', '使える期間の開始', () => (couponStartsAt ? null : '開始を入力してください'), { required: true })
    fields.define('end', '使える期間の終了', () => (!couponEndsAt ? '終了を入力してください' : couponStartsAt && couponEndsAt <= couponStartsAt ? '終了は開始よりあとにしてください' : null), { required: true })
    fields.define('lottery', '獲得条件', () => lottery ? '抽選には対応していません。条件なしへ変更してください' : null)
  } else {
    questions.forEach((question, index) => {
      fields.define(`q-${question.key}`, `質問 ${index + 1} の本文`, () => (question.text.trim() ? null : '質問文を入力してください'), { required: true })
      if (question.format !== 'free') fields.define(`qc-${question.key}`, `質問 ${index + 1} の選択肢`, () => (question.choices.some((choice) => choice.trim()) ? null : '選択肢を1つ以上入力してください'), { required: true })
      if (question.format !== 'free') question.choices.forEach((_, ci) => fields.define(`extra-${question.key}-${ci}`, `質問 ${index + 1} の選択肢 ${ci + 1} の追加処理`, () => tapExtrasError(question.choiceTapExtras?.[ci])))
    })
  }
  const fieldProps = (key: string, id: string) => ({ ...fields.bind(key), invalid: fields.invalid(key), 'aria-describedby': fields.invalid(key) ? `${id}-error` : undefined })

  /** 保存値を組み立てる。足りないときは理由を返す（今の画面と同じ決まり）。 */
  const buildPayload = (): { payload: Record<string, unknown> } | { error: string } => {
    if (kind === 'coupon') {
      if (!couponStartsAt || !couponEndsAt) return { error: '使える期間の開始と終了を入力してください。' }
      if (couponEndsAt <= couponStartsAt) return { error: '使える期間の終了は開始よりあとにしてください。' }
      if (lottery) {
        const rate = Number(lotteryRate)
        const limit = Number(winnerLimit)
        if (!Number.isInteger(rate) || rate < 1 || rate > 100) return { error: '当たる確率は1〜100の整数で入力してください。' }
        if (!Number.isInteger(limit) || limit < 1) return { error: '当選人数の上限は1以上の整数で入力してください。' }
      }
      return {
        payload: {
          ...initialPayload,
          ...couponExtras,
          ...(couponTitle.trim() ? { title: couponTitle.trim() } : {}),
          description: initialPayload && couponDraft.instructions === initialCouponDraft(initialPayload).instructions ? description : couponDraft.instructions.trim(),
          imageUrl,
          imageMediaId: pickedMedia?.id ?? (imageUrl === init?.imageUrl ? initialPayload?.imageMediaId ?? null : null),
          imageMediaKind: pickedMedia?.kind ?? (imageUrl === init?.imageUrl ? initialPayload?.imageMediaKind ?? null : null),
          startsAt: couponStartsAt,
          endsAt: couponEndsAt,
          oncePerFriend: couponOnce === 'limited' ? initialPayload?.oncePerFriend !== false : couponOnce === 'once',
          ...(countTouched ? { maxUsesPerFriend: couponOnce === 'unlimited' ? null : couponOnce === 'limited' ? initialPayload?.maxUsesPerFriend : 1 } : {}),
          visibility: couponVisibility,
          lottery,
          ...(lottery ? { lotteryRate: Number(lotteryRate), winnerLimit: Number(winnerLimit) } : {}),
          tapExtras,
          useActions: initialPayload?.useActions && JSON.stringify(couponUseActions) === JSON.stringify(initialUseActions.current) ? initialPayload.useActions : couponUseActions.map(toActionPayload),
        },
      }
    }
    if (questions.length === 0) return { error: '質問を1つ以上作ってください。' }
    for (const [index, question] of questions.entries()) {
      if (!question.text.trim()) return { error: `質問 ${index + 1} の本文を入力してください。` }
      if (question.format !== 'free' && question.choices.filter((choice) => choice.trim()).length < 1) {
        return { error: `質問 ${index + 1} の選択肢を1つ以上入力してください。` }
      }
    }
    return {
      payload: {
        description,
        startsAt: researchStartsAt || null,
        endsAt: researchEndsAt || null,
        targetTagId: targetTagId || null,
        questions: questions.map((question) => ({
          choiceTapExtras: question.format === 'free' ? [] : question.choices.flatMap((choice, ci) => choice.trim() ? [question.choiceTapExtras?.[ci] ?? {}] : []),
          text: question.text.trim(),
          format: question.format,
          required: question.required,
          choices: question.format === 'free' ? [] : question.choices.map((choice) => choice.trim()).filter(Boolean),
        })),
        questionCount: questions.length,
        answerActions: answerActions.map(toActionPayload),
      },
    }
  }

  const save = async (publishAsset = false): Promise<string | false> => {
    if (host || !canMutate) return false
    if (!selectedAccountId) { setError('上のバーでLINE公式アカウントを選んでください。'); return false }
    if (fields.submit().length > 0) { setError(''); return false }
    const built = buildPayload()
    if ('error' in built) { setError(built.error); return false }
    setSaving(true)
    setError('')
    try {
      const legacyFolder = kind === 'coupon'
        ? folderTouched || !initialPayload
          ? assetFolders.find(item => item.id === folder)?.name ?? ''
          : typeof initialPayload.folder === 'string' ? initialPayload.folder : ''
        : folder
      const id = await persistAsset(name.trim(), { ...built.payload, folder: legacyFolder }, kind === 'coupon' ? folder || null : null, snapshot, publishAsset)
      setSaved(true)
      setClean(snapshot)
      return id
    } catch (caught) {
      if (caught instanceof AssetPublishError) {
        setError(`下書きは保存しましたが、公開を確認できませんでした。${japaneseDetailOf(caught.cause) || 'もう一度公開してください。'}`)
        return false
      }
      const extraError = tapExtraSaveError(caught)
      if (extraError) {
        if (kind === 'coupon') fields.fail('tapExtras', extraError)
        else fields.setServerErrors(Object.fromEntries(questions.flatMap(q => q.choices.map((_, ci) => [`extra-${q.key}-${ci}`, extraError]))))
        return false
      }
      const fieldFailure = saveErrors.capture(caught, fields)
      if (!fieldFailure) setError(japaneseDetailOf(caught) || '保存できませんでした。通信状態を確認して、もう一度お試しください。')
      return false
    } finally {
      setSaving(false)
    }
  }

  // 一時下書きは保存の検査・整形から分け、空欄や入力途中の文字も保つ。
  useEffect(() => {
    if (!host?.onDraftChange) return
    host.onDraftChange({ kind, name, payload: initialPayload ?? {}, editorState: {
      couponDraft, description, couponTitle, imageUrl, tapExtras, pickedMedia, couponOnce, countTouched,
      couponVisibility, lottery, lotteryRate, winnerLimit, couponStartsAt, couponEndsAt, couponUseActions,
      researchStartsAt, researchEndsAt, targetTagId, questions, answerActions,
    } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot])
  /* 統括の入口：中身を組み立てて呼ぶ側へ渡す（保存・配る・失敗の知らせは呼ぶ側）。 */
  const hostSave = async (distribute: boolean) => {
    if (!host || !canMutate) return
    if (fields.submit().length > 0) { setError(''); return }
    const built = buildPayload()
    if ('error' in built) { setError(built.error); return }
    setError('')
    try {
      const result = await host.onSave({ kind, name: name.trim(), payload: built.payload }, distribute)
      if (result !== false) setClean(snapshot)
    } catch (caught) {
      if (!saveErrors.capture(caught, fields)) setError(japaneseDetailOf(caught) || '保存できませんでした。もう一度お試しください。')
    }
  }
  const onSaveDraft = async () => {
    if (host) { await hostSave(false); return }
    const savedId = await save()
    if (savedId) { notifySaved('下書きを保存しました'); disarm(); router.push(createPageReturnHref('/templates', savedId)) }
  }
  const onPublish = async () => {
    if (host) { await hostSave(true); return }
    setPublishing(true)
    try {
      const savedId = await save(true)
      if (savedId) {
        disarm()
        router.push(createPageReturnHref('/templates', savedId))
      }
    } finally {
      setPublishing(false)
    }
  }

  const sendName = host ? host.accountName || '公式アカウント' : accounts.find((account) => account.id === selectedAccountId)?.name ?? '公式アカウント'
  const inputReason = requiredInputReason([
    { label: 'テンプレート名', value: name },
    ...(kind === 'coupon' ? [
      { label: 'クーポン名', value: Boolean(initialPayload && !initialPayload.title) || couponTitle },
      { label: '使える期間の開始', value: couponStartsAt },
      { label: '使える期間の終了', value: couponEndsAt },
      { label: '割引額', value: couponDraft.couponType !== 'discount' || couponDraft.mode !== 'amount' || couponDraft.amount },
      { label: '割引率', value: couponDraft.couponType !== 'discount' || couponDraft.mode !== 'percent' || couponDraft.percent },
      { label: '割引前の金額', value: couponDraft.couponType !== 'discount' || couponDraft.mode !== 'price' || couponDraft.before },
      { label: '割引後の金額', value: couponDraft.couponType !== 'discount' || couponDraft.mode !== 'price' || couponDraft.after },
      { label: '表示するコード', value: !couponDraft.showCode || couponDraft.code },
      { label: '使うときの説明', value: couponDraft.instructions },
    ] : questions.flatMap((question, index) => [
      { label: `質問 ${index + 1} の本文`, value: question.text },
      { label: `質問 ${index + 1} の選択肢`, value: question.format === 'free' || question.choices.some(choice => Boolean(choice.trim())) },
    ])),
  ])
  const blocked = saved ? '保存しました。一覧へ戻ってください。' : null
  const busy = saving || publishing || Boolean(host?.busy)
  const imageSet = /^https?:\/\//.test(imageUrl.trim())

  const sideCard = kind === 'coupon' ? (
    <section className={styles.sideCard}>
      <h2 className={styles.sideTitle}>公開したあとに見られる数</h2>
      <dl className={styles.statList}>
        <div className={styles.statRow}><dt>配った数</dt><dd>{emptyValue('unknown')}</dd></div>
        <div className={styles.statRow}><dt>使われた数</dt><dd>{emptyValue('unknown')}</dd></div>
        {lottery ? <div className={styles.statRow}><dt>当選した数</dt><dd>{emptyValue('unknown')}</dd></div> : null}
      </dl>
    </section>
  ) : (
    <section className={styles.sideCard}>
      <h2 className={styles.sideTitle}>回答フォームとの使い分け</h2>
      <p className={styles.sideText}>リサーチはLINEの中で完結する短い質問向けです。住所や画像も聞く場合は回答フォームを使います。</p>
    </section>
  )

  /* リサーチはお客さまが答える画面（LIFF）で見せる。回答フォームの LIFF と同じ形。 */
  const researchLayout: FormLayout = {
    version: 2,
    header: [],
    sections: [{ id: 'research', name: '', blocks: [
      { id: 'research-title', kind: 'heading', text: name || 'リサーチ名', level: 1 },
      { id: 'research-lead', kind: 'text', text: `${questions.length}問・1分で終わります${researchEndsAt ? `（${shortDate(researchEndsAt)} まで）` : ''}` },
      ...questions.map((question, index): FormBlock => ({
        id: question.key,
        kind: 'input',
        type: question.format === 'single' ? 'radio' : question.format === 'multiple' ? 'checkbox' : 'textarea',
        name: question.key,
        label: question.text || `問 ${index + 1}`,
        required: question.required,
        choices: question.format === 'free' ? [] : question.choices.flatMap((choice, ci) => (choice.trim() ? [{ id: `${question.key}-${ci}`, label: choice }] : [])),
      })),
    ] }],
    options: { submitLabel: '答えを送る' },
  }
  const phone = kind === 'research' ? (
    <FormPhone layout={researchLayout} pageIndex={0} accountName={sendName} bookingMenus={[]} caption={null} title={name || 'リサーチ'} fixedNext progressHead />
  ) : (
    <CouponPreview payload={{ ...initialPayload, ...couponExtras, title: couponTitle || name, description, imageUrl,
      startsAt: couponStartsAt, endsAt: couponEndsAt,
      oncePerFriend: couponOnce === 'limited' ? initialPayload?.oncePerFriend !== false : couponOnce === 'once',
      ...(countTouched ? { maxUsesPerFriend: couponOnce === 'unlimited' ? null : couponOnce === 'limited' ? initialPayload?.maxUsesPerFriend : 1 } : {}),
    }} name={name} accountName={sendName} />
  )

  if (!canMutate && kind !== 'coupon') {
    return (
      <SaveErrorScope errors={saveErrors}><TemplateEditFrame
        boardId={meta.board}
        title={meta.heading}
        description={meta.lead}
        band={<ReadOnlyNotice>閲覧のみ：テンプレートの作成・変更はオーナーと管理者だけができます。</ReadOnlyNotice>}
        side={sideCard}
      >
        <Card variant="form" gap="normal">
          <p className={styles.cardNote}>中身の確認は一覧の行を開くと読めます。</p>
        </Card>
      </TemplateEditFrame></SaveErrorScope>
    )
  }

  const nameCard = (
    <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="名前とフォルダ" />
      <SettingsFormRow layout="name-folder">
        <div className={styles.field}><Field label="テンプレート名" htmlFor={`te-${kind}-name`} requirement={fields.requirement('name')}><SaveErrorField names={["name"]}><TextField {...fieldProps('name', `te-${kind}-name`)} id={`te-${kind}-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === 'coupon' ? '例：夏の20%オフ' : '例：定期便のご満足度'} aria-required="true" /></SaveErrorField>
<FieldError id={`te-${kind}-name-error`}>{fields.error('name')}</FieldError></Field></div>
        <div className={styles.field}><Field label="フォルダ" htmlFor={`te-${kind}-folder`}><SaveErrorField names={["folder","folderId","host.folder"]}><FolderSelect size="full"
            id={`te-${kind}-folder`}
            aria-label="フォルダ"
            value={host ? host.folder : folder}
            onChange={host ? host.onFolderChange : value => { setFolder(value); setFolderTouched(true) }}
            folders={host ? host.folders : kind === 'coupon' ? assetFolders.map(item => ({ value: item.id, label: item.name })) : folders.map(folderByName)}
            colors={kind !== 'coupon'}
            onCreate={host
              ? hostFolderCreate(host)
              : canMutate && selectedAccountId
                ? kind === 'coupon'
                  ? folderCreator(name => api.broadcastMessageAssets.folders.create(selectedAccountId, name), item => { if (!item) throw new FolderCreateError('作成したフォルダを確認できませんでした。読み直してください'); return { value: item.id, label: item.name } }, created => { if (created) setAssetFolders(current => [...current, created]) })
                  : folderCreator((name, color) => api.folders.create({ kind: 'template', name, color, accountId: selectedAccountId }), folderByName, (created) => setFolders((current) => [...current, created]))
                : undefined}
          /></SaveErrorField></Field></div>
      </SettingsFormRow>
    </Card>
  )

  return (
    <SaveErrorScope errors={saveErrors}><>
      <TemplateEditFrame
        inputReason={inputReason}
        boardId={meta.board}
        title={existing && kind === 'coupon' ? 'クーポンを編集する' : meta.heading}
        description={meta.lead}
        band={!canMutate ? <ReadOnlyNotice /> : undefined}
        side={(inDialog) => (
          <>
            {sideCard}
            <h2 className={styles.previewHead} title="この形式は、いまの画面から自分へのテスト送信ができません。保存して一斉配信に組み込むと、配信の画面からテスト送信できます。">{kind === 'coupon' ? '受け取った人の画面' : '届き方'}</h2>
            <div className={inDialog ? styles.previewDialog : styles.phone}>{phone}</div>
          </>
        )}
        footerInfo={host ? undefined : <TemplatePublishNote />}
        footerActions={(
          <>
            {host ? <Button type="button" onClick={host.onCancel}>キャンセル</Button> : <Button href="/templates">キャンセル</Button>}
            <Button type="button" onClick={() => void onSaveDraft()} disabled={busy || Boolean(blocked) || !canMutate && !permissionReason} lockedReason={permissionReason} title={blocked ?? undefined} busy={saving && !publishing} busyLabel="保存中…">
              下書きを保存
            </Button>
            <Button type="button" variant="primary" onClick={() => void onPublish()} disabled={busy || Boolean(blocked) || Boolean(inputReason) || !canMutate && !permissionReason} disabledReason={inputReason} lockedReason={permissionReason} title={blocked ?? undefined}  busy={publishing || Boolean(host?.busy)} busyLabel="保存中…">
              {host ? null : <Upload size={16} aria-hidden="true" />}
              {host ? host.primaryLabel ?? '保存する' : '保存して公開'}
            </Button>
          </>
        )}
      >
        {host?.notice}
        {error ? <Notice tone="danger" >{error}</Notice> : null}
        {null}
        {folderProblem ? <Notice tone="warn" message="フォルダを読み込めませんでした。保存先を確認してから保存してください。" action={<Button type="button" onClick={() => setFolderAttempt(value => value + 1)}>再読み込み</Button>} /> : null}
        <fieldset className="contents" disabled={kind !== 'coupon' && (!canMutate || busy)} aria-label="テンプレートの入力">
        {kind === 'coupon' ? <fieldset className="contents" disabled={!canMutate || busy}>{nameCard}</fieldset> : nameCard}

        {kind === 'coupon' ? (
          <>
            <CouponSettings disabled={!canMutate || busy} draft={couponDraft} onChange={patch => setCouponDraft(current => ({ ...current, ...patch }))}
              title={couponTitle} onTitleChange={setCouponTitle} titleRequirement={fields.requirement('couponTitle')} fields={fields} lottery={lottery} onRemoveLottery={() => setLottery(false)} image={<div className={styles.couponFields}>
                  <SaveErrorField names={["imageUrl","image_url"]}><ImageFrame
                    title="画像を追加"
                    lockedReason={permissionReason}
                    disabled={busy || !canMutate && !permissionReason}
                    canChangeNow={() => canMutate && !busy}
                    previewAlt="クーポンの画像"
                    value={imageSet ? imageUrl.trim() : null}
                    accept="image/jpeg,image/png"
                    help="JPG・JPEG・PNG、10MB以下"
                    maxBytes={10 * 1024 * 1024}
                    upload={!host && selectedAccountId ? async (file, progress) => {
                      const result = await uploadToMediaLibrary(file, selectedAccountId, 'image', progress)
                      setPickedMedia(result.item)
                      return result.url
                    } : undefined}
                    onChange={(url) => { setImageUrl(url ?? ''); setPickedMedia(null) }}
                    onMediaPick={host ? undefined : () => setPickerOpen(true)}
                    urlEntry={{ value: imageUrl, onChange: (url) => { setImageUrl(url); setPickedMedia(null) }, label: 'クーポン画像のURL', placeholder: '画像URL' }}
                  /></SaveErrorField>
                  {pickedMedia ? <p className={styles.hint}>選択中：{pickedMedia.filename}</p> : null}
              </div>} />

            <fieldset className="contents" disabled={!canMutate || busy}><Card variant="form" gap="normal">
              <CardHeader size="stacked" title="使える期間と回数" meta="日本時間（UTC+09:00）" />
              <SettingsFormRow layout="columns">
                <div className={styles.field}><Field label="開始" htmlFor="te-coupon-start" requirement={fields.requirement('start')}><span {...fields.bind('start')}><SaveErrorField names={["couponStartsAt","startsAt","coupon_starts_at"]}><DateTimeField className={styles.dateBox} id="te-coupon-start" value={couponStartsAt} onChange={setCouponStartsAt} aria-label="使える期間の開始" required invalid={fields.invalid('start')} aria-describedby={fields.invalid('start') ? 'te-coupon-start-error' : undefined} /></SaveErrorField></span>
<FieldError id="te-coupon-start-error">{fields.error('start')}</FieldError></Field></div>

                <div className={styles.field}><Field label="終了" htmlFor="te-coupon-end" requirement={fields.requirement('end')}><span {...fields.bind('end')}><SaveErrorField names={["couponEndsAt","endsAt","coupon_ends_at"]}><DateTimeField className={styles.dateBox} id="te-coupon-end" value={couponEndsAt} onChange={setCouponEndsAt} aria-label="使える期間の終了" required invalid={fields.invalid('end')} aria-describedby={fields.invalid('end') ? 'te-coupon-end-error' : undefined} /></SaveErrorField></span>
<FieldError id="te-coupon-end-error">{fields.error('end')}</FieldError></Field></div>
              </SettingsFormRow>
              <div className={styles.typeRow}>
                <span className={styles.labelSmall}>1人が使える回数</span>
                <SaveErrorField names={["couponOnce"]}><SegmentedControl
                  aria-label="1人が使える回数"
                  options={[{ value: 'once' as const, label: '1人1回だけ' }, { value: 'unlimited' as const, label: '期間中なら何回でも' }, ...(typeof initialPayload?.maxUsesPerFriend === 'number' && initialPayload.maxUsesPerFriend > 1 ? [{ value: 'limited' as const, label: `1人${initialPayload.maxUsesPerFriend}回` }] : [])]}
                  value={couponOnce}
                  onChange={value => { setCountTouched(true); setCouponOnce(value); setCouponDraft(current => current.instructions === defaultCouponInstructions(couponOnce !== 'unlimited') ? { ...current, instructions: defaultCouponInstructions(value !== 'unlimited') } : current) }}
                /></SaveErrorField>
              </div>
              <div className={styles.typeRow}>
                <span className={styles.labelSmall}>受け取れる人</span>
                <SaveErrorField names={["couponVisibility"]}>{initialPayload?.visibility === 'link' ? <SegmentedControl
                  aria-label="受け取れる人"
                  options={[{ value: 'friends' as const, label: '友だちだけ' }, ...(initialPayload?.visibility === 'link' ? [{ value: 'link' as const, label: 'リンクを知っている人（保存済み）' }] : [])]}
                  value={couponVisibility}
                  onChange={setCouponVisibility}
                /> : <span>友だちだけ</span>}</SaveErrorField>
              </div>
            </Card>

            <CouponGuide draft={couponDraft} onChange={patch => setCouponDraft(current => ({ ...current, ...patch }))} fields={fields} />

            <Card variant="form" gap="normal">
              <CardHeader size="stacked" titleId="coupon-use-actions" title="クーポンを使ったときに行うこと" />
              <Field label="タグ・スコア"><div {...fields.bind("tapExtras")}><TapExtrasField actionLabel="タグ・スコア" addButtonVariant="secondary" error={fields.error("tapExtras")} name="クーポンのボタン" value={tapExtras} onChange={extra => { fields.clear("tapExtras"); setTapExtras(extra) }} accountId={host ? null : selectedAccountId} /></div></Field>
              {host ? null : <Field label="そのほかの処理"><InlineActionRowsV8 actions={couponUseActions} onChange={setCouponUseActions} {...actionOptions} /></Field>}
            </Card></fieldset>
          </>
        ) : (
          <>
            <Card variant="form" gap="normal">
              <CardHeader size="stacked" title="受付" />
              <SettingsFormRow layout="columns">
                <div className={styles.field}><Field label="受付の開始" htmlFor="te-research-start"><SaveErrorField names={["researchStartsAt","startsAt","research_starts_at"]}><DateTimeField className={styles.dateBox} id="te-research-start" value={researchStartsAt} onChange={setResearchStartsAt} aria-label="受付の開始" /></SaveErrorField></Field></div>

                <div className={styles.field}><Field label="受付の終了" htmlFor="te-research-end"><SaveErrorField names={["researchEndsAt","endsAt","research_ends_at"]}><DateTimeField className={styles.dateBox} id="te-research-end" value={researchEndsAt} onChange={setResearchEndsAt} aria-label="受付の終了" /></SaveErrorField></Field></div>
              </SettingsFormRow>
              <div className={styles.field}><Field label="はじめのあいさつ" htmlFor="te-research-greeting"><SaveErrorField names={["description"]}><TextField id="te-research-greeting" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例：いつもありがとうございます。3問だけ聞かせてください。" /></SaveErrorField></Field></div>
            </Card>

            <Card variant="form" gap="normal">
              <CardHeader size="stacked" title="質問（上から順に出ます）" />
              {questionOrder.shown.map((question, index) => (
                <section key={question.key} className={styles.question} aria-label={`問 ${index + 1}`} {...questionOrder.rowProps(question.key)}>
                  <div className={styles.toggleRow}>
                    <ReorderHandle
                      look="bare"
                      className={styles.grip}
                      label={`問 ${index + 1}`}
                      ariaLabel={`問 ${index + 1} の並びを変更する。ドラッグ・上下キー・押して上へ／下へ`}
                      aria-haspopup="menu"
                      aria-expanded={orderMenu === question.key}
                      onClick={(event) => { orderAnchor.current = event.currentTarget; setOrderMenu(orderMenu === question.key ? null : question.key) }}
                      {...questionOrder.handle(question.key)}
                      {...questionOrder.handleProps(question.key)}
                    >
                      <GripVertical size={16} aria-hidden="true" />
                    </ReorderHandle>
                    <span className={styles.questionNo}>問 {index + 1}</span>
                    <span className={styles.spacer} />
                    <span className={styles.toggleLabelSmall}>必ず答えてもらう</span>
                    <SaveErrorField names={[`shown.${index}.required`,"required","question.required"]}><Toggle checked={question.required} label={`問 ${index + 1} を必ず答えてもらう`} onChange={(checked) => updateQuestion(index, { required: checked })} /></SaveErrorField>
                    <button
                      type="button"
                      className={styles.insertChip}
                      disabled={questions.length <= 1}
                      title={questions.length <= 1 ? '質問は1つ必要です' : `問 ${index + 1} を消す`}
                      aria-label={`問 ${index + 1} を消す`}
                      onClick={() => setQuestions((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      削除する
                    </button>
                  </div>
                  <SettingsFormRow layout="columns">
                    <div className={styles.field}><Field label="質問文" htmlFor={`te-q-${question.key}`} requirement={fields.requirement(`q-${question.key}`)}><SaveErrorField names={[`shown.${index}.text`,"text","question.text"]}><TextField {...fieldProps(`q-${question.key}`, `te-q-${question.key}`)} id={`te-q-${question.key}`} value={question.text} onChange={(event) => updateQuestion(index, { text: event.target.value })} placeholder="例：来月も続けたいと思いますか？" aria-required="true" /></SaveErrorField>
<FieldError id={`te-q-${question.key}-error`}>{fields.error(`q-${question.key}`)}</FieldError></Field></div>
                    <div className={styles.field}><Field label="答え方" htmlFor={`te-qf-${question.key}`}><SaveErrorField names={[`shown.${index}.format`,"format","question.format"]}><Select id={`te-qf-${question.key}`} aria-label={`問 ${index + 1} の答え方`} value={question.format} onChange={(value) => updateQuestion(index, { format: value as ResearchFormat })} options={FORMAT_OPTIONS} /></SaveErrorField></Field></div>
                  </SettingsFormRow>
                  {question.format !== 'free' ? (
                    <>
                    <div className={styles.choiceRow} role="group" aria-label={`問 ${index + 1} の選択肢`} {...fields.bind(`qc-${question.key}`)} aria-describedby={fields.invalid(`qc-${question.key}`) ? `te-qc-${question.key}-error` : undefined}>
                      {question.choices.map((choice, choiceIndex) => (
                        <InputFieldFrame key={choiceIndex} className={styles.choice} aria-invalid={fields.invalid(`qc-${question.key}`) || undefined} data-selected={choiceIndex === activeChoice(question) || undefined}>
                          <SaveErrorField names={["choice"]}><SharedTextField
                            className={styles.choiceInput}
                            value={choice}
                            placeholder={`選択肢 ${choiceIndex + 1}`}
                            aria-label={`問 ${index + 1} の選択肢 ${choiceIndex + 1}`}
                            aria-invalid={fields.invalid(`qc-${question.key}`) || undefined}
                            aria-describedby={fields.invalid(`qc-${question.key}`) ? `te-qc-${question.key}-error` : undefined}
                            title="押すと、この選択肢が選ばれたときに行うことを足せます"
                            onFocus={() => setPickedChoice((current) => ({ ...current, [question.key]: choiceIndex }))}
                            onChange={(event) => updateQuestion(index, { choices: question.choices.map((c, i) => (i === choiceIndex ? event.target.value : c)) })}
                          /></SaveErrorField>
                          {question.choices.length > 1 ? (
                            <button
                              type="button"
                              className={styles.choiceRemove}
                              aria-label={`問 ${index + 1} の選択肢 ${choiceIndex + 1} を消す`}
                              onClick={() => { setPickedChoice((current) => ({ ...current, [question.key]: -1 })); updateQuestion(index, { choices: question.choices.filter((_, i) => i !== choiceIndex), choiceTapExtras: question.choiceTapExtras?.filter((_, i) => i !== choiceIndex) }) }}
                            >
                              <X size={16} aria-hidden="true" />
                            </button>
                          ) : null}
                        </InputFieldFrame>
                      ))}
                      {question.choices.length < MAX_CHOICES ? (
                        <button type="button" className={styles.insertChip} onClick={() => updateQuestion(index, { choices: [...question.choices, ''] })}>
                          <Plus size={16} aria-hidden="true" />
                          選択肢を足す
                        </button>
                      ) : (
                        <span className={styles.hint}>選択肢は{MAX_CHOICES}つまでです（LINEの決まり）。</span>
                      )}
                    </div>
                    <FieldError id={`te-qc-${question.key}-error`}>{fields.error(`qc-${question.key}`)}</FieldError>
                    {(() => {
                      const ci = activeChoice(question)
                      if (ci < 0) return null
                      const label = question.choices[ci]?.trim() || `選択肢 ${ci + 1}`
                      return <>
                        <p className={styles.choiceWhen}>{`選択肢「${label}」が選ばれたら`}</p>
                        <div {...fields.bind(`extra-${question.key}-${ci}`)}><ChoiceExtrasRows key={`${question.key}-${ci}`} error={fields.error(`extra-${question.key}-${ci}`)} name={`問${index + 1}の選択肢${ci + 1}`} value={question.choiceTapExtras?.[ci]} tags={actionOptions.tags} accountId={host ? null : selectedAccountId} onChange={extra => updateQuestion(index, { choiceTapExtras: question.choices.map((_, i) => i === ci ? extra : question.choiceTapExtras?.[i] ?? {}) })} /></div>
                      </>
                    })()}
                    </>
                  ) : null}
                </section>
              ))}
              <div>
                <button
                  type="button"
                  className={styles.insertChip}
                  disabled={questions.length >= MAX_QUESTIONS}
                  title={questions.length >= MAX_QUESTIONS ? `質問は${MAX_QUESTIONS}問までです` : `あと${MAX_QUESTIONS - questions.length}問足せます`}
                  onClick={() => setQuestions((prev) => (prev.length >= MAX_QUESTIONS ? prev : [...prev, newQuestion()]))}
                >
                  <Plus size={16} aria-hidden="true" />
                  質問を足す
                </button>
              </div>
            </Card>

            {host ? null : (
            <>
            <Card variant="form" gap="normal">
              <CardHeader size="stacked" title="答え終わったときに行うこと" />
              <InlineActionRowsV8 actions={answerActions} onChange={setAnswerActions} {...actionOptions} />
            </Card>

            <Card variant="form" gap="normal">
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle}>答えてもらう人</h2>
                <p className={styles.cardNote}>タグで絞れます。選ばなければ全員が対象です。</p>
              </div>
              <SaveErrorField names={["targetTagId","target_tag_id"]}><EntitySelect clearable size="full" kind="tag"
                aria-label="答えてもらう人"
                placeholder="友だち全員"
                value={targetTagId}
                onChange={setTargetTagId}
                options={actionOptions.tags.map((tag) => ({ ...entityOptionMetadata(tag), value: tag.id, label: tag.name }))}
              /></SaveErrorField>
            </Card>
            </>
            )}
          </>
        )}
        </fieldset>
      </TemplateEditFrame>

      <ActionMenu
        open={orderMenu !== null}
        anchorRef={orderAnchor}
        ariaLabel="質問の並びを変更する"
        onClose={() => setOrderMenu(null)}
        items={orderMenu ? questionOrder.menuItems(orderMenu, () => setOrderMenu(null)).map((item) => ({ ...item, id: item.id === 'move-up' ? 'up' : 'down', disabledReason: undefined })) : []}
      />


      <MediaPickerDialog
        open={pickerOpen}
        accountId={selectedAccountId}
        kind="image"
        onClose={() => setPickerOpen(false)}
        onSelect={(item) => { setImageUrl(item.url); setPickedMedia(item); setPickerOpen(false) }}
      />

      <UnsavedLeaveDialog open={leaveTarget !== null} subject={`${meta.title}の変更`} onConfirm={confirmLeave} onCancel={cancelLeave} />
    </></SaveErrorScope>
  )
}
