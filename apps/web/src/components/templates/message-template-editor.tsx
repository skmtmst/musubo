'use client'
import type { TemplateReferenceState, TemplateReferences, TemplatePreviewResult } from './template-preview-model'
import { EMPTY_TEMPLATE_REFERENCES, previewDateValue, buildTemplatePreview, extractMessageUrls } from './template-preview-model'
export { EMPTY_TEMPLATE_REFERENCES, previewDateValue, buildTemplatePreview, extractMessageUrls } from './template-preview-model'
export type { TemplateReferenceState, TemplateReferences, TemplatePreviewResult } from './template-preview-model'

import HqMessageBody from '@/components/shared/hq-message-inserts'
import EntitySelect from '@/components/shared/entity-select'
import Link from '@/components/shared/list-navigation'
import { useRef, type ReactNode } from 'react'
import { validateFlexContent } from '@line-crm/shared'
import { LinePreviewFlex as FlexPreviewComponent } from '@/components/shared/line-preview'
import { useFeatureVisibility } from '@/lib/use-feature-visibility'
import Button from '@/components/shared/button'
import LinePreview from '@/components/shared/line-preview'
import { Field, TextArea } from '@/components/shared/form-controls'
import DateField from '@/components/shared/date-field'
import Select from '@/components/shared/select'
import { formatNumber } from '@/lib/format'

export const LEGACY_MESSAGE_NOTICE = 'この形は新しく作れません。新しく作るときはカルーセル・リッチメッセージを使ってください。'

export const MESSAGE_TEMPLATE_TYPES = [
  { value: 'text', label: 'テキスト' },
  { value: 'flex', label: 'カード型' },
  { value: 'image', label: '画像' },
] as const

const DATE_OPTIONS = [
  { value: '{{date}}', label: '月日と曜日（8月20日(木)）' },
  { value: '{{date:ymd_w}}', label: '年月日と曜日（2026年8月20日(木)）' },
  { value: '{{date:md}}', label: '月日（8月20日）' },
  { value: '{{date:ymd}}', label: '年月日（2026年8月20日）' },
  { value: '{{date:slash_md_w}}', label: '月日と曜日（8/20(木)）' },
  { value: '{{date:slash_ymd_w}}', label: '年月日と曜日（2026/8/20(木)）' },
  { value: '{{date:slash_md}}', label: '月日（8/20）' },
  { value: '{{date:slash_ymd}}', label: '年月日（2026/8/20）' },
]

const OTHER_OPTIONS = [
  { value: '{{liff_id}}', label: 'LIFF ID' },
  { value: '{{date+1}}', label: '配信日の1日後' },
  { value: '{{date+3}}', label: '配信日の3日後' },
  { value: '{{date+7}}', label: '配信日の7日後' },
  { value: '{{date+14}}', label: '配信日の14日後' },
  { value: '{{date+30}}', label: '配信日の30日後' },
]

interface InsertControlsProps extends TemplateReferences {
  accountId: string | null
  state: TemplateReferenceState
  accountLabel?: string | null
  targetDate: string
  disabled?: boolean
  unavailableHint?: ReactNode
  onTargetDateChange: (value: string) => void
  onInsert: (token: string) => void
}

export function TemplateInsertControls({
  accountId,
  state,
  accountLabel,
  targetDate,
  disabled = false,
  unavailableHint,
  onTargetDateChange,
  friendFields,
  commonVars,
  onInsert,
}: InsertControlsProps) {
  // 友だち情報・共通情報は任意機能。オフのaccountでは差し込み口ごと出さない。
  const featureVisibility = useFeatureVisibility(accountId)
  const fieldsEnabled = featureVisibility.enabled('friend_fields')
  const varsEnabled = featureVisibility.enabled('common_vars')
  const choose = (value: string) => {
    if (value) onInsert(value)
  }
  return (
    <div aria-label="利用できる差し込み項目" className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="field" disabled={disabled} onClick={() => onInsert('{{name}}')}>名前</Button>
        {fieldsEnabled && (
          <EntitySelect aria-label="友だち情報を差し込む" value="" disabled={disabled || !accountId || state !== 'ready' || friendFields.length === 0} onChange={(value) => choose(value)} options={[{ value: '', label: state === 'loading' ? '友だち情報を読込中' : '友だち情報を選ぶ' }, ...friendFields.map((field) => ({ value: `{{field.${field.fieldKey}}}`, label: field.name }))]} />
        )}
        {varsEnabled && (
          <EntitySelect aria-label="共通情報を差し込む" value="" disabled={disabled || !accountId || state !== 'ready' || commonVars.length === 0} onChange={(value) => choose(value)} options={[{ value: '', label: state === 'loading' ? '共通情報を読込中' : '共通情報を選ぶ' }, ...commonVars.map((item) => ({ value: `{{var.${item.varKey}}}`, label: item.name }))]} />
        )}
        <Select aria-label="配信日を差し込む" value="" disabled={disabled} onChange={(value) => choose(value)} options={[{ value: '', label: '配信日を選ぶ' }, ...DATE_OPTIONS]} />
        <Select aria-label="その他の差し込みを選ぶ" value="" disabled={disabled} onChange={(value) => choose(value)} options={[{ value: '', label: 'その他を選ぶ' }, ...OTHER_OPTIONS]} />
        <span className="flex items-center gap-2 text-xs text-ink-secondary">
          目標日
          <DateField aria-label="日数を数える目標日" value={targetDate} disabled={disabled} onChange={onTargetDateChange} className="w-48" />
        </span>
        <Button size="field" disabled={disabled || !targetDate} onClick={() => onInsert(`{{days_until:${targetDate}}}`)}>目標日までの日数</Button>
      </div>
      <p className="text-ink-faint text-xs">フォーム回答は直接差し込めません。回答を保存した友だち情報を選んでください。</p>
      {accountLabel && <p className="text-ink-faint text-xs">候補は「{accountLabel}」の友だち情報と共通情報です。</p>}
      {!accountId && <p className="text-ink-faint text-xs">{unavailableHint ?? 'LINE公式アカウントを選ぶと、友だち情報と共通情報を選べます。'}</p>}
      {state === 'failed' && <p role="alert" className="text-danger text-xs">差し込み項目を読み込めませんでした。画面を再読み込みしてください。</p>}
    </div>
  )
}

export function TemplatePreviewMessage({ preview }: { preview: TemplatePreviewResult }) {
  return (
    <>
      <p className="text-ink rounded-card bg-canvas px-4 py-3 text-sm leading-6 whitespace-pre-wrap">{preview.content || '（本文がまだありません）'}</p>
      {preview.unresolved.length > 0 && (
        <div role="alert" className="mt-2 rounded-control bg-canvas px-3 py-2 text-xs text-danger">
          <p className="font-semibold">値を確認できない差し込みがあります</p>
          <ul className="mt-1 list-disc pl-4">{preview.unresolved.map((name) => <li key={name}>{`{{${name}}}`}</li>)}</ul>
        </div>
      )}
    </>
  )
}

export interface MessageTemplateEditorValue {
  messageType: string
  messageContent: string
}

export function MessageTemplateEditor({
  value,
  onChange,
  targetDate,
  onTargetDateChange,
  references = EMPTY_TEMPLATE_REFERENCES,
  referenceState = 'idle',
  referenceAccountId = null,
  referenceAccountLabel,
  referenceUnavailableHint,
  disabled = false,
  typeOptions = MESSAGE_TEMPLATE_TYPES,
  showTypeSelector = true,
  typeNote,
  bodyLabel,
  bodyAriaLabel,
  carouselHref,
  beforeType,
  afterType,
  editorContent,
  footer,
  hqInserts=false,
}: {
  value: MessageTemplateEditorValue
  onChange: (next: MessageTemplateEditorValue) => void
  targetDate: string
  onTargetDateChange: (value: string) => void
  references?: TemplateReferences
  referenceState?: TemplateReferenceState
  referenceAccountId?: string | null
  referenceAccountLabel?: string | null
  referenceUnavailableHint?: ReactNode
  disabled?: boolean
  typeOptions?: ReadonlyArray<{ value: string; label: string }>
  /** 既存の中身の種類を保ったまま編集するときは切り替えを出さない。 */
  showTypeSelector?: boolean
  typeNote?: ReactNode
  bodyLabel?: string
  bodyAriaLabel?: string
  carouselHref?: string
  beforeType?: ReactNode
  afterType?: ReactNode
  editorContent?: ReactNode
  hqInserts?: boolean
  footer?: ReactNode
}) {
  const contentRef = useRef<HTMLTextAreaElement | null>(null)
  /*
   * D007: 形の違う詳細応答が来ると、文字列でない中身がここへ届く。
   * 描画の途中で落ちないよう、文字列以外は空として扱う。
   */
  const messageContent = typeof value.messageContent === 'string' ? value.messageContent : ''
  const insert = (token: string) => {
    const element = contentRef.current
    const start = element?.selectionStart ?? messageContent.length
    const end = element?.selectionEnd ?? start
    const nextContent = messageContent.slice(0, start) + token + messageContent.slice(end)
    onChange({ ...value, messageContent: nextContent })
    if (element) requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const splitAt = 4500
  const preview = buildTemplatePreview(messageContent, references)
  const messageUrls = extractMessageUrls(messageContent)
  /*
   * R249: カード型は通常文のまま保存できない。入力の最中に
   * 形式の誤りをその場で知らせる（保存口も同じ判定で断る）。
   * 空のときはここでは何も言わない（必須チェックが受け持つ）。
   */
  const flexError = value.messageType === 'flex'
    ? validateFlexContent('flex', messageContent)
    : null
  const contentLabel = bodyLabel ?? (value.messageType === 'text' ? '本文' : 'メッセージ内容')

  return (
    <div data-design="Body" className="flex flex-col gap-4 xl:flex-row">
      <div data-design="Left" className="bg-canvas rounded-card content-card min-w-0 flex-1 space-y-5 border p-6">
        {beforeType}
        {editorContent ?? <>
        {showTypeSelector ? <Field label="種類" htmlFor="tp-type" note={typeNote}>
          <Select id="tp-type" aria-label="メッセージ形式" value={value.messageType} disabled={disabled} onChange={(messageType) => onChange({ ...value, messageType })} options={[...typeOptions]} />
        </Field> : null}
        {afterType}
        {/*
          U058: 本文の欄を先に出す。差し込みの操作群を上に置くと、
          狭い画面で本文が段の下まで押し出されて見えなくなる。
          本文のすぐ下にまとめて置けば、書きながら下へ手を伸ばして
          差し込める。
        */}
        <Field
          label={contentLabel}
          htmlFor="tp-content"
          required
          note={<>
            差し込みは下の選択肢から入れられます。名前と友だち情報は受け取る人ごと、共通情報と配信日は送る時点の値に置き換わります。
            {carouselHref && <><br />カルーセルを作るときは <Link href={carouselHref} className="text-action underline">カルーセルの編集</Link> を使ってください。</>}
          </>}
        >
          {value.messageType === 'flex' ? (
            <>
              <TextArea id="tp-content" aria-label={bodyAriaLabel} ref={contentRef} rows={14} value={messageContent} disabled={disabled} onChange={(event) => onChange({ ...value, messageContent: event.target.value })} className="resize-y font-mono text-xs" />
              {flexError ? (
                <p role="alert" className="text-danger mt-1 text-xs">{flexError}このままでは保存できません。</p>
              ) : !messageContent.trim() ? (
                <p className="text-ink-faint mt-1 text-xs">バブルかカルーセルの形のJSONで書きます（例：{'{"type":"bubble", …}'}）。通常文のままでは保存できません。</p>
              ) : null}
            </>
          ) : (
            hqInserts ? <HqMessageBody value={messageContent} label={bodyAriaLabel} readOnly={disabled} onChange={messageContent=>onChange({...value,messageContent})}/> : (<TextArea id="tp-content" aria-label={bodyAriaLabel} ref={contentRef} rows={6} value={messageContent} disabled={disabled} onChange={(event) => onChange({ ...value, messageContent: event.target.value })} className="resize-y" />)
          )}
          <p className="text-ink-faint mt-1 text-xs tabular-nums">{formatNumber(messageContent.length)} 文字{messageContent.length > splitAt ? `・約${splitAt}文字を超えると複数のメッセージに分割されます` : '・分割なし'}</p>
        </Field>
        {!hqInserts && <div>
          <p className="text-ink-secondary mb-1 text-sm font-medium">差し込む</p>
          <TemplateInsertControls accountId={referenceAccountId} state={referenceState} accountLabel={referenceAccountLabel} targetDate={targetDate} disabled={disabled} unavailableHint={referenceUnavailableHint} onTargetDateChange={onTargetDateChange} friendFields={references.friendFields} commonVars={references.commonVars} onInsert={insert} />
        </div>}
        </>}
        <section aria-label="本文内のURL" className="border-hairline rounded-card border p-4">
          <div className="flex items-center justify-between gap-3"><p className="text-ink text-sm font-semibold">本文に入れたURLの扱い</p><span className="text-ink-faint text-xs font-semibold">短縮して、クリックを数える</span></div>
          <div className="border-hairline mt-3 overflow-hidden rounded-control border text-xs">
            <div className="bg-canvas-sunken grid grid-cols-3 gap-3 px-3 py-2 font-semibold text-ink-secondary"><span>本文の中のURL</span><span>リンク名（計測に出る名前）</span><span>流入リンクにする</span></div>
            {messageUrls.length === 0 ? <p className="text-ink-faint px-3 py-3">本文にURLはありません。</p> : messageUrls.map((url) => <div key={url} className="grid grid-cols-3 gap-3 px-3 py-3 text-ink"><span className="truncate" title={url}>{url}</span><span className="text-ink-faint">配信時に自動作成</span><span className="text-ink-faint">配信時に自動発行</span></div>)}
          </div>
        </section>
        <section className="border-hairline rounded-card border p-4"><p className="text-ink text-sm font-semibold">送信時のアイコン・表示名</p><p className="text-ink-faint mt-1 text-xs leading-relaxed">公式アイコンと表示名で送信します。担当者名義で送ることはできません。</p></section>
        {footer}
      </div>
      <div data-design="Right" className="w-full shrink-0 space-y-4 xl:w-96">
        <LinePreview
          note={value.messageType === 'flex' ? 'カードの見え方です。' : '差し込み後の見え方（見本 141さんの場合）'}
          accountName="LINE公式アカウント"
        >
          {/*
            R249: カード型は詳細と同じカード表示にする。通常文の
            生表示では「作れた」と誤認する。形式が壊れている間は
            何が悪いかをここでも知らせる。
          */}
          {value.messageType === 'flex' ? (
            flexError ? (
              <div role="alert" className="bg-canvas-sunken rounded-card p-3">
                <p className="text-danger text-xs font-semibold">{flexError}</p>
                <p className="text-ink-secondary mt-1 text-xs">直すとここにカードが表示されます。このままでは保存できません。</p>
              </div>
            ) : !messageContent.trim() ? (
              <div className="bg-canvas-sunken rounded-card p-3">
                <p className="text-ink-faint text-xs">カードの内容を入力すると、ここに表示されます。</p>
              </div>
            ) : (
              <div className="bg-canvas-sunken rounded-card p-3"><FlexPreviewComponent content={messageContent} /></div>
            )
          ) : (
            <>
              <div className="bg-canvas-sunken rounded-card p-3"><TemplatePreviewMessage preview={preview} /></div>
              <p className="text-ink mt-2 text-xs leading-relaxed">名前は見本 141さん、友だち情報は項目の既定値、共通情報は現在値で表示しています。</p>
              <p className="text-ink mt-1 text-xs">URLは短縮され、クリックが計測されます</p>
            </>
          )}
        </LinePreview>
      </div>
    </div>
  )
}
