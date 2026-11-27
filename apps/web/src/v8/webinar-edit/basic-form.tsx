'use client'
import Card, { CardHeader } from '@/components/shared/card'
import type { ReactNode } from 'react'
import { CalendarDays, Play } from 'lucide-react'
import Button from '@/components/shared/button'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import FolderSelect, { type FolderSelectCreate } from '@/components/shared/folder-select'
import { TextField } from '@/components/shared/text-field'
import type { WebinarFolder } from '@/lib/api'
import { ReadValue } from './parts'
import styles from './form.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { SettingsFormRow } from '@/components/shared/settings-form-card'


/*
 * ★V8 ウェビナーの①基本設定の中身（Pencil ）。作る（/webinars/new）と編集の①の両方で使う。
 * カード3枚：基本設定（名前・公開ページの URL・フォルダ・案内文）／開催形式／だれに案内するか。
 */

export type BasicValues = {
  title: string
  slug: string
  folderId: string
  description: string
  deliveryKind: 'on_demand' | 'scheduled' | 'external'
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function BasicForm({
  idPrefix,
  values,
  onChange,
  folders,
  folderState,
  onReloadFolders,
  onCreateFolder,
  audienceLabel,
  fieldErrors,
  onBlurTitle,
  onBlurSlug,
  disabled,
  readOnly = false,
}: {
  idPrefix: string
  values: BasicValues
  onChange: (patch: Partial<BasicValues>) => void
  folders: WebinarFolder[]
  folderState: 'loading' | 'ready' | 'error'
  onReloadFolders: () => void
  /** フォルダを選ぶ欄からその場で作る（dLffh）。閲覧のみは渡さない。 */
  onCreateFolder?: FolderSelectCreate
  audienceLabel: string
  fieldErrors: { title?: string; slug?: string }
  onBlurTitle?: () => void
  onBlurSlug?: () => void
  disabled: boolean
  /** 閲覧のみ。選ぶ欄は押せない形にせず、値の文字で見せる。 */
  readOnly?: boolean
}) {
  const folderOptions = [
    { value: '', label: '未分類' },
    ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
    ...(values.folderId && !folders.some((folder) => folder.id === values.folderId) ? [{ value: values.folderId, label: '今のフォルダ' }] : []),
  ]
  return (
    <>
      <Card variant="form" gap="normal" aria-labelledby={`${idPrefix}-basic`}>
        <CardHeader size="stacked" titleId={`${idPrefix}-basic`} title="基本設定" />
        <div className={styles.field}><Field label="名前" htmlFor={`${idPrefix}-title`} required><SaveErrorField names={["title","values.title"]}><TextField
            id={`${idPrefix}-title`}
            value={values.title}
            disabled={disabled}
            readOnly={readOnly}
            placeholder="musubo活用スタートセミナー"
            invalid={Boolean(fieldErrors.title)}
            aria-describedby={fieldErrors.title ? `${idPrefix}-title-error` : undefined}
            onChange={(event) => onChange({ title: event.target.value })}
            onBlur={onBlurTitle}
          /></SaveErrorField>
{fieldErrors.title ? <p id={`${idPrefix}-title-error`} className={styles.fieldError} role="alert">{fieldErrors.title}</p> : null}</Field></div>
        <SettingsFormRow layout="columns">
          <div className={styles.field}>
            <Field label="公開ページの URL" help="アドレスの最後の部分です。半角の英小文字・数字・ハイフンで入れます。作るときに空のままなら自動で付けます。" htmlFor={`${idPrefix}-slug`}><SaveErrorField names={["slug","values.slug"]}><TextField
              id={`${idPrefix}-slug`}
              value={values.slug}
              disabled={disabled}
              readOnly={readOnly}
              placeholder="nen-start"
              inputMode="url"
              invalid={Boolean(fieldErrors.slug)}
              aria-describedby={fieldErrors.slug ? `${idPrefix}-slug-error` : undefined}
              onChange={(event) => onChange({ slug: event.target.value })}
              onBlur={onBlurSlug}
            /></SaveErrorField></Field>
            {fieldErrors.slug ? <p id={`${idPrefix}-slug-error`} className={styles.fieldError} role="alert">{fieldErrors.slug}</p> : null}
          </div>
          <div className={styles.field}><Field label="フォルダ" htmlFor={`${idPrefix}-folder`}>{readOnly
              ? <ReadValue label="フォルダ">{folderOptions.find((option) => option.value === values.folderId)?.label ?? '未分類'}</ReadValue>
              : <SaveErrorField names={["folderId","values.folderId","folder_id","values.folder_id"]}><FolderSelect id={`${idPrefix}-folder`} aria-label="フォルダ" size="full" value={values.folderId} disabled={disabled || folderState !== 'ready'} onChange={(value) => onChange({ folderId: value })} folders={folderOptions.slice(1).map((option) => ({ ...option, color: folders.find((folder) => folder.id === option.value)?.color ?? null }))} onCreate={onCreateFolder} /></SaveErrorField>}
{folderState === 'error' ? (
              <p className={styles.help} role="alert">フォルダを読み込めませんでした。<Button size="compact" disabled={disabled} onClick={() => { if (!disabled) onReloadFolders() }}>もう一度読み込む</Button></p>
            ) : null}</Field></div>
        </SettingsFormRow>
        <div className={styles.field}><Field label="案内文" htmlFor={`${idPrefix}-description`}><SaveErrorField names={["description","values.description"]}><TextField
            id={`${idPrefix}-description`}
            value={values.description}
            disabled={disabled}
            readOnly={readOnly}
            placeholder="15分で musubo の使い方がわかる無料セミナーです"
            onChange={(event) => onChange({ description: event.target.value })}
          /></SaveErrorField></Field></div>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby={`${idPrefix}-kind`}>
        <CardHeader size="stacked" titleId={`${idPrefix}-kind`} title="開催形式" meta="あとから動画の段でも変えられます" />
        {/* 閲覧のみ：選ぶ部品は置かず、選んでいる形式を文字で見せる（2026-10-06 オーナー決定）。 */}
        {readOnly ? (
          <ReadValue label="開催形式">{values.deliveryKind === 'scheduled' ? '日時指定配信' : values.deliveryKind === 'on_demand' ? 'オンデマンド配信' : '外部の動画'}</ReadValue>
        ) : (
          <SaveErrorField names={["deliveryKind","values.deliveryKind"]}><RadioCardGroup legend="開催形式" className={styles.radioPair}>
            <RadioCard name={`${idPrefix}-delivery`} value="on_demand" checked={values.deliveryKind === 'on_demand'} disabled={disabled} onChange={() => onChange({ deliveryKind: 'on_demand' })} title="オンデマンド配信" note="録画動画をいつでも視聴" icon={<Play size={16} />} />
            <RadioCard name={`${idPrefix}-delivery`} value="scheduled" checked={values.deliveryKind === 'scheduled'} disabled={disabled} onChange={() => onChange({ deliveryKind: 'scheduled' })} title="日時指定配信" note="指定日時に公開開始" icon={<CalendarDays size={16} />} />
          </RadioCardGroup></SaveErrorField>
        )}
        {values.deliveryKind === 'external' ? <p className={styles.help}>今は外部の動画を使っています。別の形式を選ぶまでそのままです。</p> : null}
      </Card>

      <Card variant="form" gap="normal" aria-labelledby={`${idPrefix}-audience`}>
        <CardHeader size="stacked" titleId={`${idPrefix}-audience`} title="だれに案内するか" />
        <div className={styles.field}><Field note={<>タグ「配信済み」は確認の段で足せます</>} label="案内する相手"><ReadValue label="案内する相手">{audienceLabel}</ReadValue>
</Field></div>
      </Card>
    </>
  )
}

/** LINE での見え方（申込の案内の1通目）。 */
export function BasicPreview({ title, description, accountName, action }: { title: string; description: string; accountName: string; action?: ReactNode }) {
  return (
    <>
      <LinePreview accountName={accountName} caption="いま">
        <LinePreviewMessage accountName={accountName} avatar={accountName.trim().charAt(0) || 'L'} time="">
          {`【無料セミナー】${title.trim() || '（ウェビナー名）'}`}
          <br />
          {description.trim() || 'セミナーの案内文がここに出ます。'}
          <br />
          ▶ 申込はこちら
        </LinePreviewMessage>
      </LinePreview>
      {action}
    </>
  )
}
