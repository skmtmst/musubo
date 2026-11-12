'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { api, type BroadcastAssetKind, type BroadcastMessageAsset } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import Button from '@/components/shared/button'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Select from '@/components/shared/select'
import { AttachmentRow } from '@/components/shared/file-drop'
import MediaSlot from '@/components/shared/media-slot'
import { formatDateTime } from '@/lib/format'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'
import { ToggleField } from '@/components/shared/toggle'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'

const LABELS: Record<BroadcastAssetKind, { title: string; description: string; singular: string }> = {
  rich_message: { title: 'リッチメッセージ', description: '画像とタップ領域を組み合わせたテンプレートを作成し、一斉配信から引用できます。', singular: 'リッチメッセージ' },
  card_message: { title: 'カルーセル', description: '横にスワイプできるパネルを最大10枚まで作り、一斉配信から引用できます。', singular: 'カルーセル' },
  coupon: { title: 'クーポン', description: '一斉配信から引用できるクーポンテンプレートを登録します。', singular: 'クーポン' },
  research: { title: 'リサーチ', description: '一斉配信から引用できるアンケートテンプレートを登録します。', singular: 'リサーチ' },
}

type CardDraft = { id: string; imageUrl: string; title: string; description: string; actionLabel: string; actionUrl: string; template: string }
const newCard = (): CardDraft => ({ id: crypto.randomUUID(), imageUrl: '', title: '', description: '', actionLabel: '詳しく見る', actionUrl: '', template: 'product' })

/**
 * カルーセルのパネルの上限。
 *
 * **要件 11 §156 は「最大10パネル」。** 画面・API・LINE用変換で同じ数を使う。
 * 2か所に散ると、画面では10枚まで作れるのに保存で止まる（監査 R141）。
 *
 * 「もっと見る」パネルも LINE の10列のうち1列を使う。付けるときは本文を
 * 9枚までにして、数え方を欄のそばに出す。
 * 呼び名も設計・要件にそろえて「パネル」にする（実装だけ「カード」だった）。
 */
const MAX_PANELS = 10

/** 選んだ画像の大きさを行に出すだけの短い表記。 */
function formatAssetBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

/*
 * R135: 素材を作り・直し・消ししたあと、親（テンプレート一覧の種類タブの
 * 件数）へ知らせる口。以前は件数の取り直しがアカウント切替のときだけで、
 * 作った直後のタブが0件のままになっていた。渡さなければ今までどおり。
 */
export interface BroadcastAssetListLayout {
  items: BroadcastMessageAsset[]
  loadState: 'loading' | 'ready' | 'error'
  reload: () => Promise<void>
  onEdit: (item: BroadcastMessageAsset) => void
  onDelete: (item: BroadcastMessageAsset) => void
  editor: ReactNode
  deleteDialog: ReactNode
}

export default function BroadcastAssetManager({ kind, onChanged, renderLayout, onScopeGuardChange }: {
  kind: BroadcastAssetKind
  onChanged?: () => void
  onScopeGuardChange?: (guard: ((action: () => void) => void) | null) => void
  renderLayout?: (state: BroadcastAssetListLayout) => ReactNode
}) {
  const saveErrors = useSaveFormErrors()

  const { selectedAccountId } = useAccount()
  const scopeKey = `${selectedAccountId ?? ''}:${kind}`
  const scopeRef = useRef(scopeKey)
  const scopeGeneration = useRef(0)
  if (scopeRef.current !== scopeKey) { scopeRef.current = scopeKey; scopeGeneration.current += 1 }
  const renderedGeneration = scopeGeneration.current
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const deleteLock = useRef(false)
  const loadGeneration = useRef(0)
  const editorGeneration = useRef(0)
  const uploadGeneration = useRef(new Map<string, number>())
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [items, setItems] = useState<BroadcastMessageAsset[]>([])
  const router = useRouter()
  const [editing, setEditing] = useState<BroadcastMessageAsset | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const nameId = useId()
  const [imageUrl, setImageUrl] = useState('')
  /** 今選んだ画像の実ファイル情報（ファイル名・大きさを行に出す用）。 */
  const [imageFile, setImageFile] = useState<{ name: string; size: number } | null>(null)
  const [description, setDescription] = useState('')
  const [actionUrl, setActionUrl] = useState('')
  const [cards, setCards] = useState<CardDraft[]>([newCard()])
  /*
   * 末尾の「もっと見る」パネルを付けるか。以前は readOnly で固定の ON だった
   * ので、見た目と操作の約束が食い違っていた（監査 R143）。OFF も保存する。
   */
  const [moreCard, setMoreCard] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pendingUploads, setPendingUploads] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const snapshot = JSON.stringify({ name, imageUrl, description, actionUrl, cards, moreCard })
  const baseline = useRef(snapshot)

  /*
   * 削除の確認。**ブラウザの `confirm` は使わない。**
   * 見た目がブラウザ任せで設計の確認窓と違ううえ、画像比較にも写らない。
   * 何が止まって何が残るのかを本文で読ませたいので、共通の窓へ移した。
   *
   * **押した時点の対象とLINEアカウントを掴んでおく。** この画面は窓を
   * 開けたままヘッダからアカウントを切り替えられる。切り替わったのに
   * 消し続けると、いま見えていない一覧のものを消すことになる。
   */
  const [deleteTarget, setDeleteTarget] = useState<{ item: BroadcastMessageAsset; accountId: string | null; generation: number } | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const accountSwitched = deleteTarget !== null && (deleteTarget.accountId !== selectedAccountId || deleteTarget.generation !== scopeGeneration.current)

  const closeDelete = () => {
    if (deleting || renderedDeleteTicket !== deleteTicket.current) return
    deleteTicket.current = null
    setDeleteTarget(null)
    setDeleteError('')
  }

  const confirmDelete = async () => {
    // 二度押しを受け付けない。切り替わった後も走らせない。
    if (!deleteTarget || !renderedDeleteTicket || renderedDeleteTicket !== deleteTicket.current || deleting || deleteLock.current || !alive.current || accountSwitched || deleteTarget.generation !== scopeGeneration.current) return
    deleteLock.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.broadcastMessageAssets.delete(deleteTarget.item.id)
      // 失敗を握りつぶさない。返事を見ずに一覧を読み直すと、消えていないのに
      // 消えたように見える。
      if (!res.success) throw new Error(res.error)
      if (deleteTarget.generation !== scopeGeneration.current || renderedDeleteTicket !== deleteTicket.current) return
      deleteTicket.current = null
      setDeleteTarget(null)
      await load()
      onChanged?.()
    } catch (saveFailure) {
      if (!alive.current || deleteTarget.generation !== scopeGeneration.current || renderedDeleteTicket !== deleteTicket.current) return
      const fieldFailure = saveErrors.capture(saveFailure)

      // 生のAPIエラーは出さない。運用者が次に何をすればよいかだけを書く。
      { if (!fieldFailure) setDeleteError('削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      deleteLock.current = false
      if (alive.current) setDeleting(false)
    }
  }

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    const key = scopeKey
    setItems([])
    setLoadState('loading')
    try {
      const res = await api.broadcastMessageAssets.list({ accountId: selectedAccountId || undefined, kind })
      if (scopeRef.current !== key || loadGeneration.current !== generation) return
      if (!res.success) throw new Error(res.error)
      setItems(res.data)
      setLoadState('ready')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      if (scopeRef.current === key && loadGeneration.current === generation) { if (!fieldFailure) setLoadState('error') }
    }
  }, [kind, selectedAccountId, scopeKey, saveErrors])
  useEffect(() => { void load(); return () => { loadGeneration.current++ } }, [load])

  const reset = useCallback(() => {
    const blankCards = [newCard()]
    baseline.current = JSON.stringify({ name: '', imageUrl: '', description: '', actionUrl: '', cards: blankCards, moreCard: true })
    editorGeneration.current++; setPendingUploads(new Set()); setEditing(null); setShowForm(false); setName(''); setImageUrl(''); setImageFile(null); setDescription(''); setActionUrl(''); setCards(blankCards); setMoreCard(true); setError('')
  }, [])
  const guard = useUnsavedGuard({ dirty: showForm && (snapshot !== baseline.current || pendingUploads.size > 0), busy: saving, onDiscard: reset, subject: '素材への変更' })
  useEffect(() => { onScopeGuardChange?.(guard.guarded); return () => onScopeGuardChange?.(null) }, [onScopeGuardChange, guard.guarded])
  /*
   * 種類・LINEアカウントが切り替わったら、編集中の対象を離す。
   * 離さないと、別種類の一覧の上で前の素材の編集欄が残り、保存が
   * 前の素材への更新要求になる（監査 R142）。
   */
  useEffect(() => { reset() }, [reset, kind, selectedAccountId])
  const startEdit = (item: BroadcastMessageAsset) => guard.guarded(() => {
    if (kind === 'coupon') { router.push(`/templates/edit?kind=coupon&id=${encodeURIComponent(item.id)}`); return }
    const nextImageUrl = String(item.payload.imageUrl ?? '')
    const nextDescription = String(item.payload.description ?? '')
    const nextActionUrl = String(item.payload.actionUrl ?? '')
    const nextCards = kind === 'card_message' && Array.isArray(item.payload.cards) ? (item.payload.cards as CardDraft[]).map(card => ({...card, id: card.id || crypto.randomUUID()})) : cards
    const nextMoreCard = kind === 'card_message' ? item.payload.moreCard !== false : moreCard
    baseline.current = JSON.stringify({ name: item.name, imageUrl: nextImageUrl, description: nextDescription, actionUrl: nextActionUrl, cards: nextCards, moreCard: nextMoreCard })
    editorGeneration.current++
    setEditing(item); setShowForm(true); setName(item.name); setImageUrl(nextImageUrl); setImageFile(null); setDescription(nextDescription); setActionUrl(nextActionUrl); setCards(nextCards); setMoreCard(nextMoreCard)
  })
  const upload = async (file: File, cardIndex?: number) => {
    if (!['image/jpeg','image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) { setError('JPEG・PNG（10MB以下）を選択してください'); return }
    const cardId = cardIndex === undefined ? null : cards[cardIndex]?.id
    const key = scopeKey
    const editor = editorGeneration.current
    const target = cardId ?? 'main'
    const generation = (uploadGeneration.current.get(target) ?? 0) + 1
    uploadGeneration.current.set(target, generation)
    const prefix = `${editor}:${target}:`
    const token = `${prefix}${generation}`
    setPendingUploads(previous => new Set([...previous].filter(item => !item.startsWith(prefix)).concat(token)))
    const current = () => scopeRef.current === key && editorGeneration.current === editor && uploadGeneration.current.get(target) === generation
    try {
      const res = await api.broadcastMessageAssets.upload(file)
      if (!current()) return
      if (!res.success) { setError(res.error); return }
      if (cardId === null) { setImageUrl(res.data.url); setImageFile({ name: file.name, size: file.size }) }
      else setCards((items) => items.map(card => card.id === cardId ? { ...card, imageUrl: res.data.url } : card))
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      if (current()) { if (!fieldFailure) setError('画像をアップロードできませんでした。もう一度お試しください。') }
    } finally {
      setPendingUploads(previous => { const next = new Set(previous); next.delete(token); return next })
    }
  }

  const clearImage = () => { setImageUrl(''); setImageFile(null) }
  // 「もっと見る」も1列使うので、付けるとき本文は9枚まで（API と同じ数え方）。
  const maxCards = moreCard && kind === 'card_message' ? MAX_PANELS - 1 : MAX_PANELS
  const save = async () => {
    if (!name.trim()) { if (!saveErrors.fail("name", '名前を入力してください')) setError('名前を入力してください'); return }
    if (kind === 'card_message' && cards.length > maxCards) { setError(`「もっと見る」パネルを付けるときは${MAX_PANELS - 1}枚までです。パネルを減らすか、「もっと見る」を外してください`); return }
    const payload: Record<string, unknown> = kind === 'card_message'
      ? { cards, moreCard }
      : kind === 'rich_message'
        ? { imageUrl, description, actionUrl, tapAreas: actionUrl ? [{ x: 0, y: 0, width: 100, height: 100, actionType: 'uri', value: actionUrl }] : [] }
        : { description, actionUrl }
    if (kind === 'rich_message' && !imageUrl) { setError('画像をアップロードしてください'); return }
    if (kind === 'card_message' && cards.some((card) => !card.title.trim())) { if (!saveErrors.fail("card.title", 'すべてのカードにタイトルを入力してください')) setError('すべてのカードにタイトルを入力してください'); return }
    setSaving(true); setError('')
    try {
      const res = editing
        ? await api.broadcastMessageAssets.update(editing.id, { name: name.trim(), payload })
        : await api.broadcastMessageAssets.create({ lineAccountId: selectedAccountId || null, kind, name: name.trim(), payload })
      if (!res.success) { setError(res.error); return }
      guard.disarm(); reset(); await load()
      onChanged?.()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
 { if (!fieldFailure) setError('保存できませんでした。時間をおいて、もう一度お試しください。') } } finally { setSaving(false) }
  }

  const meta = LABELS[kind]
  const editor = showForm && <section className="rounded-card border border-hairline bg-canvas p-5 shadow-card-surface">
      <div className="mb-5 flex items-center justify-between"><h3 className="font-bold">{editing ? '編集' : `新しい${meta.singular}`}</h3><button onClick={() => guard.guarded(reset)} className="text-sm text-ink-faint">閉じる</button></div>
      <div className="space-y-4"><Field label="名前" htmlFor={nameId} required><SaveErrorField names={["name"]}><TextField id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${meta.singular}の管理名`} /></SaveErrorField></Field>
      {kind === 'rich_message' && <>
        {/*
          画像の送信は1回のAPI呼び出しで、途中の割合を測れない。
          実測できない進みは出さない（Progress は足さない）。
          パネル内の画像も同じ画像を入れる所（MediaSlot・Z7vd2）の小さい形。
        */}
        <SaveErrorField names={["imageUrl","image_url"]}><MediaSlot
          title="画像を追加"
          value={imageUrl || null}
          accept="image/jpeg,image/png"
          limitText="1ファイル10メガバイト以内・JPEG・PNG"
          fit="contain"
          onFile={(file) => void upload(file)}
          onRemove={clearImage}
        /></SaveErrorField>
        {imageFile ? <AttachmentRow name={imageFile.name} meta={formatAssetBytes(imageFile.size)} tone="photo" onRemove={clearImage} /> : null}
        <SaveErrorField names={["actionUrl","action_url"]}><SharedTextField value={actionUrl} onChange={(e) => setActionUrl(e.target.value)} placeholder="タップ時に開くURL" className="w-full rounded-card border px-3 py-2.5 text-sm" /></SaveErrorField>
      </>}
      {kind === 'card_message' && <div className="space-y-3">{cards.map((card, index) => <div key={card.id} className="rounded-card border bg-surface-pearl p-4"><div className="mb-3 flex justify-between"><b className="text-sm">パネル {index + 1}</b><button disabled={cards.length === 1} onClick={() => setCards((all) => all.filter((_, i) => i !== index))} className="text-xs text-status-danger">削除する</button></div><div className="grid gap-3 md:grid-cols-2"><SaveErrorField names={[`cards.${index}.template`,"template","card.template","cards"]}><Select aria-label={`パネル ${index + 1} の種類`} value={card.template} onChange={(value) => setCards((all) => all.map((c,i) => i===index ? {...c,template:value}:c))} options={[{ value: 'product', label: 'プロダクト' }, { value: 'location', label: 'ロケーション' }, { value: 'person', label: '人物' }, { value: 'image', label: '画像' }]} size="full" /></SaveErrorField><SaveErrorField names={[`cards.${index}.imageUrl`,`cards.${index}.image_url`,"imageUrl","card.imageUrl","image_url","card.image_url"]}><MediaSlot size="compact" title="画像を追加" previewAlt={`パネル ${index + 1} の画像`} value={card.imageUrl || null} accept="image/jpeg,image/png" limitText="10MB 以内" onFile={(f) => void upload(f,index)} onRemove={() => setCards((all) => all.map((c,i) => i===index ? {...c,imageUrl:''}:c))} /></SaveErrorField><SaveErrorField names={[`cards.${index}.title`,"card.title","cards"]}><SharedTextField value={card.title} onChange={(e) => setCards((all) => all.map((c,i) => i===index ? {...c,title:e.target.value}:c))} placeholder="タイトル" className="rounded-control border px-3 py-2 text-sm"/></SaveErrorField><SaveErrorField names={[`cards.${index}.description`,"description","card.description","cards"]}><SharedTextField value={card.description} onChange={(e) => setCards((all) => all.map((c,i) => i===index ? {...c,description:e.target.value}:c))} placeholder="説明" className="rounded-control border px-3 py-2 text-sm"/></SaveErrorField><SaveErrorField names={[`cards.${index}.actionLabel`,`cards.${index}.action_label`,"actionLabel","card.actionLabel","cards","action_label","card.action_label"]}><SharedTextField value={card.actionLabel} onChange={(e) => setCards((all) => all.map((c,i) => i===index ? {...c,actionLabel:e.target.value}:c))} placeholder="ボタン名" className="rounded-control border px-3 py-2 text-sm"/></SaveErrorField><SaveErrorField names={[`cards.${index}.actionUrl`,`cards.${index}.action_url`,"actionUrl","card.actionUrl","cards","action_url","card.action_url"]}><SharedTextField value={card.actionUrl} onChange={(e) => setCards((all) => all.map((c,i) => i===index ? {...c,actionUrl:e.target.value}:c))} placeholder="アクションURL" className="rounded-control border px-3 py-2 text-sm"/></SaveErrorField></div></div>)}<button disabled={cards.length >= maxCards} onClick={() => setCards((all) => [...all,newCard()])} className="w-full rounded-card border border-dashed py-3 text-sm font-medium text-success">＋ パネルを追加する（{cards.length}/{MAX_PANELS}）</button><SaveErrorField names={["moreCard","more_card"]}><ToggleField checked={moreCard} onChange={setMoreCard}>末尾に「もっと見る」パネルを表示</ToggleField></SaveErrorField>{moreCard && <p className="text-xs text-ink-faint">「もっと見る」で1枠使うため、パネルは{MAX_PANELS - 1}枚までです。</p>}</div>}
      {(kind === 'coupon' || kind === 'research') && <><SaveErrorField names={["description"]}><SharedTextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={kind === 'coupon' ? '特典内容・利用条件' : 'アンケートの説明'} className="w-full rounded-card border p-3 text-sm" rows={3}/></SaveErrorField><SaveErrorField names={["actionUrl","action_url"]}><SharedTextField value={actionUrl} onChange={(e) => setActionUrl(e.target.value)} placeholder={kind === 'coupon' ? 'クーポンを開くURL' : '回答フォームURL'} className="w-full rounded-card border px-3 py-2.5 text-sm" /></SaveErrorField></>}
      {error && <p className="text-sm text-status-danger">{error}</p>}<div className="flex justify-end gap-2"><button onClick={() => guard.guarded(reset)} className="rounded-control border px-4 py-2 text-sm">キャンセル</button><Button variant="primary" className="px-5 py-2 font-bold disabled:opacity-50 border-0 h-auto whitespace-normal" disabled={saving} onClick={() => save()} busy={saving} busyLabel="保存中…" widthReserve="idle">{'保存する'}</Button></div></div>
    </section>
  const deleteDialog = (    <ConfirmDialog
      open={deleteTarget !== null}
      title={deleteTarget ? `「${deleteTarget.item.name}」を削除しますか？` : ''}
      description={`この${meta.singular}テンプレートを一覧から削除します。この操作は取り消せません。`}
      confirmLabel="削除する"
      destructive
      busy={deleting}
      error={
        accountSwitched
          ? '窓を開けたあとにLINEアカウントが切り替わりました。いまの一覧には、この削除対象は含まれていません。閉じてから選び直してください。'
          : deleteError
      }
      // 切り替わったら消させない。押し口ごと出さないので、押せるように見えて
      // 何も起きない形にならない。
      onConfirm={accountSwitched ? undefined : () => void confirmDelete()}
      onCancel={closeDelete}
    >
      {deleteTarget ? <OperationTargetSummary accounts={[{ id: deleteTarget.item.lineAccountId ?? '' }]} /> : null}
      <ul className="text-ink-secondary space-y-1.5 text-xs leading-5">
        <li>・止まること: 一斉配信の作成画面から、この{meta.singular}を引用できなくなります。</li>
        {/* 作成画面は選んだ時点で中身を写している（broadcast-form の
            contentTemplateToBubble）。あとから参照し直していないので、
            作成済み・送信済みの配信は動かない。 */}
        <li>・残ること: すでに作った一斉配信は、引用した時点の内容を写して持っています。消しても中身は変わりません。</li>
        {/* 削除するのは broadcast_message_assets の行だけ。R2 の画像は消えない。 */}
        <li>・残ること: アップロードした画像そのものは残ります。この操作では消えません。</li>
        <li>・戻せません: 同じ{meta.singular}が必要になったときは、作り直してください。</li>
      </ul>
    </ConfirmDialog>)
  const leaveDialog = <UnsavedLeaveDialog subject="素材への変更" open={guard.leaveTarget !== null} busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
  if (renderLayout) return <SaveErrorScope errors={saveErrors}>{renderLayout({
    items, loadState, reload: load, onEdit: startEdit,
    onDelete: item => { if (renderedGeneration !== scopeGeneration.current) return; deleteTicket.current = {}; setDeleteError(''); setDeleteTarget({ item, accountId: selectedAccountId, generation: renderedGeneration }) },
    editor, deleteDialog,
  })}{leaveDialog}</SaveErrorScope>
  return <SaveErrorScope errors={saveErrors}><div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3" data-design-node="FuBeQ"><div className="flex flex-wrap gap-2"><Button onClick={() => guard.guarded(() => { reset(); setShowForm(true) })} variant="primary">{meta.singular}を作る</Button></div><Button href="/broadcasts/new?templatePicker=1">一斉配信で使う</Button></div>
    {editor}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{items.map((item) => <article key={item.id} className="rounded-card border border-hairline bg-canvas p-5 shadow-card-surface"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className="rounded-pill bg-accent-soft px-2 py-1 text-micro font-bold text-success">{meta.title}</span><h3 className="mt-3 truncate font-bold text-ink">{item.name}</h3><p className="mt-1 text-xs text-ink-faint">更新 {formatDateTime(item.updatedAt)}</p></div></div><div className="mt-4 flex flex-wrap gap-2"><a href={`/broadcasts/new?contentTemplateId=${encodeURIComponent(item.id)}`} className="rounded-control border border-accent-border px-3 py-2 text-sm font-bold text-success">一斉配信で使う</a><button onClick={() => startEdit(item)} className="min-w-24 flex-1 rounded-control border px-3 py-2 text-sm font-bold">編集</button><button onClick={() => { if (renderedGeneration !== scopeGeneration.current) return; deleteTicket.current = {}; setDeleteError(''); setDeleteTarget({ item, accountId: selectedAccountId, generation: renderedGeneration }) }} className="rounded-control border border-status-danger-border px-3 py-2 text-sm font-bold text-status-danger">削除する</button></div></article>)}{loadState === 'loading' && <p role="status">テンプレートを読み込んでいます…</p>}{loadState === 'error' && <div role="alert">テンプレートを読み込めませんでした。<Button onClick={() => load()}>再読み込み</Button></div>}{loadState === 'ready' && items.length === 0 && <div className="col-span-full rounded-card border border-dashed bg-canvas p-12 text-center text-sm text-ink-faint">まだ{meta.singular}テンプレートがありません。「{meta.singular}を作る」から追加してください。</div>}</div>

    {/*
      取り消せない操作なので `destructive` を付ける。消したテンプレートは
      戻せない（DBの行を消すだけで、控えは残らない）。
    */}
    {deleteDialog}
    {leaveDialog}
  </div></SaveErrorScope>
}
