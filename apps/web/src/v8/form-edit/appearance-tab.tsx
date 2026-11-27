'use client'
import TextLink from '@/components/shared/text-link'
import Card from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import { useRef, useState } from 'react'
import { Sparkles, Link2, Store, Palette } from 'lucide-react'
import {
  FORM_THEME_DEFAULT, CUSTOMER_DESIGNS, DEFAULT_CUSTOMER_LOOK, resolveCustomerFormTheme, type CustomerLook,
  formThemeContrastError,
  normalizeFormTheme,
  type FormCornerRadius,
  type FormFontFamily,
  type FormOptions,
  type FormTheme,
} from '@line-crm/shared'
import Button from '@/components/shared/button'
import RadioCard, {RadioCardGroup} from '@/components/shared/radio-card'
import CustomerDesignPicker from '@/components/shared/customer-design-picker'
import ColorWell from '@/components/shared/color-well'
import DateTimeField from '@/components/shared/date-time-field'
import Dialog from '@/components/shared/dialog'
import { TextArea, TextField } from '@/components/shared/text-field'
import Select from '@/components/shared/select'
import Toggle, { ToggleField } from '@/components/shared/toggle'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import MediaSlot from '@/components/shared/media-slot'
import { uploadToMediaLibrary } from '@/components/shared/media-library-upload'
import { ogImageUrlError } from './model'
import styles from './edit.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import { Field, FieldError } from '@/components/shared/form-controls'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import ImageFrame from '@/components/shared/image-frame'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { FormNameField } from './form-name-field'

/*
 * 「受付と見た目」のタブ。受付のきまり・色と文字・背景とリンクの見え方・
 * ボタンの言葉。いちばん下に、フォームの名前と覚え書き（お客さまには出ない）。
 * 色と書体の決まり（文字と背景の差 4.5:1）は今までのデザイン設定と同じ。
 */

type ColorKey = keyof Pick<FormTheme, 'main' | 'sub' | 'accent' | 'error' | 'text'>
const COLOR_ROLES: { key: ColorKey; label: string }[] = [
  { key: 'main', label: 'メイン（ボタン・見出し・選択中の枠）' },
  { key: 'sub', label: 'サブ（帯や背景の薄い面）' },
  { key: 'accent', label: 'アクセント（リンクと補足の強調）' },
  { key: 'error', label: 'エラー（入力の間違い）' },
  { key: 'text', label: '文字（本文）' },
]

const FONT_LABEL: Record<FormFontFamily, string> = { sans: 'ゴシック', serif: '明朝' }
const RADIUS_LABEL: Record<FormCornerRadius, string> = { none: '角ばった', medium: 'やや丸い', round: '丸い' }

function lookupOwn(table: Record<string, string>, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback
}

function validPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

type Props = {
  readOnly?: boolean
  options: FormOptions
  accountId: string | null
  accountLook?: CustomerLook | null
  accountLookError?: string
  /** 統括のひな形（host.ts）：背景の画像・リンクの見え方は置き場が無い（配った先で決める）。 */
  portable?: boolean
  name: string
  nameError: string | null
  description: string
  ogTitle: string
  ogDescription: string
  ogImageUrl: string
  onChangeOptions: (next: Partial<FormOptions>) => void
  onChangeName: (next: string) => void
  onBlurName?: () => void
  onChangeDescription: (next: string) => void
  onChangeOgTitle: (next: string) => void
  onChangeOgDescription: (next: string) => void
  onChangeOgImageUrl: (next: string) => void
}

export function AppearanceTab(props: Props) {
  const { options, onChangeOptions } = props
  const mode = options.customerDesign?.mode ?? (options.theme ? 'fixed' : 'account')
  const preset = options.customerDesign?.preset ?? (options.theme ? 'custom' : 'line')
  const theme = resolveCustomerFormTheme(options,props.accountLook ?? DEFAULT_CUSTOMER_LOOK)
  const accountLabel = CUSTOMER_DESIGNS.find(design=>design.id===props.accountLook?.preset)?.label
    ?? (props.accountLook?.preset === 'custom' ? 'カスタム' : props.accountLookError ? '確認できません' : '読み込み中')
  const rawLimitMax = options.totalLimit?.max
  const resolvedLimitMax = rawLimitMax === undefined || rawLimitMax === null
    ? 300
    : validPositiveInt(rawLimitMax)
      ? rawLimitMax
      : null
  const contrastError = formThemeContrastError(normalizeFormTheme(theme))
  const [pickerFor, setPickerFor] = useState<'background' | 'ogImage' | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const patchTheme = (next: Partial<FormTheme>) => onChangeOptions({customerDesign:{mode:'fixed',preset:'custom'}, theme: { ...theme, ...next } })
  const patchBackground = (backgroundImageUrl: string | null) => onChangeOptions({customerDesign:{mode,preset},theme:{...theme,backgroundImageUrl}})
  const deadlineOn = options.deadline?.enabled ?? false
  const ogImageError = ogImageUrlError(props.ogImageUrl)
  const initialAppearance = useRef({ theme: { ...theme }, ogTitle: props.ogTitle, ogDescription: props.ogDescription, ogImageUrl: props.ogImageUrl })
  const linkSummary = [props.ogTitle.trim() ? '見出し' : null, props.ogDescription.trim() ? '説明' : null, props.ogImageUrl.trim() ? '画像' : null].filter(Boolean).join('・') || '自動で作る'

  if (props.readOnly) {
    const rows = [
      ['受付の開始', '公開したときから'],
      ['受付の終了', deadlineOn ? options.deadline?.endsAt || '期限なし' : '期限なし'],
      ['1人1回だけ答えられる', options.oncePerFriend?.enabled ? 'オン' : 'オフ'],
      ['答えの数の上限', options.totalLimit?.enabled ? (validPositiveInt(options.totalLimit.max) ? polishFormatNumber(options.totalLimit.max) : '—') : '制限なし'],
      ['前回の答えを最初から入れておく', options.restorePrevious ? 'オン' : 'オフ'],
      ['送る前に確認の画面', options.confirmDialog?.enabled ? 'オン' : 'オフ'],
      ['期限を過ぎた人に出す文', options.deadline?.message || '受付は終了しました'],
      ['ページの題名', options.pageTitle || '回答フォーム'],
      ['書体', lookupOwn(FONT_LABEL, theme.fontFamily, '確認できません')],
      ['角の丸み', lookupOwn(RADIUS_LABEL, theme.cornerRadius, '確認できません')],
      ...COLOR_ROLES.map(({ key, label }) => [label, theme[key]]),
      ['背景の画像', theme.backgroundImageUrl || '未設定'],
      ['カードの見出し', props.ogTitle || '自動で作る'],
      ['カードの説明', props.ogDescription || '自動で作る'],
      ['カードの画像', props.ogImageUrl || '自動で作る'],
      ['前へ', options.prevLabel || '前へ'],
      ['次へ', options.nextLabel || '次へ'],
      ['送る', options.submitLabel || '送信する'],
      ['フォーム名', props.name],
      ['覚え書き', props.description || '未設定'],
    ]
    return <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)">
      <h2 className={styles.cardTitle}>受付と見た目</h2>
      <dl>{rows.map(([label, value]) => <div className={styles.field} key={label}><dt className={styles.fieldLabel}>{label}</dt><dd>{value}</dd></div>)}</dl>
    </Card>
  }

  return (
    <>
      <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-labelledby="fe-reception-title">
        <h2 id="fe-reception-title" className={styles.cardTitle}>受付のきまり</h2>
        <div className={styles.periodRow}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>受付の開始</span>
            {/* 開始の日時を保存する口はまだ無い。公開した時から受け付ける（今の動き）を出す。 */}
            <span className={styles.readonlyBox}>公開したときから</span>
          </div>
          <span className={styles.periodSep} aria-hidden="true">〜</span>
          <div className={styles.field}>
            <span className={styles.fieldLabel} id="fe-deadline-label">受付の終了（空なら終わらない）</span>
            <SaveErrorField names={["endsAt","options.deadline?.endsAt","deadline?.endsAt","ends_at","options.deadline?.ends_at","deadline?.ends_at"]}><DateTimeField
              aria-labelledby="fe-deadline-label"
              value={deadlineOn ? (options.deadline?.endsAt ?? '') : ''}
              onChange={(value) => onChangeOptions({ deadline: { ...options.deadline, enabled: Boolean(value), endsAt: value || null } })}
            /></SaveErrorField>
          </div>
        </div>
        <div className={styles.toggleRow}>
          <span>1人1回だけ答えられる</span>
          <SaveErrorField names={["enabled","options.oncePerFriend?.enabled","oncePerFriend?.enabled","options.once_per_friend?.enabled","once_per_friend?.enabled"]}><Toggle checked={options.oncePerFriend?.enabled ?? false} onChange={(enabled) => onChangeOptions({ oncePerFriend: { ...options.oncePerFriend, enabled } })} label="1人1回だけ答えられる" /></SaveErrorField>
        </div>
        <div className={styles.toggleRow}>
          <span>{`答えの数が ${resolvedLimitMax === null ? '—' : polishFormatNumber(resolvedLimitMax)}件 になったら締め切る`}</span>
          <SaveErrorField names={["enabled","options.totalLimit?.enabled","totalLimit?.enabled","options.total_limit?.enabled","total_limit?.enabled"]}><Toggle
            checked={options.totalLimit?.enabled ?? false}
            onChange={(enabled) => onChangeOptions({ totalLimit: { ...options.totalLimit, enabled, max: resolvedLimitMax ?? 300 } })}
            label="答えの数が上限になったら締め切る"
          /></SaveErrorField>
        </div>
        {options.totalLimit?.enabled ? (
          <div className={styles.limitRow}><Field label="締め切る件数" htmlFor="fe-total-limit"><SaveErrorField names={["max","options.totalLimit?.max","totalLimit?.max","options.total_limit?.max","total_limit?.max"]}><NumberInput
              id="fe-total-limit"
              type="number"
              min={1}
              className={styles.limitInput}
              value={resolvedLimitMax === null ? '' : String(resolvedLimitMax)}
              onChange={(e) => {
                const parsed = Number(e.target.value)
                const nextMax = Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1
                onChangeOptions({ totalLimit: { ...options.totalLimit, enabled: true, max: nextMax } })
              }}
            /></SaveErrorField></Field></div>
        ) : null}
        {/* 受付のきまりは1枚のカードにまとめる（つづきで割らない）。 */}
        <SaveErrorField names={["restorePrevious","options.restorePrevious","restore_previous","options.restore_previous"]}><ToggleField checked={options.restorePrevious ?? false} onChange={(restorePrevious) => onChangeOptions({ restorePrevious })}>前回の答えを最初から入れておく</ToggleField></SaveErrorField>
        <SaveErrorField names={["enabled","options.confirmDialog?.enabled","confirmDialog?.enabled","options.confirm_dialog?.enabled","confirm_dialog?.enabled"]}><ToggleField checked={options.confirmDialog?.enabled ?? false} onChange={(enabled) => onChangeOptions({ confirmDialog: { ...options.confirmDialog, enabled } })}>送る前に確認の画面を出す</ToggleField></SaveErrorField>
        <div className={styles.field}><Field label="期限を過ぎた人に出す文" htmlFor="fe-deadline-message"><SaveErrorField names={["message","options.deadline?.message","deadline?.message"]}><TextField id="fe-deadline-message" value={options.deadline?.message ?? ''} placeholder="受付は終了しました" onChange={(e) => onChangeOptions({ deadline: { ...options.deadline, enabled: options.deadline?.enabled ?? false, message: e.target.value } })} /></SaveErrorField></Field></div>
        <div className={styles.field}><Field label="ページの題名（LINE の上に出る）" htmlFor="fe-page-title"><SaveErrorField names={["pageTitle","options.pageTitle","page_title","options.page_title"]}><TextField id="fe-page-title" value={options.pageTitle ?? ''} placeholder="回答フォーム" onChange={(e) => onChangeOptions({ pageTitle: e.target.value || null })} /></SaveErrorField></Field></div>
      </Card>

      <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-label="見た目の設定">
        <div className={styles.subBox}>
          <h3 className={styles.subTitle}>色と文字</h3>
          <RadioCardGroup legend="見た目の使い方" className={styles.designModes}>
            <RadioCard name="form-design-mode" value="account" checked={mode === 'account'} onChange={() => onChangeOptions({customerDesign:{mode:'account',preset:'line'}})} icon={<Store size={props.portable ? 16 : 14} />} title={props.portable?'配った先の店のデザインに合わせる（おすすめ）':'店の設定に合わせる'} note={props.portable?'店ごとに決めたデザインで出ます':`今：${accountLabel}`} />
            <RadioCard name="form-design-mode" value="fixed" checked={mode === 'fixed'} onChange={() => onChangeOptions({customerDesign:{mode:'fixed',preset:options.theme?'custom':'line'}})} icon={<Palette size={props.portable ? 16 : 14} />} title={props.portable?'色を決めて配る（型かカスタム）':'このフォームだけ変更する'} note={props.portable?'どの店でも同じ色で出ます':'型かカスタムを選ぶ'} />
          </RadioCardGroup>
          {!props.portable ? <span><TextLink external href="/settings/customer-look">店のデザイン設定へ</TextLink></span> : mode === 'fixed' ? <Notice tone="info" compact>このフォームは色を固定して配ります。配った先の店のデザインは使いません。</Notice> : null}
          {props.accountLookError && !props.portable ? <FieldError id="account-look-error">{props.accountLookError}</FieldError> : null}
          {mode === 'fixed' ? <><p className={styles.fieldLabelPlain}>デザインの型</p><CustomerDesignPicker value={preset} onChange={next => onChangeOptions({customerDesign:{mode:'fixed',preset:next}})} /></> : null}
          {mode === 'fixed' && preset === 'custom' ? <>
          <p className={styles.fieldLabelPlain} title="文字と背景の色の差は4.5:1以上にしてください。">色（5つの役割）</p>
          <div id="fe-colors" className={styles.wells}>
            {COLOR_ROLES.map((role) => (
              <span key={role.key} className={styles.well}>
                <ColorWell value={theme[role.key]} allowAlpha={false} allowClear={false} retainInvalidInput label={`${role.label}の色`} onChange={(color) => color && patchTheme({ [role.key]: color.slice(0, 7).toLowerCase() })} />
                <span className={styles.wellLabel}>{role.label}</span>
              </span>
            ))}
          </div>
          {contrastError ? <p role="alert" className={styles.fieldError}>{contrastError}</p> : null}
          <span>
            <Button
              onClick={() => patchTheme({ main: FORM_THEME_DEFAULT.main, sub: FORM_THEME_DEFAULT.sub, accent: FORM_THEME_DEFAULT.accent, error: FORM_THEME_DEFAULT.error, text: FORM_THEME_DEFAULT.text })}
              title="5つの色だけを初期の組合せにします。書体・角の丸み・背景画像は変わりません。"
            >
              <Sparkles size={16} aria-hidden="true" />
              おまかせで組む
            </Button>
          </span>
          <div className={styles.tight}>
            <SaveErrorField names={["fontFamily","theme.fontFamily","font_family","theme.font_family"]}><Select
              aria-label="書体"
              size="full"
              value={theme.fontFamily}
              onChange={(value) => patchTheme({ fontFamily: value as FormFontFamily })}
              options={(Object.keys(FONT_LABEL) as FormFontFamily[]).map((key) => ({ value: key, label: `書体：${FONT_LABEL[key]}` }))}
            /></SaveErrorField>
            <SaveErrorField names={["cornerRadius","theme.cornerRadius","corner_radius","theme.corner_radius"]}><Select
              aria-label="角の丸み"
              size="full"
              value={theme.cornerRadius}
              onChange={(value) => patchTheme({ cornerRadius: value as FormCornerRadius })}
              options={(Object.keys(RADIUS_LABEL) as FormCornerRadius[]).map((key) => ({ value: key, label: `角の丸み：${RADIUS_LABEL[key]}` }))}
            /></SaveErrorField>
          </div></> : null}
        </div>

        {props.portable ? null : <div className={styles.subBox}>
          <h3 className={styles.subTitle}>背景とリンクの見え方</h3>
          <div className={styles.tight}>
            <SaveErrorField names={["backgroundImageUrl","theme.backgroundImageUrl","background_image_url","theme.background_image_url"]}><ImageFrame
              title="背景の画像を追加"
              previewAlt="背景の画像"
              value={theme.backgroundImageUrl || null}
              accept="image/jpeg,image/png,image/gif,image/webp"
              upload={props.accountId ? async (file, progress) => (await uploadToMediaLibrary(file, props.accountId as string, 'image', progress)).url : undefined}
              onChange={patchBackground}
              onMediaPick={() => setPickerFor('background')}
            /></SaveErrorField>
            <button type="button" className={styles.selectLike} onClick={() => setLinkOpen(true)} aria-haspopup="dialog">
              <span>{`リンクの見え方：${linkSummary}`}</span>
              <Link2 size={16} aria-hidden="true" />
            </button>
          </div>
        </div>}

        <div className={styles.cardHeadText}>
          <h2 className={styles.cardTitle}>ボタンの言葉</h2>
        </div>
        <SettingsFormRow layout="columns" columns={3}>
          <Field label="前へ" htmlFor="fe-prev-label"><SaveErrorField names={["prevLabel","options.prevLabel","prev_label","options.prev_label"]}><TextField id="fe-prev-label" aria-label="前へボタンの文字" value={options.prevLabel ?? ''} placeholder="前へ" onChange={(e) => onChangeOptions({ prevLabel: e.target.value })} /></SaveErrorField></Field>
          <Field label="次へ" htmlFor="fe-next-label"><SaveErrorField names={["nextLabel","options.nextLabel","next_label","options.next_label"]}><TextField id="fe-next-label" aria-label="次へボタンの文字" value={options.nextLabel ?? ''} placeholder="次へ" onChange={(e) => onChangeOptions({ nextLabel: e.target.value })} /></SaveErrorField></Field>
          <Field label="送る" htmlFor="fe-submit-label"><SaveErrorField names={["submitLabel","options.submitLabel","submit_label","options.submit_label"]}><TextField id="fe-submit-label" aria-label="送るボタンの文字" value={options.submitLabel ?? ''} placeholder="送信する" onChange={(e) => onChangeOptions({ submitLabel: e.target.value })} /></SaveErrorField></Field>
        </SettingsFormRow>
      </Card>

      <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-labelledby="fe-about-title">
        <div className={styles.cardHeadText}>
          <h2 id="fe-about-title" className={styles.cardTitle}>フォームのこと</h2>
          <p className={styles.cardNote}>名前は一覧と題に出ます。覚え書きはお客さまには出ません。</p>
        </div>
        <FormNameField value={props.name} error={props.nameError} onChange={props.onChangeName} onBlur={props.onBlurName} />
        <div className={styles.field}><Field label="覚え書き" htmlFor="fe-desc"><SaveErrorField names={["description","props.description"]}><TextArea id="fe-desc" rows={2} value={props.description} onChange={(e) => props.onChangeDescription(e.target.value)} /></SaveErrorField></Field></div>
      </Card>

      {/* 3欄は親のフォームへ即時反映済み。窓を閉じても入力を捨てない。 */}
      <Dialog open={linkOpen} dirty={false} title="リンクの見え方" description="LINEやSNSにこのフォームのURLを貼ったときに出るカードです。空のままなら自動で作ります。" confirmLabel="閉じる" onConfirm={() => setLinkOpen(false)} onCancel={() => setLinkOpen(false)}>
        <div className={styles.dialogFields}>
          <div className={styles.field}><Field label="カードの見出し" htmlFor="fe-og-title"><SaveErrorField names={["ogTitle","props.ogTitle","og_title","props.og_title"]}><TextField id="fe-og-title" maxLength={80} value={props.ogTitle} onChange={(e) => props.onChangeOgTitle(e.target.value)} /></SaveErrorField></Field></div>
          <div className={styles.field}><Field label="カードの説明" htmlFor="fe-og-desc"><SaveErrorField names={["ogDescription","props.ogDescription","og_description","props.og_description"]}><TextArea id="fe-og-desc" rows={3} maxLength={200} value={props.ogDescription} onChange={(e) => props.onChangeOgDescription(e.target.value)} /></SaveErrorField></Field></div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>カードの画像</span>
            <SaveErrorField names={["ogImageUrl","props.ogImageUrl","og_image_url","props.og_image_url"]}><ImageFrame
              title="カードの画像を追加"
              previewAlt="カードの画像"
              value={props.ogImageUrl || null}
              accept="image/jpeg,image/png"
              error={ogImageError || undefined}
              upload={props.accountId ? async (file, progress) => (await uploadToMediaLibrary(file, props.accountId as string, 'image', progress)).url : undefined}
              onChange={(url) => props.onChangeOgImageUrl(url ?? '')}
              onMediaPick={() => setPickerFor('ogImage')}
              urlEntry={{ id: 'fe-og-image', value: props.ogImageUrl, onChange: props.onChangeOgImageUrl, label: 'カードの画像URL', placeholder: 'https://', open: Boolean(ogImageError) }}
            /></SaveErrorField>
          </div>
        </div>
        <div className={styles.tight}>
          <Button onClick={() => {
            const initial = initialAppearance.current
            onChangeOptions({ theme: { ...initial.theme } })
            props.onChangeOgTitle(initial.ogTitle)
            props.onChangeOgDescription(initial.ogDescription)
            props.onChangeOgImageUrl(initial.ogImageUrl)
          }}>元に戻す</Button>
          <Button onClick={() => onChangeOptions({ theme: { ...FORM_THEME_DEFAULT } })} title="色・書体・角の丸み・背景を初期設定に戻します">初期設定に戻す</Button>
        </div>
      </Dialog>

      <MediaPickerDialog
        open={pickerFor !== null}
        accountId={props.accountId}
        kind="image"
        onClose={() => setPickerFor(null)}
        onSelect={(item) => {
          // 配信用の公開URLを保存値へ入れる（管理画面の表示用URLではない）。
          if (pickerFor === 'background') patchBackground(item.url)
          else if (pickerFor === 'ogImage') props.onChangeOgImageUrl(item.url)
          setPickerFor(null)
        }}
      />
    </>
  )
}
