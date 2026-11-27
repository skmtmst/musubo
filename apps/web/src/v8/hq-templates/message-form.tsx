'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  button_label: requiredText("ボタンの文字を入力してください"),
}

import HqMessageBody from '@/components/shared/hq-message-inserts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PlayCircle, Plus } from 'lucide-react'
import { tapExtrasError } from '@line-crm/shared'
import type { HqMessageCard, HqMessageReference, HqTemplateFolder } from '@line-crm/shared'
import { hqTemplatesApi, type MessageTemplateDefinition } from '@/lib/hq-templates-api'
import { withMessageCard, withUploadedImage } from '@/lib/hq-template-authoring'
import { LEGACY_MESSAGE_NOTICE, MessageTemplateEditor } from '@/components/templates/message-template-editor'
import { EMPTY_TEMPLATE_REFERENCES } from '../../components/templates/template-preview-model'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import MusuboMark from '@/components/shared/musubo-mark'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import TruncatedText from '@/components/shared/truncated-text'
import MediaSlot from '@/components/shared/media-slot'
import TapActionField from '@/components/shared/tap-action-field'
import type { TapActionKind, TapActionValue } from '@/lib/tap-actions'
import { EntityPickerField } from '@/components/shared/entity-picker'
import { ENTITY_KINDS } from '@/components/shared/entity-picker-sources'
import FolderSelect from '@/components/shared/folder-select'
import { FieldError } from '@/components/shared/form-controls'
import type { FormErrors } from '@/lib/use-form-errors'
import { decodeImageSize, type TemplateMedia } from './definition'
import styles from './console.module.css'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'


/*
 * ★V8 統括 テンプレート「メッセージのひな形を作る」（板 ）。
 * 左に「ひな形の中身」（名前・分類・画像・タイトル・本文・ボタン）、右に LINE での見え方。
 * 保存する中身（HqMessageCard と template 本体）・画像の受け取り・ボタンの参照先は今の画面
 * （app/hq/templates/template-definition-editor.tsx の CardEditor・template-message-v8.tsx）と同じ。
 * 保存済みの画像・カルーセルは、形を切り替えずに共通の MessageTemplateEditor で編集する。
 */

/*
 * ボタンの押したら（共通の欄 TapActionField・YPzmo・）。保存の形（HqMessageCard の action・value）は今のまま。
 * 予約・予約履歴・来店スタンプは、統括カードの型（shared/hq-message-card.ts）と配る口が持てないので出さない
 * （要る API：action に booking・booking_history・visit_stamp を足し、配るときに各店の LIFF の URL に置き換える）。
 */
type CardAction = HqMessageCard['buttons'][number]['action']
const CARD_TAP_KINDS: readonly TapActionKind[] = ['uri', 'message', 'form']
const SCENARIO_KIND = [{ value: 'scenario', label: 'シナリオを始める', description: '作ってあるシナリオを始める', icon: PlayCircle }] as const
const TAP_OF: Record<CardAction, string> = {
  url: 'uri', message: 'message', form: 'form', scenario: 'scenario',
  booking: 'booking', booking_history: 'booking_history', visit_stamp: 'visit_stamp',
}
const ACTION_OF: Record<string, CardAction> = { uri: 'url', message: 'message', form: 'form', scenario: 'scenario' }
function cardTapValue(button: HqMessageCard['buttons'][number]): TapActionValue {
  return {
    tapExtras: button.tapExtras,
    kind: TAP_OF[button.action],
    uri: button.action === 'url' ? button.value : '',
    text: button.action === 'message' ? button.value : '',
    refId: button.action === 'form' || button.action === 'scenario' ? button.value : '',
  }
}

export interface MessageFormProps {
  name: string
  onNameChange: (name: string) => void
  value: MessageTemplateDefinition
  onChange: (next: MessageTemplateDefinition) => void
  folders: HqTemplateFolder[]
  folderId: string | null
  onFolderChange: (id: string | null) => void
  /** フォルダを選ぶ欄からその場で作る（dLffh）。閲覧のみは渡さない。 */
  onCreateFolder?: import('@/components/shared/folder-select').FolderSelectCreate
  folderLoadFailed: boolean
  disabled: boolean
  catalogFailed: boolean
  onReloadCatalog: () => void
  onBusyChange?: (busy: boolean) => void
  onReceipt?: (media: TemplateMedia) => void
  /** 下に出す「前回の保存を再確認」などの知らせ。 */
  notice?: ReactNode
  /** 保存で落ちた欄。呼ぶ側の useFormErrors を渡すと、名前・本文・ボタンを欄ごとに検査して知らせる。 */
  fields?: FormErrors
}

/** カードのボタン1つの誤り（packages/shared の parseHqMessageCard と同じ決まり）。欄の真下に出す。 */
function cardButtonProblem(button: HqMessageCard['buttons'][number]): string | null {
  const extrasError = tapExtrasError(button.tapExtras)
  if (extrasError) return extrasError
  if ((FIELD_REQUIREMENTS.button_label.check(button.label) !== null)) return 'ボタンの文字を入力してください'
  if (!button.value.trim()) return button.action === 'form' ? '回答フォームを選んでください' : button.action === 'scenario' ? 'シナリオを選んでください' : button.action === 'message' ? '送る文を入力してください' : 'URLを入力してください'
  if (button.action === 'url') {
    try {
      const url = new URL(button.value)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return 'http か https の URL を入力してください'
    } catch { return '正しい URL を入力してください' }
  }
  return null
}

function validReferences(rows: unknown): rows is HqMessageReference[] {
  return Array.isArray(rows) && rows.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const row = item as Record<string, unknown>
    return typeof row.kind === 'string' && ['form', 'scenario', 'booking', 'visit_stamp'].includes(row.kind) &&
      typeof row.id === 'string' && typeof row.name === 'string' && typeof row.accountName === 'string'
  })
}

export default function MessageForm({
  name, onNameChange, value, onChange, folders, folderId, onFolderChange, onCreateFolder, folderLoadFailed,
  disabled, catalogFailed, onReloadCatalog, onBusyChange, onReceipt, notice, fields,
}: MessageFormProps) {
  const current = value.template
  const [targetDate, setTargetDate] = useState('')
  const [references, setReferences] = useState<HqMessageReference[]>([])
  const [referenceError, setReferenceError] = useState('')
  const [referencesLoading, setReferencesLoading] = useState(true)
  // カード（タイトル・本文・ボタン）で作るか。今の画面と同じ判定：保存済みのカード、または新しく作ったテキスト。
  const usesCard = (Boolean(value.card) || (current.id === 'hq-authored-message' && (current.messageType === 'text' || current.messageType === 'flex') && !current.carouselActionsJson && !current.questionJson))
  const card: HqMessageCard = value.card ?? { format: current.messageType === 'flex' ? 'flex' : 'text', title: '', body: current.messageContent, buttons: [] }

  const referenceRequest = useRef(0)
  const referencesBusy = useRef(false)
  const loadReferences = async () => {
    if (referencesBusy.current) return
    referencesBusy.current = true
    const request = ++referenceRequest.current
    setReferencesLoading(true)
    try {
      const rows = await hqTemplatesApi.messageReferences()
      if (!validReferences(rows)) throw new Error('Invalid references')
      if (referenceRequest.current === request) { setReferences(rows); setReferenceError('') }
    } catch {
      if (referenceRequest.current === request) setReferenceError('ボタンの参照先を読み込めませんでした。入力を残したまま再読み込みできます。')
    } finally {
      if (referenceRequest.current === request) { referencesBusy.current = false; setReferencesLoading(false) }
    }
  }
  useEffect(() => {
    void loadReferences()
    return () => { referenceRequest.current++; referencesBusy.current = false }
    // 初回だけ読み込み、終了後の応答は破棄する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  fields?.define('name', 'ひな形の名前', () => (name.trim() ? null : 'ひな形の名前を入力してください'), { required: true })
  fields?.define('body', '配信する本文', () => ((usesCard ? card.body : current.messageContent).trim() ? null : '配信する本文を入力してください'), { required: true })
  if (usesCard && card.format === 'flex') card.buttons.forEach((button, index) => fields?.define(`button-${button.id}`, `ボタン${index + 1}`, () => cardButtonProblem(button), { required: true }))
  const bindField = (key: string, id: string) => (fields ? { ...fields.bind(key), 'aria-invalid': fields.invalid(key) || undefined, 'aria-describedby': fields.invalid(key) ? `${id}-error` : undefined } : {})

  const updateCard = (next: HqMessageCard) => onChange(withMessageCard(value, next))
  const updateButton = (id: string, patch: Partial<HqMessageCard['buttons'][number]>) => updateCard({ ...card, buttons: card.buttons.map((button) => button.id === id ? { ...button, ...patch } : button) })
  const image = value.media.find((item) => item.id === card.imageMediaId) ?? value.media[0]

  return (
    <div className={styles.editSplit}>
      <section className={styles.editPanel} aria-label="ひな形の中身">
        {catalogFailed ? (
          <Notice tone="warn" message="参照先の候補を読み込めませんでした。タグ・テンプレート・回答フォームは選べません。" action={<Button onClick={onReloadCatalog}>もう一度読み込む</Button>} />
        ) : null}
        {current.messageType === 'flex' || current.messageType === 'image' ? <Notice tone="warn" message={LEGACY_MESSAGE_NOTICE} /> : null}
        <h2 className={styles.editTitle}>ひな形の中身</h2>
        <div className={styles.twoCol}>
          <Field label="ひな形の名前" requirement={fields?.requirement('name')}><SaveErrorField names={["name"]}><SharedTextField aria-label="ひな形の名前" {...bindField('name', 'hq-msg-name')} className={styles.input} value={name} maxLength={200} disabled={disabled} onChange={(event) => onNameChange(event.target.value)} /></SaveErrorField>
<FieldError id="hq-msg-name-error">{fields?.error('name')}</FieldError></Field>
          <Field label="分類"><SaveErrorField names={["category","current.category"]}><SharedTextField aria-label="テンプレートの分類" className={styles.input} value={current.category} maxLength={100} disabled={disabled} onChange={(event) => onChange({ ...value, template: { ...current, category: event.target.value } })} /></SaveErrorField></Field>
        </div>
        <div className={styles.field}>
          <span className={styles.folderPick}>
            <SaveErrorField names={["folderId","folder_id"]}><FolderSelect aria-label="フォルダ" label="フォルダ" value={folderId ?? ''} disabled={disabled || folderLoadFailed} onChange={(next) => onFolderChange(next || null)} folders={folders.map((folder) => ({ value: folder.id, label: folder.name, color: folder.color }))} onCreate={onCreateFolder} /></SaveErrorField>
          </span>
        </div>

        {usesCard ? <>
          {card.format === 'flex' && (
            <div className={styles.field}>
              <span className={styles.smallLabel}>画像 <small className={styles.optional}>PNG・JPEG、1件8 MiB以下</small></span>
              <ImagePick
                value={image?.publicUrl ?? null}
                disabled={disabled}
                onBusyChange={onBusyChange}
                onReceipt={onReceipt}
                onRemove={card.imageMediaId ? () => { const { imageMediaId: _removed, ...next } = card; updateCard(next) } : undefined}
                onUploaded={(media) => { const next = withUploadedImage(value, media); onChange(withMessageCard(next, { ...card, imageMediaId: media.id })) }}
              />
              {image ? <TruncatedText className={styles.imageName} value={`${image.filename}・${image.width ?? emptyValue('unknown')}×${image.height ?? emptyValue('unknown')}`} /> : null}
            </div>
          )}
          <Field label="タイトル"><SaveErrorField names={["title","card.title"]}><SharedTextField className={styles.input} aria-label="ひな形のタイトル" maxLength={200} value={card.title} disabled={disabled} onChange={(event) => updateCard({ ...card, title: event.target.value })} /></SaveErrorField></Field>
          <Field label="本文" requirement={fields?.requirement('body')}><SaveErrorField names={["body","card.body"]}><HqMessageBody value={card.body} label="配信する本文" max={card.format === 'flex'?2000:5000} readOnly={disabled} onChange={body=>updateCard({...card,body})}/></SaveErrorField>
<FieldError id="hq-msg-body-error">{fields?.error('body')}</FieldError></Field>
          {card.format === 'flex' && (
            <div className={styles.buttonsBox}>
              <span className={styles.smallLabel}>ボタン <small className={styles.optional}>最大 3 つ</small></span>
              {referencesLoading && <ListState kind="loading" />}
              {referenceError && <Notice tone="warn" message={referenceError} action={<Button disabled={disabled || referencesLoading} onClick={() => loadReferences()} busyLabel="処理中…">参照先を再読み込み</Button>} />}
              {card.buttons.map((button, index) => (
                <div key={button.id} className={styles.buttonEdit} {...(fields ? fields.bind(`button-${button.id}`) : {})} aria-describedby={fields?.invalid(`button-${button.id}`) ? `hq-msg-button-${button.id}-error` : undefined}>
                  <Field label="ボタンの文字" requirement={FIELD_REQUIREMENTS.button_label}><SaveErrorField names={[`buttons.${index}.label`,"label","button.label"]}><SharedTextField className={styles.input} aria-label={`ボタン${index + 1}の文字`} maxLength={20} disabled={disabled} value={button.label} onChange={(event) => updateButton(button.id, { label: event.target.value })} /></SaveErrorField></Field>
                  <div className={styles.field}>
                    <span className={styles.smallLabel}>押したとき</span>
                    <SaveErrorField names={["button"]}><TapActionField allowExtras accountId={null} extrasError={fields?.error(`button-${button.id}`)}
                      name={`ボタン${index + 1}`}
                      kindLabel={`ボタン${index + 1}を押したとき`}
                      value={cardTapValue(button)}
                      onChange={(patch) => {
                        if (patch.kind !== undefined) { updateButton(button.id, { action: ACTION_OF[patch.kind] ?? 'url', value: '' }); return }
                        if (patch.tapExtras !== undefined) updateButton(button.id, { tapExtras: patch.tapExtras })
                        const next = patch.uri ?? patch.text ?? patch.refId
                        if (next !== undefined) updateButton(button.id, { value: next })
                      }}
                      kinds={CARD_TAP_KINDS}
                      extraKinds={SCENARIO_KIND}
                      scope="hq"
                      hasLiff
                      readOnly={disabled}
                      textMax={300}
                      sources={referenceError || referencesLoading ? {} : { form: references.filter((row) => row.kind === 'form').map((row) => ({ id: row.id, name: `${row.name}（${row.accountName}）` })) }}
                      renderBody={(kind) => kind !== 'scenario' ? undefined : (
                        /* 統括の参照先はアカウントをまたぐので、店のフォルダは読まず行を直接渡す（選ぶ窓 dJZ7Q）。 */
                        <SaveErrorField names={[`buttons.${index}.value`,"value","button.value"]}><EntityPickerField
                          label={`ボタン${index + 1}の参照先`}
                          noun={ENTITY_KINDS.scenario.noun}
                          icon={ENTITY_KINDS.scenario.icon}
                          disabled={disabled || referencesLoading || Boolean(referenceError)}
                          items={references.filter((row) => row.kind === 'scenario').map((row) => ({ id: row.id, name: row.name, meta: row.accountName, keywords: row.accountName }))}
                          value={button.value}
                          onChange={(next) => updateButton(button.id, { value: next })}
                        /></SaveErrorField>
                      )}
                    /></SaveErrorField>
                  </div>
                  <FieldError id={`hq-msg-button-${button.id}-error`}>{fields?.error(`button-${button.id}`)}</FieldError>
                </div>
              ))}
              <span className={styles.addButtonRow}>
                <Button disabled={disabled || card.buttons.length >= 3} onClick={() => updateCard({ ...card, buttons: [...card.buttons, { id: crypto.randomUUID(), label: '', action: 'url', value: '' }] })}><Plus size={16} aria-hidden="true" />ボタンを足す</Button>
              </span>
              <p className={styles.note}>押したときは URLを開く・テキストを送る・回答フォーム・シナリオを始める から選べます</p>
              <p className={styles.noteStrong}>タグ・回答フォームがあるかは、アカウントへ配る前の確認で調べます（ない所は配る前に知らせます）。</p>
            </div>
          )}
        </> : (
          <div {...(fields ? fields.bind('body') : {})}>
          <MessageTemplateEditor hqInserts
            value={{ messageType: current.messageType, messageContent: current.messageContent }}
            onChange={(next) => onChange({ ...value, template: { ...current, messageType: next.messageType as MessageTemplateDefinition['template']['messageType'], messageContent: next.messageContent } })}
            targetDate={targetDate}
            onTargetDateChange={setTargetDate}
            references={EMPTY_TEMPLATE_REFERENCES}
            referenceAccountId={null}
            referenceUnavailableHint="友だち情報と共通情報はアカウントごとに異なるため、配布先のLINEアカウントで設定してください。"
            disabled={disabled}
            showTypeSelector={false}
            bodyAriaLabel="配信する本文"
            afterType={(
              <>
                {value.media.map((media) => <p key={media.id} className={styles.note}>{`${media.filename}（${Math.ceil(media.sizeBytes / 1024)} KB）`}</p>)}
                {current.id === 'hq-authored-message' && <ImagePick disabled={disabled} onBusyChange={onBusyChange} onReceipt={onReceipt} onUploaded={(media) => onChange(withUploadedImage(value, media))} />}
              </>
            )}
          />
          <FieldError id="hq-msg-body-error">{fields?.error('body')}</FieldError>
          </div>
        )}
        {notice}
      </section>

      <aside className={styles.previewColumn} aria-label="LINE の見え方">
        <LinePreview accountName="musubo" empty={!card.title && !card.body && !current.messageContent ? '中身を入れると、ここに LINE での見え方が出ます。' : false}>
          {usesCard && card.format === 'flex' ? (
            <div className={styles.previewRow}>
            <span className={styles.previewAvatar} aria-hidden="true"><MusuboMark /></span>
            <div className={styles.previewCard}>
              {image?.publicUrl ? <span className={styles.previewImage} style={{ backgroundImage: `url(${JSON.stringify(image.publicUrl)})` }} aria-hidden="true" /> : <span className={styles.previewImage} aria-hidden="true" />}
              <span className={styles.previewCopy}>
                <strong>{card.title || 'タイトル'}</strong>
                <span>{card.body}</span>
              </span>
              {card.buttons.map((button) => <span key={button.id} className={styles.previewAction}>{button.label || 'ボタン'}</span>)}
            </div>
            <span className={styles.previewTime}>10:00</span>
            </div>
          ) : (
            <LinePreviewMessage accountName="musubo" avatar={<MusuboMark />} time="10:00">{usesCard ? [card.title, card.body].filter(Boolean).join('\n') : current.messageContent}</LinePreviewMessage>
          )}
        </LinePreview>
      </aside>
    </div>
  )
}

/** 画像を選んで送る。R568：今の大きさで採用できない画像は送る前に止め、受け取りを先に残す。 */
function ImagePick({ value = null, disabled, onUploaded, onBusyChange, onReceipt, onRemove }: { value?: string | null; disabled: boolean; onUploaded: (media: TemplateMedia) => void; onBusyChange?: (busy: boolean) => void; onReceipt?: (media: TemplateMedia) => void; onRemove?: () => void }) {
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const alive = useRef(true)
  const locked = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusyChange?.(false) } }, [onBusyChange])
  const upload = async (file?: File) => {
    if (!file || disabled || locked.current) return
    locked.current = true; setUploading(true); onBusyChange?.(true); setError('')
    try {
      await decodeImageSize(file)
      const media = await hqTemplatesApi.uploadImage(file, 'message')
      if (alive.current) { onReceipt?.(media); onUploaded(media) }
    } catch (e) {
      if (alive.current) setError(describeApiFailure(e, '登録', { scope: 'hq' }))
    } finally {
      locked.current = false
      if (alive.current) { setUploading(false); onBusyChange?.(false) }
    }
  }
  return (
    <SaveErrorField names={["value"]}><MediaSlot
      title="画像を追加"
      value={value}
      accept="image/png,image/jpeg"
      maxBytes={8 * 1024 * 1024}
      busy={uploading}
      error={error}
      disabled={disabled}
      onFile={(file) => void upload(file)}
      onRemove={onRemove}
    /></SaveErrorField>
  )
}
