'use client'
import { requiredInputReason } from '@/lib/required-input-reason'

import { SettingsFormRow } from '@/components/shared/settings-form-card'

import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { createPageReturnHref } from '@/components/shared/create-page'
import { notifySaved } from '@/components/shared/toast'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useEffect, useMemo, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { CircleSlash, Upload } from 'lucide-react'
import { type TapExtras, type Folder, type MediaItem, type TemplateImagemapUpload } from '@line-crm/shared'
import { api } from '@/lib/api'
import { useStaffRole } from '@/lib/staff-role'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useAccount } from '@/contexts/account-context'
import { usePageTitle } from '@/components/shell/page-chrome'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import LayoutPicker from '@/components/shared/layout-picker'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import LinePreview from '@/components/shared/line-preview'
import TapAreaEditor from '@/components/shared/tap-area-editor'
import FolderSelect, { folderByName, folderCreator, hostFolderCreate } from '@/components/shared/folder-select'
import { TextField } from '@/components/shared/text-field'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import TapActionField from '@/components/shared/tap-action-field'
import { FieldError, Field } from '@/components/shared/form-controls'
import { useFormErrors } from '@/lib/use-form-errors'
import { useTapActionSources } from '@/components/shared/use-tap-action-sources'
import { TAP_ACTION_KINDS, tapActionDef, tapActionFromSavedUri, tapActionLiffUrl, tapActionNeedsLiff, tapActionProblem, tapExtraSaveError, type TapActionKind } from '@/lib/tap-actions'
import { TemplateEditFrame, TemplatePublishNote } from './frame'
import { AssetPublishError, useCouponPersistence } from './use-coupon-persistence'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import MediaSlot from '@/components/shared/media-slot'
import { uploadToMediaLibrary } from '@/components/shared/media-library-upload'
import type { TemplateEditHost } from './host'
import styles from './edit.module.css'
import rich from './rich.module.css'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

/*
 * ★V8「リッチメッセージを作る」（絵の機能追加 F-4）。
 *
 * 1枚の画像を面に分けて、押した面ごとに動く。形（面の分け方）・画像・面ごとの動きを決める。
 * 保存は今の画面（app/templates/asset-editor-v8.tsx・template-asset-editor.tsx）と同じ口
 * （POST /api/broadcast-message-assets、kind=rich_message）・同じ形の payload。
 * 形・面の座標・動きの組み立ては template-asset-editor.tsx から写した（src/v8 は @/app を読めない）。
 * 外枠・名前とフォルダの箱・右の列はクーポン・リサーチ（asset.tsx）と同じ。動きは BEHAVIOR.md。
 */

/* ── 形と面（template-asset-editor.tsx と同じ値） ── */
export interface RichArea { label: string; x: number; y: number; width: number; height: number }
export interface RichShape { value: string; label: string; rows: string[][]; areas: RichArea[] }

export function buildAreas(rows: string[][]): RichArea[] {
  const height = 100 / rows.length
  return rows.flatMap((labels, rowIndex) => {
    const width = 100 / labels.length
    return labels.map((label, colIndex) => ({
      label,
      x: Math.round(colIndex * width * 100) / 100,
      y: Math.round(rowIndex * height * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    }))
  })
}

const shape = (value: string, label: string, rows: string[][]): RichShape => ({ value, label, rows, areas: buildAreas(rows) })
export const RICH_SHAPES: RichShape[] = [
  shape('1', '1面', [['A']]),
  shape('2v', '上下2面', [['A'], ['B']]),
  shape('2h', '左右2面', [['A', 'B']]),
  shape('3', '上1・下2', [['A'], ['B', 'C']]),
  shape('4', '4面', [['A', 'B'], ['C', 'D']]),
  shape('6', '6面', [['A', 'B', 'C'], ['D', 'E', 'F']]),
]

/** 面の場所の呼び名（「A 上」「B 左下」など）。座標から決める。 */
export function areaPlace(area: RichArea, all: RichArea[]): string {
  const rows = new Set(all.map((a) => a.y)).size
  const cols = all.filter((a) => a.y === area.y).length
  const v = rows === 1 ? '' : area.y === 0 ? '上' : '下'
  const right = area.x + area.width >= 99.9
  const h = cols === 1 ? '' : area.x === 0 ? '左' : right ? '右' : '中'
  return `${h}${v}` || '全体'
}

/*
 * 面を押したら（共通の欄 TapActionField・YPzmo）：未設定＋6つ。LINE のリッチメッセージ（イメージマップ）は
 * URL とメッセージしか持てない（postback は保存で断られる：packages/shared の richMessageActions
 * 「イメージマップはpostbackに対応していません」）ので、前の「動きを実行する」は外した。
 * 予約・回答フォーム・予約履歴・来店スタンプはアカウントの LIFF の URL（uri）で保存する。
 */
export type AreaActionKind = 'none' | TapActionKind
export interface AreaDraft { tapExtras?: TapExtras; kind: AreaActionKind; uri: string; text: string; refId: string }
export const emptyAreaDraft = (): AreaDraft => ({ kind: 'none', uri: '', text: '', refId: '' })
export const areaDraftConfigured = (draft: AreaDraft | undefined): boolean => Boolean(draft && draft.kind !== 'none')

/** 統括（host）：URL・テキストだけ（配った先の LIFF に付け替える口がまだ無い。できたら6つにする）。 */
const HOST_AREA_KINDS: readonly TapActionKind[] = ['uri', 'message']
const AREA_NONE_KIND = [{ value: 'none', label: '未設定', description: '押しても何も起きない', icon: CircleSlash }] as const
/** リッチメッセージで送れる文の長さ（packages/shared richMessageActions と同じ）。 */
export const RICH_MESSAGE_TEXT_MAX = 400

/** 見本の中身（?visual=1）。絵 ：上下2面・上は URL・下はテキスト。 */
function visualAreas(): Record<string, AreaDraft> {
  return {
    A: { kind: 'uri', uri: 'https://nen.example/summer', text: '', refId: '' },
    B: { kind: 'message', uri: '', text: '夏のセットについて知りたい', refId: '' },
  }
}

/** 保存値（payload）を組み立てる。足りないときは理由を返す（今の画面と同じ決まり）。 */
function richAreaProblem(draft: AreaDraft, where: string, hasLiff: boolean): string | null {
  return tapActionProblem(draft, { where, hasLiff, textMax: RICH_MESSAGE_TEXT_MAX })
}

export function buildRichPayload(input: {
  imageUrl: string
  pickedMedia: MediaItem | null
  shape: RichShape
  areas: Record<string, AreaDraft>
  /** 保存先アカウントの LIFF ID（予約・回答フォーム・予約履歴・来店スタンプの URL に入れる）。 */
  liffId?: string | null
}): { payload: Record<string, unknown> } | { error: string } {
  if (!input.imageUrl.trim()) return { error: '画像を設定してください。' }
  for (const area of input.shape.areas) {
    const draft = input.areas[area.label]
    if (!draft || draft.kind === 'none') continue
    if (draft.kind === 'uri' && !draft.uri.trim()) return { error: `面 ${area.label} のURLを入力してください。` }
    const problem = richAreaProblem(draft, `面 ${area.label} `, Boolean(input.liffId))
    if (problem) return { error: `${problem}。` }
  }
  return {
    payload: {
      imageUrl: input.imageUrl.trim(),
      imageMediaId: input.pickedMedia?.id ?? null,
      imageMediaKind: input.pickedMedia?.kind ?? null,
      shape: input.shape.value,
      tapAreas: input.shape.areas.map((area) => {
        const draft = input.areas[area.label] ?? emptyAreaDraft()
        return {
          ...(draft.tapExtras ? { tapExtras: draft.tapExtras } : {}),
          label: area.label,
          x: area.x,
          y: area.y,
          width: area.width,
          height: area.height,
          actionType: draft.kind === 'none' ? 'none' : draft.kind === 'message' ? 'message' : 'uri',
          ...(draft.kind === 'uri' ? { uri: draft.uri.trim() } : {}),
          ...(draft.kind === 'message' ? { text: draft.text.trim() } : {}),
          ...(tapActionNeedsLiff(draft.kind) && input.liffId ? { uri: tapActionLiffUrl(input.liffId, draft.kind, draft.refId) } : {}),
        }
      }),
    },
  }
}

/** 統括の編集で読み込んだリッチメッセージを、画面の値に戻す。形が分からなければ面の数から選ぶ。 */
function richInitial(host: TemplateEditHost | undefined) {
  const content = host?.initialContent
  if (!content || content.kind !== 'rich_message') return null
  if (content.editorState) return { name: content.name, shape: content.editorState.shapeValue, ...content.editorState }
  const payload = content.payload
  const taps = Array.isArray(payload.tapAreas) ? payload.tapAreas as Array<Record<string, unknown>> : []
  const shape = RICH_SHAPES.find((candidate) => candidate.value === payload.shape)
    ?? RICH_SHAPES.find((candidate) => candidate.areas.length === taps.length)
    ?? RICH_SHAPES[0]
  const areas: Record<string, AreaDraft> = {}
  shape.areas.forEach((area, index) => {
    const tap = taps.find((item) => item.label === area.label) ?? taps[index]
    if (tap?.actionType === 'uri' && typeof tap.uri === 'string') {
      const back = tapActionFromSavedUri(tap.uri)
      areas[area.label] = { kind: back.kind as AreaActionKind, uri: back.uri, text: '', refId: back.refId, tapExtras: tap.tapExtras as TapExtras | undefined }
    }
    if (tap?.actionType === 'message' && typeof tap.text === 'string') areas[area.label] = { kind: 'message', uri: '', text: tap.text, refId: '', tapExtras: tap.tapExtras as TapExtras | undefined }
  })
  const imageUrl = typeof payload.imageUrl === 'string' ? payload.imageUrl : typeof payload.baseUrl === 'string' ? `${payload.baseUrl}/1040` : ''
  return { name: content.name, shape: shape.value, areas, imageUrl, uploaded: { media: content.media, payload } as TemplateImagemapUpload }
}

/**
 * `host` を渡すと、統括のテンプレートから同じ画面を使う（host.ts）。保存は呼ぶ側、主ボタンは［保存して配る］。
 * 画像は統括の置き場へ送って LINE の5サイズを作る（host.uploadRichImage）。登録メディア・画像の URL・動きを実行するは出さない。
 */
export default function TemplateRichEditor({ visual = false, host }: { visual?: boolean; host?: TemplateEditHost }) {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const role = useStaffRole()
  const hqHost = Boolean(host && !host.composer?.accountId)
  const featureAccess = useFeatureAccess('templates')
  const canMutate = host ? !host.readOnly : featureAccess
  const { selectedAccountId, accounts } = useAccount()
  const persistAsset = useCouponPersistence(selectedAccountId, undefined, 'rich_message')
  usePageTitle(host?.composer ? null : host ? 'テンプレート' : 'リッチメッセージを作る', !host?.composer)
  /*
   * 予約・回答フォーム・予約履歴・来店スタンプの URL に入れる LIFF ID と、中身で選ぶもの。
   * 店（店の作成の引き出しは選んだアカウント）だけ。統括（配った先が決まっていない）は持たない。
   */
  const tapAccountId = hqHost ? null : (host?.composer?.accountId ?? selectedAccountId)
  const liffId = tapAccountId ? (accounts.find((account) => account.id === tapAccountId)?.liffId ?? null) || null : null
  const tapSources = useTapActionSources(tapAccountId)

  /* 統括の編集（host.initialContent）：保存してある画像（5サイズ）・形・面の URL から始める。 */
  const [hostInitial] = useState(() => richInitial(host))
  const [name, setName] = useState(hostInitial ? hostInitial.name : host?.composer ? 'リッチメッセージ' : visual ? '夏のキャンペーン告知' : '')
  const [folder, setFolder] = useState('')
  const [folders, setFolders] = useState<Folder[]>([])
  const [imageUrl, setImageUrl] = useState(hostInitial?.imageUrl ?? '')
  const [pickedMedia, setPickedMedia] = useState<MediaItem | null>(hostInitial && 'pickedMedia' in hostInitial ? hostInitial.pickedMedia : null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [shapeValue, setShapeValue] = useState(hostInitial ? hostInitial.shape : visual ? '2v' : '3')
  const [pendingShape, setPendingShape] = useState<string | null>(null)
  const [areas, setAreas] = useState<Record<string, AreaDraft>>(() => (hostInitial ? hostInitial.areas : visual ? visualAreas() : {}))
  /* 採用案 Wmch0：画像の上か右の一覧で選んだ面（記号）。下にその面の動きだけを出す。 */
  const [selectedLabel, setSelectedLabel] = useState('A')
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  /* 統括：送った画像（5サイズ）と、その payload（baseUrl・baseSize など）。 */
  const [uploaded, setUploaded] = useState<TemplateImagemapUpload | null>(hostInitial?.uploaded ?? null)
  const [uploading, setUploading] = useState(false)

  const shapeDef = RICH_SHAPES.find((candidate) => candidate.value === shapeValue) ?? RICH_SHAPES[3]
  const pendingShapeDef = pendingShape ? RICH_SHAPES.find((candidate) => candidate.value === pendingShape) : undefined
  const droppingLabels = pendingShapeDef
    ? shapeDef.areas
      .filter((area) => !pendingShapeDef.areas.some((next) => next.label === area.label))
      .filter((area) => areaDraftConfigured(areas[area.label]))
      .map((area) => area.label)
    : []

  /* アカウントを替えたら、前のアカウントの登録メディアは外す。 */
  useEffect(() => {
    if (host) return
    setPickedMedia(null)
    setImageUrl('')
    // 統括では上のバーのアカウントに結びつかない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId])
  // 画像や動きの準備前も、保存時の整形を通さず途中入力を記録する。
  const richDraftSnapshot = JSON.stringify([name, imageUrl, pickedMedia, shapeValue, areas, uploaded])
  useEffect(() => {
    host?.onDraftChange?.({ kind: 'rich_message', name, payload: { ...uploaded?.payload }, media: uploaded?.media ?? [],
      editorState: { imageUrl, pickedMedia, shapeValue, areas, uploaded } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [richDraftSnapshot])

  /* フォルダはアカウントの置き場一覧から選ぶ（保存値はフォルダ名のまま。今と同じ）。 */
  useEffect(() => {
    setFolders([])
    if (!selectedAccountId || host) return
    let cancelled = false
    void api.folders.list('template', selectedAccountId)
      .then((res) => { if (!cancelled && res.success) setFolders(res.data) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [selectedAccountId])

  const snapshot = useMemo(() => JSON.stringify({ name, folder, imageUrl, pickedMedia, shapeValue, areas }), [name, folder, imageUrl, pickedMedia, shapeValue, areas])
  const [clean, setClean] = useState(() => snapshot)
  const dirty = snapshot !== clean && !saved
  const { leaveTarget, confirmLeave, cancelLeave, disarm, guarded } = useUnsavedGuard({ dirty, subject: '吹き出しの作成内容', busy: saving || publishing })

  const updateArea = (label: string, patch: Partial<AreaDraft>) =>
    setAreas((prev) => ({ ...prev, [label]: { ...(prev[label] ?? emptyAreaDraft()), ...patch } }))

  /* 面を減らすとき、消える面に設定があれば確かめる（黙って捨てない）。 */
  const requestShape = (value: string) => {
    const next = RICH_SHAPES.find((candidate) => candidate.value === value)
    if (!next || value === shapeValue) return
    const removed = shapeDef.areas.filter((area) => !next.areas.some((n) => n.label === area.label))
    if (removed.some((area) => areaDraftConfigured(areas[area.label]))) {
      setPendingShape(value)
      return
    }
    setShapeValue(value)
  }
  const confirmShapeChange = () => {
    if (!pendingShapeDef) return
    const kept = new Set(pendingShapeDef.areas.map((area) => area.label))
    setAreas((prev) => Object.fromEntries(Object.entries(prev).filter(([label]) => kept.has(label))))
    setShapeValue(pendingShapeDef.value)
    setPendingShape(null)
  }

  /*
   * 保存で落ちた欄：名前・画像・面ごとの押したら。帯ではなく欄を赤くして真下に理由を出し、
   * 別の面なら その面を選んでから移る。面の一覧には直す欄の数の赤い丸。
   */
  const fields = useFormErrors()
  fields.define('name', 'テンプレート名', () => (name.trim() ? null : 'リッチメッセージ名を入力してください'), { required: true })
  fields.define('image', '画像', () => (hqHost ? (uploaded ? null : '画像を選んでください') : imageUrl.trim() ? null : '画像を設定してください'), { required: true })
  shapeDef.areas.forEach((area) => {
    fields.define(`area-${area.label}`, `面 ${area.label} の押したら`, () => {
      const draft = areas[area.label]
      if (!draft || draft.kind === 'none') return null
      return richAreaProblem(draft, 'この面', Boolean(liffId))
    }, { reveal: () => setSelectedLabel(area.label), group: `area-${area.label}` })
  })

  const save = async (publishAsset = false): Promise<string | false> => {
    if (!selectedAccountId) { setError('上のバーでLINE公式アカウントを選んでください。'); return false }
    if (fields.submit().length > 0) { setError(''); return false }
    const built = buildRichPayload({ imageUrl, pickedMedia, shape: shapeDef, areas, liffId })
    if ('error' in built) { setError(built.error); return false }
    setSaving(true)
    setError('')
    try {
      const id = await persistAsset(name.trim(), { ...built.payload, folder }, null, snapshot, publishAsset)
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
        fields.setServerErrors(Object.fromEntries(shapeDef.areas.filter(area => areas[area.label]?.tapExtras).map(area => [`area-${area.label}`, extraError])))
        return false
      }
      if (!saveErrors.capture(caught, fields)) setError('保存できませんでした。通信状態を確認して、もう一度お試しください。')
      return false
    } finally {
      setSaving(false)
    }
  }
  /* 統括：中身を組み立てて呼ぶ側へ渡す（保存・配るは呼ぶ側）。 */
  const hostSave = async (distribute: boolean) => {
    if (!host || busy) return
    if (fields.submit().length > 0) { setError(''); return }
    const built = buildRichPayload({ imageUrl, pickedMedia: hqHost ? null : pickedMedia, shape: shapeDef, areas, liffId })
    if ('error' in built) { setError(built.error); return }
    const { imageMediaId: _id, imageMediaKind: _kind, ...rest } = built.payload
    void _id; void _kind
    setError('')
    setSaving(true)
    try { const inserted = await host.onSave({ kind: 'rich_message', name: name.trim(), payload: hqHost ? { ...uploaded!.payload, ...rest } : built.payload, media: uploaded?.media ?? [] }, distribute); if (inserted !== false) disarm() } finally { setSaving(false) }
  }
  const uploadImage = async (file: File) => {
    if (!host?.uploadRichImage) return
    setUploading(true)
    setError('')
    try {
      const result = await host.uploadRichImage(file)
      const url = typeof result.payload.imageUrl === 'string' ? result.payload.imageUrl : typeof result.payload.baseUrl === 'string' ? `${result.payload.baseUrl}/1040` : ''
      setUploaded(result)
      setImageUrl(url)
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(japaneseDetailOf(cause) || '画像を送れませんでした。PNG・JPEG（8MB まで）を選び直してください。') }
    } finally {
      setUploading(false)
    }
  }
  const onSaveDraft = async () => {
    if (host) { hostSave(false); return }
    const savedId = await save()
    if (savedId) { notifySaved('下書きを保存しました'); disarm(); router.push(createPageReturnHref('/templates', savedId)) }
  }
  const onPublish = async () => {
    if (host) { hostSave(true); return }
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
  const inputReason = requiredInputReason([{ label: 'テンプレート名', value: name }, { label: '画像', value: hqHost ? Boolean(uploaded) : imageUrl, select: true }])
  const blocked = saved ? '保存しました。一覧へ戻ってください。' : null
  const busy = saving || publishing || uploading || Boolean(host?.busy)
  const imageSet = /^https?:\/\//.test(imageUrl.trim())
  const unsetAreas = shapeDef.areas.filter((area) => !areaDraftConfigured(areas[area.label]))
  /* 形を変えて選んでいた面が無くなったら、最初の面を選ぶ。 */
  const selectedShapeArea = shapeDef.areas.find((area) => area.label === selectedLabel) ?? shapeDef.areas[0]
  const areaSummary = (draft: AreaDraft | undefined): string | null => {
    if (!draft || draft.kind === 'none') return null
    if (draft.kind === 'uri') return draft.uri.trim() || 'URLを開く'
    if (draft.kind === 'message') return draft.text.trim() || 'テキストを送る'
    const def = tapActionDef(draft.kind)
    const picked = draft.refId ? tapSources[draft.kind as 'form' | 'booking' | 'visit_stamp']?.find((item) => item.id === draft.refId)?.name : ''
    return picked ? `${def?.label ?? ''}：${picked}` : def?.label ?? null
  }

  const sideCard = (
    <section className={styles.sideCard}>
      <h2 className={styles.sideTitle}>リッチメニューとの違い</h2>
      <p className={styles.sideText}>リッチメッセージはトークに1回流れて、過去のやり取りに残ります。リッチメニューは画面の下に常に出ます。</p>
    </section>
  )

  /* 届き方：トークに流れる正方形の画像。面の線は見本だけ（友だちには見えない）。 */
  const phone = (
    <LinePreview title={null} note="リッチメッセージの見え方" accountName={sendName}>
      <div className={styles.assetRow}>
        <span className={styles.assetAvatar} aria-hidden="true">{sendName.slice(0, 1)}</span>
        <div className={rich.phoneImage}>
          {imageSet ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img width={1040} height={1040} src={imageUrl.trim()} alt="" />
          ) : null}
          {shapeDef.rows.map((row, rowIndex) => (
            <div key={rowIndex} className={rich.phoneRow}>
              {row.map((label) => (
                <span key={label} className={rich.phoneArea} data-image={imageSet || undefined}>
                  {imageSet ? null : `面 ${label}`}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </LinePreview>
  )

  if (!canMutate) {
    return (
      <SaveErrorScope errors={saveErrors}><TemplateEditFrame
        boardId="EFV8l"
        title="リッチメッセージを作る"
        description="1枚の画像を面に分けて、押した面ごとに動く"
        band={<ReadOnlyNotice>閲覧のみ：テンプレートの作成・変更はオーナーと管理者だけができます。</ReadOnlyNotice>}
        side={sideCard}
      >
        <Card layout="vertical" contentPadding="var(--tpl-section-pad)" gap="var(--polish-space-card)">
          <p className={styles.cardNote}>中身の確認は一覧の行を開くと読めます。</p>
        </Card>
      </TemplateEditFrame></SaveErrorScope>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
      <TemplateEditFrame
        inputReason={inputReason}
        composerHost={host ? { ...host, busy, onCancel: () => guarded(host.onCancel) } : undefined}
        onComposerInsert={(alsoSave) => void hostSave(alsoSave)}
        boardId={host ? 'g8d6ai' : 'EFV8l'}
        title="リッチメッセージを作る"
        description="1枚の画像を面に分けて、押した面ごとに動く"
        side={(inDialog) => (
          <>
            {host?.composer ? null : sideCard}
            <h2 className={styles.previewHead} title="この形式は、いまの画面から自分へのテスト送信ができません。保存して一斉配信に組み込むと、配信の画面からテスト送信できます。">届き方</h2>
            <div className={inDialog ? styles.previewDialog : styles.phone}>{phone}</div>
          </>
        )}
        footerInfo={host ? undefined : <TemplatePublishNote />}
        footerActions={(
          <>
            {host ? <Button type="button" onClick={host.onCancel}>キャンセル</Button> : <Button href="/templates">キャンセル</Button>}
            <Button type="button" onClick={() => void onSaveDraft()} disabled={busy || Boolean(blocked)} title={blocked ?? undefined} busy={saving && !publishing} busyLabel="保存中…">
              下書きを保存
            </Button>
            <Button type="button" variant="primary" onClick={() => void onPublish()} disabled={busy || Boolean(blocked) || Boolean(inputReason)} disabledReason={inputReason} title={blocked ?? undefined}  busy={publishing || Boolean(host?.busy)} busyLabel="保存中…">
              {host ? null : <Upload size={16} aria-hidden="true" />}
              {host ? host.primaryLabel ?? '保存する' : '保存して公開'}
            </Button>
          </>
        )}
      >
        {host?.notice}
        {error ? <Notice tone="danger" >{error}</Notice> : null}
        {null}

        {host?.composer ? null : <Card layout="vertical" contentPadding="var(--tpl-section-pad)" gap="var(--polish-space-card)">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>名前とフォルダ</h2>
          </div>
          <SettingsFormRow layout="name-folder">
            <div className={styles.field}><Field label="テンプレート名" htmlFor="te-rich-name" requirement={fields.requirement('name')}><SaveErrorField names={["name"]}><TextField {...fields.bind('name')} id="te-rich-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例：夏のキャンペーン告知" aria-required="true" invalid={fields.invalid('name')} aria-describedby={fields.invalid('name') ? 'te-rich-name-error' : undefined} /></SaveErrorField>
<FieldError id="te-rich-name-error">{fields.error('name')}</FieldError></Field></div>
            <div className={styles.field}><Field label="フォルダ" htmlFor="te-rich-folder"><SaveErrorField names={["folder","host.folder"]}><FolderSelect size="full"
                id="te-rich-folder"
                aria-label="フォルダ"
                value={host ? host.folder : folder}
                onChange={host ? host.onFolderChange : setFolder}
                folders={host ? host.folders : folders.map(folderByName)}
                colors
                onCreate={host
                  ? hostFolderCreate(host)
                  : canMutate && selectedAccountId
                    ? folderCreator((name, color) => api.folders.create({ kind: 'template', name, color, accountId: selectedAccountId }), folderByName, (created) => setFolders((current) => [...current, created]))
                    : undefined}
              /></SaveErrorField></Field></div>
          </SettingsFormRow>
        </Card>}

        <Card layout="vertical" contentPadding="var(--tpl-section-pad)" gap="var(--polish-space-card)">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>面の分け方</h2>
            <p className={styles.cardNote}>選んだ形に合わせて、下の設定が増えます</p>
          </div>
          <LayoutPicker
            value={shapeValue} onChange={requestShape} preview="message"
            options={RICH_SHAPES.map((candidate) => ({ value: candidate.value, label: candidate.label, areas: candidate.areas }))}
          />
        </Card>

        <Card layout="vertical" contentPadding="var(--tpl-section-pad)" gap="var(--polish-space-card)">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>画像</h2>
            <p className={styles.cardNote}>1040 × 1040px（正方形）がおすすめ</p>
          </div>
          <div className={rich.imageRow}>
            <div className={rich.imageBox} {...fields.bind('image')}>
              <SaveErrorField names={["imageUrl","image_url"]}><MediaSlot
                error={fields.error('image') ?? undefined}
                size="compact"
                aspectRatio="1 / 1"
                title="画像を追加"
                previewAlt="リッチメッセージの画像"
                value={imageSet ? imageUrl.trim() : null}
                accept="image/png,image/jpeg"
                maxBytes={(hqHost ? 8 : 10) * 1024 * 1024}
                busy={hqHost ? uploading : undefined}
                onBusyChange={hqHost ? undefined : setUploading}
                disabled={busy && !uploading}
                upload={hqHost ? undefined : selectedAccountId ? async (file, progress) => {
                  const result = await uploadToMediaLibrary(file, selectedAccountId, 'image', progress)
                  setPickedMedia(result.item)
                  return result.url
                } : undefined}
                onFile={hqHost ? (file) => void uploadImage(file) : undefined}
                onChange={(url) => { setImageUrl(url ?? ''); if (url === null) { setPickedMedia(null); setUploaded(null) } }}
                onMediaPick={hqHost ? undefined : () => setPickerOpen(true)}
              /></SaveErrorField>
            </div>
            <div className={rich.imageSide}>
              <p className={styles.cardNote}>面の線は画像の上に重ねて表示されます。友だちには線は見えません。</p>
              {pickedMedia ? <p className={styles.hint}>選択中：{pickedMedia.filename}</p> : null}
              {hqHost ? (
                /* 統括：PNG・JPEG（8MB まで）を送ると、配った先で使う5サイズを作る。URL の直書きは置かない（サイズを作れない）。 */
                null
              ) : (
              <SaveErrorField names={["imageUrl","image_url"]}><TextField
                value={imageUrl}
                onChange={(event) => { setImageUrl(event.target.value); setPickedMedia(null) }}
                placeholder="または画像のURL（https://…）"
                aria-label="画像のURL"
              /></SaveErrorField>
              )}
            </div>
          </div>
        </Card>

        <Card layout="vertical" contentPadding="var(--tpl-section-pad)" gap="var(--polish-space-card)">
          {/* 採用案 Wmch0（リッチメニューと同じ部品）：画像の上で面を押して選ぶ＋右に一覧＋下に選んだ面の動き。 */}
          <TapAreaEditor
            framed={false}
            title="押した面ごとの動き"
            description="画像の上の面か右の一覧を押すと、下でその面の動きを決められます"
            imageUrl={imageSet ? imageUrl.trim() : null}
            aspectRatio={1}
            items={shapeDef.areas.map((area) => ({
              id: area.label,
              name: areaPlace(area, shapeDef.areas),
              summary: areaSummary(areas[area.label]),
              errorCount: fields.countIn(`area-${area.label}`),
              x: area.x,
              y: area.y,
              width: area.width,
              height: area.height,
            }))}
            selectedId={selectedShapeArea.label}
            onSelect={setSelectedLabel}
            detail={(() => {
              const area = selectedShapeArea
              const draft = areas[area.label] ?? emptyAreaDraft()
              return (
                <div className={rich.areaDetail}>
                  <div className={rich.areaHead} aria-hidden="true">
                    <span className={rich.areaColChip}>面</span>
                    <span className={rich.areaColKind}>押したら</span>
                    <span className={rich.areaColBody}>中身</span>
                  </div>
                  <div className={rich.areaRow} role="group" aria-label={`面 ${area.label}`}>
                    <span className={rich.areaChip} data-unset={draft.kind === 'none' || undefined}>{`${area.label} ${areaPlace(area, shapeDef.areas)}`}</span>
                    <div className={rich.areaTap} {...fields.bind(`area-${area.label}`)} aria-describedby={fields.invalid(`area-${area.label}`) ? 'te-rich-area-error' : undefined}>
                      <SaveErrorField names={["draft"]}><TapActionField
                        allowExtras={draft.kind !== "none"} accountId={tapAccountId} extrasError={fields.error(`area-${area.label}`)}
                        name={`面 ${area.label} `}
                        kindLabel={`面 ${area.label} を押したら`}
                        value={draft}
                        onChange={(patch) => updateArea(area.label, patch as Partial<AreaDraft>)}
                        kinds={hqHost ? HOST_AREA_KINDS : TAP_ACTION_KINDS}
                        extraKinds={AREA_NONE_KIND}
                        renderBody={(kind) => kind !== 'none' ? undefined : <p className={rich.areaNone}>押しても何も起きません</p>}
                        scope={hqHost ? 'hq' : 'shop'}
                        hasLiff={Boolean(liffId)}
                        liffSettingsHref={tapAccountId ? `/accounts/detail?id=${encodeURIComponent(tapAccountId)}` : '/accounts'}
                        readOnly={!canMutate}
                        sources={tapSources}
                        textMax={RICH_MESSAGE_TEXT_MAX}
                      /></SaveErrorField>
                    </div>
                  </div>
                  <FieldError id="te-rich-area-error">{fields.error(`area-${area.label}`)}</FieldError>
                </div>
              )
            })()}
          />
          {unsetAreas.length > 0 ? (
            <Notice tone="warn">
              {unsetAreas.map((area) => `面 ${area.label}`).join('・')}
              の動きが未設定です。そのまま送ると、押しても何も起きません。

            </Notice>
          ) : null}
        </Card>
      </TemplateEditFrame>

      <ConfirmDialog
        open={pendingShape !== null}
        title="面の分け方を変えますか？"
        description={`${droppingLabels.map((label) => `面 ${label}`).join('・')}の動きは消えます。`}
        confirmLabel="変更する"
        onConfirm={confirmShapeChange}
        onCancel={() => setPendingShape(null)}
      />

      <MediaPickerDialog
        open={pickerOpen}
        accountId={selectedAccountId}
        kind="image"
        onClose={() => setPickerOpen(false)}
        onSelect={(item) => { setImageUrl(item.url); setPickedMedia(item); setPickerOpen(false) }}
      />

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="リッチメッセージの変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </></SaveErrorScope>
  )
}
