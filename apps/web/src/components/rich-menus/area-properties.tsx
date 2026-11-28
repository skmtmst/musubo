'use client'

import { INTENT_OPTIONS } from './area-intent-options'
import TagPickerField from '@/components/shared/tag-picker-field'
import { useId, useState } from 'react'
import { ArrowLeftRight, CalendarClock, Copy, Phone, Send, Utensils, Zap } from 'lucide-react'
import MultiSelect from '@/components/shared/multi-select'
import Select from '@/components/shared/select'
import TapActionField, { type TapActionExtraKind } from '@/components/shared/tap-action-field'
import { tapLiffIdOf, useTapActionAccount, useTapActionSources } from '@/components/shared/use-tap-action-sources'
import { HQ_RICH_MENU_INTENTS } from '@/lib/hq-rich-menu-create'
import {
  RESTAURANT_MENU_ACTION, RESTAURANT_RICH_MENU_TAP_ORDER,
  tapActionDef, tapActionFromSavedUri, tapActionFromUri, tapActionLiffUrl, tapActionNeedsLiff,
  type TapActionKind, type TapActionValue,
} from '@/lib/tap-actions'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { FieldError } from '@/components/shared/form-controls'
import type { Area } from './area-types'
import { RICH_MENU_ACTION_TYPE_BY_INTENT, restaurantMenuLiffToken, richMenuUriError, type RichMenuAreaIntent } from '@line-crm/shared'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import TapSideEffects from '@/components/shared/tap-side-effects'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { TextField as SharedTextField } from '@/components/shared/text-field'
import { useAccountStyle } from '@/hooks/use-account-style'
import RestaurantMenuAction, { RESTAURANT_MENU_DRAFT_URL } from './restaurant-menu-action'

type Option = { id: string; name: string; folderId?: string | null; updatedAt?: string | null }

type Props = {
  area: Area
  /** 同じメニュー内の他ページ。「メニューを切り替える」の行き先。 */
  pages: Option[]
  tags: Option[]
  templates: Option[]
  forms: Option[]
  trackedLinks: Option[]
  /** このボタンが今月押された回数。数えられない種類なら null。 */
  taps: { count: number; viaTrackedLink: number } | null
  onUpdate: (patch: Partial<Area>) => void
  onDelete?: () => void
  /** 保存で落ちた、この面の動きの理由。欄の真下に出し、欄を赤くする。 */
  error?: string | null
  /** 新規作成では座標・実績・削除を隠し、動きの設定だけを使う。 */
  showManagementDetails?: boolean
  allowedIntents?: RichMenuAreaIntent[]
  /**
   * 店か統括のひな形か。統括は予約・予約履歴・来店スタンプを出さない（配った先の LIFF に付け替える口がまだ無い）。
   * 渡さないときは allowedIntents が統括の組（HQ_RICH_MENU_INTENTS）なら統括とみなす。
   */
  scope?: 'shop' | 'hq'
  /** 予約・予約履歴・来店スタンプの URL に入れる LIFF ID。渡さないときは上のバーのアカウントのもの。 */
  liffId?: string | null
  /** 閲覧のみ（押したらの欄を文字で見せる）。 */
  readOnly?: boolean
}

/**
 * 押された回数を数えられる種類か。
 *
 * URLを開く（計測リンクなし）・電話・回答フォームは、LINE の中や外で完結して
 * しまい、押されたことがこちらに届かない。数えられないものを「0回」と出すと
 * 「誰も押していない」と読めてしまうので、種類で分けて扱う。
 */
export function isTapCountable(area: Area): boolean {
  const intent = intentOf(area)
  if (intent === 'url') return Boolean(area.trackedLinkId)
  // 日時を選ぶボタンは postback で届くので数えられる。コピーは端末の中で
  // 完結し、押されたことがこちらに届かない。
  if (intent === 'datetime') return true
  if (intent === 'clipboard') return false
  return intent !== 'tel' && intent !== 'form'
}

/** intent から、LINE に登録するときの種類を決める。 */
export function actionTypeForIntent(intent: RichMenuAreaIntent): Area['actionType'] {
  return RICH_MENU_ACTION_TYPE_BY_INTENT[intent]
}

/** ボタンの動きを人間の言葉で返す。キャンバスのエリア一覧でも使う。 */
export function intentLabelOf(area: Area): string {
  const kind = tapKindOf(area)
  if (kind === RESTAURANT_MENU_ACTION.kind) return RESTAURANT_MENU_ACTION.label
  return tapActionDef(kind)?.label ?? INTENT_OPTIONS.find((o) => o.value === intentOf(area))?.label ?? 'ボタン'
}

/*
 * 「押したら」の共通の欄（TapActionField・YPzmo）とリッチメニューの intent の行き来。
 * URLを開く＝url・テキストを送る＝text・回答フォーム＝form（保存は今のまま formId）。
 * 予約・予約履歴・来店スタンプは url の intent に LIFF の URL を入れて保存する（読み戻しは URL から）。
 * それ以外の intent（テンプレートを送る・電話・切り替え・postback・日時・コピー）は今のまま残す。
 */
const URL_LIFF_KINDS: readonly TapActionKind[] = ['booking', 'booking_history', 'visit_stamp']
const INTENT_ICONS: Partial<Record<RichMenuAreaIntent, TapActionExtraKind['icon']>> = {
  template: Send, tel: Phone, switch: ArrowLeftRight, postback: Zap, datetime: CalendarClock, clipboard: Copy,
}

export function tapKindOf(area: Area): string {
  const intent = intentOf(area)
  if (intent === 'url') {
    const uri = String((area.actionData as Record<string, unknown> | undefined)?.uri ?? '')
    if (!area.trackedLinkId && (uri === RESTAURANT_MENU_DRAFT_URL || restaurantMenuLiffToken(uri))) return RESTAURANT_MENU_ACTION.kind
    const parsed = tapActionFromUri(uri)
    return URL_LIFF_KINDS.includes(parsed.kind) ? parsed.kind : 'uri'
  }
  if (intent === 'text') return 'message'
  return intent
}

function tapValueOf(area: Area, hasRestaurantMenu: boolean): TapActionValue {
  const data = (area.actionData ?? {}) as Record<string, unknown>
  const kind = tapKindOf(area)
  const uri = String(data.uri ?? '')
  if (!hasRestaurantMenu && kind === RESTAURANT_MENU_ACTION.kind) return tapActionFromSavedUri(uri)
  if (URL_LIFF_KINDS.includes(kind as TapActionKind)) return { kind, uri: '', text: '', refId: tapActionFromUri(uri).refId }
  return { kind, uri, text: String(data.text ?? ''), refId: kind === 'form' ? area.formId ?? '' : '' }
}

/** LIFF ID がまだ無いときの仮の URL（公開の前に isAreaActionConfigured が止める）。 */
export const LIFF_PLACEHOLDER = '{{liff_id}}'

/** 種類を変えたときの、入力欄の初期値。 */
function defaultActionData(intent: RichMenuAreaIntent): Record<string, unknown> {
  switch (intent) {
    case 'url':
      return { uri: '' }
    case 'tel':
      return { tel: '' }
    case 'text':
      return { text: '' }
    case 'form':
      return {}
    case 'template':
      return {}
    case 'switch':
      return { targetPageId: '' }
    case 'postback':
      return { data: '', displayText: '' }
    case 'datetime':
      return { mode: 'datetime', initial: '', max: '', min: '' }
    case 'clipboard':
      return { text: '' }
    case 'booking':
    case 'booking_history':
    case 'visit_stamp':
      return { uri: '' }
  }
}

/** 昔つくったボタン（intent なし）を、いまの言い方に読み替える。 */
export function intentOf(area: Area): RichMenuAreaIntent {
  if (area.intent) return area.intent
  switch (area.actionType) {
    case 'uri':
      return 'url'
    case 'message':
      return 'text'
    case 'richmenuswitch':
      return 'switch'
    case 'postback':
      return 'postback'
    case 'datetimepicker':
      return 'datetime'
    case 'clipboard':
      return 'clipboard'
  }
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="text-ink-secondary text-xs font-medium">{label}</span>
      {hint && <span className="text-ink-faint block text-micro">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  )
}

const inputClass =
  'border-hairline rounded-control focus:ring-accent block w-full border px-2 py-1 text-sm focus:ring-2 focus:outline-none'

function NumField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="text-ink-faint text-xs">{label}</span>
      <SaveErrorField names={["value"]}><SharedTextField
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className={`mt-0.5 ${inputClass}`}
      /></SaveErrorField>
    </label>
  )
}

export function AreaProperties({
  area,
  pages,
  tags,
  templates,
  forms,
  trackedLinks,
  taps,
  onUpdate,
  onDelete,
  showManagementDetails = true,
  allowedIntents,
  scope,
  liffId: liffIdProp,
  readOnly = false,
  error = null,
}: Props) {
  const inputId = useId()
  const data = (area.actionData ?? {}) as Record<string, unknown>
  const intent = intentOf(area)

  const selectedTagIds = area.tagIds ?? []
  const intentOptions = allowedIntents
    ? INTENT_OPTIONS.filter((option) => allowedIntents.includes(option.value))
    : INTENT_OPTIONS
  const allowed = (value: RichMenuAreaIntent) => intentOptions.some((option) => option.value === value)
  const isHq = scope
    ? scope === 'hq'
    : Boolean(allowedIntents) && allowedIntents!.length === HQ_RICH_MENU_INTENTS.length && HQ_RICH_MENU_INTENTS.every((value) => allowedIntents!.includes(value))
  const account = useTapActionAccount()
  const accountId = isHq ? null : account?.selectedAccountId ?? null
  const liffId = isHq ? null : liffIdProp !== undefined ? liffIdProp : tapLiffIdOf(account)
  const style = useAccountStyle(accountId)
  const hasRestaurantMenu = Boolean(accountId && allowed('url') && (style.data?.style === 'restaurant' || tapKindOf(area) === RESTAURANT_MENU_ACTION.kind))
  const menuScope = JSON.stringify([accountId, area.id])
  const [provisionedChoice, setProvisionedChoice] = useState<string | null>(null)
  const shopSources = useTapActionSources(isHq ? null : account?.selectedAccountId, { booking: true, visit_stamp: true })
  /* 6つのうち使えるもの（並びは絵の順）。予約・予約履歴・来店スタンプは url の intent で保存するので url が要る。 */
  const tapKinds: TapActionKind[] = [
    ...(allowed('url') ? ['uri' as const] : []),
    ...(allowed('text') ? ['message' as const] : []),
    ...(allowed('url') ? ['booking' as const] : []),
    ...(allowed('form') ? ['form' as const] : []),
    ...(allowed('url') ? ['booking_history' as const, 'visit_stamp' as const] : []),
  ]
  /* リッチメニューだけの種類（テンプレートを送る・タブ切り替え・電話・postback・日時・コピー）は今のまま残す。 */
  const extraKinds: TapActionExtraKind[] = intentOptions
    .filter((option) => !['url', 'text', 'form'].includes(option.value))
    .map((option) => ({ value: option.value, label: option.label, description: option.hint, icon: INTENT_ICONS[option.value] ?? Zap }))
  if (hasRestaurantMenu) extraKinds.push({
    value: RESTAURANT_MENU_ACTION.kind, label: RESTAURANT_MENU_ACTION.label, description: RESTAURANT_MENU_ACTION.description, icon: Utensils,
  })
  const extraIntentOf = (kind: string) => extraKinds.some((extra) => extra.value === kind)

  const tapValue = tapValueOf(area, hasRestaurantMenu)
  function changeTap(patch: Partial<TapActionValue>) {
    const nextKind = patch.kind ?? tapValue.kind
    if (patch.kind !== undefined && patch.kind !== tapValue.kind) {
      setProvisionedChoice(nextKind === RESTAURANT_MENU_ACTION.kind ? menuScope : null)
      if (nextKind === RESTAURANT_MENU_ACTION.kind) return onUpdate({
        intent: 'url',
        actionType: actionTypeForIntent('url'),
        actionData: { uri: RESTAURANT_MENU_DRAFT_URL },
        templateId: null,
        formId: null,
        trackedLinkId: null,
      })
      if (nextKind === 'uri') return changeIntent('url')
      if (nextKind === 'message') return changeIntent('text')
      if (nextKind === 'form') return changeIntent('form')
      if (tapActionNeedsLiff(nextKind)) {
        return onUpdate({
          intent: 'url',
          actionType: actionTypeForIntent('url'),
          actionData: { uri: tapActionLiffUrl(liffId || LIFF_PLACEHOLDER, nextKind, '') },
          templateId: null,
          formId: null,
          trackedLinkId: null,
        })
      }
      return changeIntent(nextKind as RichMenuAreaIntent)
    }
    if (nextKind === 'uri' && patch.uri !== undefined) return onUpdate({ actionData: { ...data, uri: patch.uri } })
    if (nextKind === 'message' && patch.text !== undefined) return onUpdate({ actionData: { ...data, text: patch.text } })
    if (nextKind === 'form' && patch.refId !== undefined) return onUpdate({ formId: patch.refId || null })
    if (tapActionNeedsLiff(nextKind) && patch.refId !== undefined) {
      return onUpdate({ actionData: { ...data, uri: tapActionLiffUrl(liffId || LIFF_PLACEHOLDER, nextKind, patch.refId) } })
    }
  }

  /* URLを開く：計測リンクを選べる（選ぶと飛び先は計測リンクの設定）。 */
  const urlBody = (
    <>
      <SaveErrorField names={["trackedLinkId","area.trackedLinkId","tracked_link_id","area.tracked_link_id"]}><EntitySelect
        value={area.trackedLinkId ?? ''}
        onChange={(value) => onUpdate({ trackedLinkId: value || null })}
        aria-label="計測リンクを使う"
        disabled={readOnly}
        options={[
          { value: '', label: '計測リンクを使わない（下のURLをそのまま開く）' },
          ...trackedLinks.map((l) => ({ ...entityOptionMetadata(l), value: l.id, label: l.name })),
        ]}
        size="full"
      /></SaveErrorField>
      {area.trackedLinkId ? (
        // 計測リンクを選んだら、飛び先はそちらの設定が使われる。
        // URL 欄を残すと「どっちが使われるのか」が分からなくなる。
        <p className="text-ink-faint text-micro">
          飛び先は、選んだ計測リンクの設定が使われます。変えるときは「計測リンク」の画面で編集してください。
        </p>
      ) : (
        <>
          <SaveErrorField names={["uri","data.uri"]}><SharedTextField
            id={`${inputId}-url`}
            type="url"
            aria-label="URL"
            value={(data.uri as string) ?? ''}
            readOnly={readOnly}
            onChange={(e) => onUpdate({ actionData: { ...data, uri: e.target.value } })}
            placeholder="https://..."
            aria-invalid={Boolean(String(data.uri ?? '').trim()) && richMenuUriError(String(data.uri ?? '')) !== null}
            className={inputClass}
          /></SaveErrorField>
          {/* R203: URLでない文字列はその場で理由を出す。空欄は「未設定」側の表示が担う。 */}
          {String(data.uri ?? '').trim() && richMenuUriError(String(data.uri ?? '')) ? (
            <p role="alert" className="text-danger text-xs">
              {richMenuUriError(String(data.uri ?? ''))}
            </p>
          ) : null}
        </>
      )}
    </>
  )
  const formEmpty = (
    <p className="text-micro text-status-warn-deep">
      回答フォームがまだありません。先に「回答フォーム」で作ってください。
    </p>
  )

  function changeIntent(next: RichMenuAreaIntent) {
    onUpdate({
      intent: next,
      actionType: actionTypeForIntent(next),
      actionData: defaultActionData(next),
      // 種類が変わると使わなくなる設定は消す。残すと保存時に紛れ込む。
      templateId: next === 'template' ? area.templateId : null,
      formId: next === 'form' ? area.formId : null,
      trackedLinkId: next === 'url' ? area.trackedLinkId : null,
    })
  }

  // タグ付けとスコアは、押されたことがこちらに届くボタンでしか使えない。
  // URL・電話・フォーム・コピーは LINE の中で完結してしまい、押されたことが分からない。
  // 日時を選ぶボタンは postback で届くので使える。
  const sideEffectsAvailable =
    intent === 'text' || intent === 'template' || intent === 'postback' || intent === 'datetime'

  return (
    <div className="space-y-3 text-sm">
      {/* V8 の作る画面（showManagementDetails=false）は上に「面 A「…」の動き」の題があるので、同じ意味の題を重ねない（cmRZc・rE0ML）。 */}
      {showManagementDetails ? <div className="flex items-center justify-between">
        <h3 className="text-ink-secondary font-semibold">選択中のボタン</h3>
        {onDelete ? (
          <button type="button" onClick={onDelete} className="text-xs text-danger hover:underline">
            削除する
          </button>
        ) : null}
      </div> : null}

      <Field label="ボタン名" htmlFor={`${inputId}-name`} hint="管理用の呼び名。友だちには表示されません。">
        <SaveErrorField names={["label","area.label"]}><SharedTextField
          id={`${inputId}-name`}
          value={area.label ?? ''}
          onChange={(e) => onUpdate({ label: e.target.value })}
          maxLength={60}
          placeholder="例：予約する"
          className={inputClass}
        /></SaveErrorField>
      </Field>

      {showManagementDetails ? (
        <div className="border-hairline bg-canvas-sunken rounded-control border px-3 py-2">
          <div className="text-ink-faint text-micro">今月押された回数</div>
          {isTapCountable(area) ? (
            <>
              <div className="text-ink text-lg font-bold tabular-nums">
                {taps?.count ?? 0}
                <span className="text-ink-faint ml-0.5 text-xs font-medium">回</span>
              </div>
              {taps && taps.viaTrackedLink > 0 && (
                <p className="text-ink-faint text-micro">
                  うち {taps.viaTrackedLink} 回は計測リンクで数えた分です。
                  同じ計測リンクを他でも使っていると、その分も入ります。
                </p>
              )}
            </>
          ) : (
            <p className="text-ink-faint text-micro leading-snug">
              この動きは数えられません。
              {intent === 'url'
                ? '上の「計測リンクを使う」を選ぶと数えられます。'
                : 'LINE の中で完結するため、押されたことがこちらに届きません。'}
            </p>
          )}
        </div>
      ) : null}

      {showManagementDetails ? (
        <div className="grid grid-cols-2 gap-2">
          <NumField label="x" value={area.boundsX} onChange={(v) => onUpdate({ boundsX: v })} />
          <NumField label="y" value={area.boundsY} onChange={(v) => onUpdate({ boundsY: v })} />
          <NumField
            label="幅"
            value={area.boundsWidth}
            onChange={(v) => onUpdate({ boundsWidth: v })}
          />
          <NumField
            label="高さ"
            value={area.boundsHeight}
            onChange={(v) => onUpdate({ boundsHeight: v })}
          />
        </div>
      ) : null}

      <div className="block">
        <span className="text-ink-secondary text-xs font-medium">押したときの動き</span>
        <div className="mt-1">
          <SaveErrorField names={["このボタン","area"]}><TapActionField
            kindPresentation={showManagementDetails ? 'select' : 'grid'}
            layout="stack"
            name="このボタン"
            kindLabel="押したときの動き"
            value={tapValue}
            onChange={changeTap}
            kinds={tapKinds}
            extraKinds={extraKinds}
            kindOrder={hasRestaurantMenu ? RESTAURANT_RICH_MENU_TAP_ORDER : undefined}
            scope={isHq ? 'hq' : 'shop'}
            hasLiff={Boolean(liffId)}
            liffSettingsHref={account?.selectedAccountId ? `/accounts/detail?id=${encodeURIComponent(account.selectedAccountId)}` : '/accounts'}
            readOnly={readOnly}
            sources={{ ...shopSources, form: forms.map((f) => ({ id: f.id, name: f.name, folderId: f.folderId, updatedAt: f.updatedAt })) }}
            textMax={300}
            renderBody={(kind) => {
              if (kind === RESTAURANT_MENU_ACTION.kind && hasRestaurantMenu && accountId) {
                return <RestaurantMenuAction key={JSON.stringify([menuScope, liffId])} accountId={accountId}
                  liffId={liffId} uri={String(data.uri ?? '')} readOnly={readOnly}
                  provisionOnSelect={provisionedChoice === menuScope}
                  onUrl={uri => {
                    setProvisionedChoice(null)
                    onUpdate({ actionData: { ...data, uri } })
                  }} />
              }
              return kind === 'uri' ? urlBody : kind === 'form' && forms.length === 0 ? formEmpty : extraIntentOf(kind) ? null : undefined
            }}
          /></SaveErrorField>
        </div>
        {intent === 'switch' ? null : <FieldError id={`${inputId}-action-error`}>{error}</FieldError>}
      </div>

      {intent === 'tel' && (
        <Field label="電話番号" hint="ハイフンはあってもなくても構いません。">
          <SaveErrorField names={["tel","data.tel"]}><SharedTextField
            type="tel"
            value={(data.tel as string) ?? ''}
            onChange={(e) => onUpdate({ actionData: { ...data, tel: e.target.value } })}
            placeholder="0312345678"
            className={inputClass}
          /></SaveErrorField>
        </Field>
      )}

      {intent === 'template' && (
        <div className="block">
          <span className="text-ink-secondary text-xs font-medium">送るテンプレート</span>
          <span className="text-ink-faint block text-micro">押されたら、こちらからこのメッセージを送ります。</span>
          <div className="mt-1">
            <SaveErrorField names={["templateId","area.templateId"]}><EntityKindField
              kind="template"
              label="送るテンプレート"
              options={templates}
              value={area.templateId ?? ''}
              onChange={(value) => onUpdate({ templateId: value || null })}
              clearable
            /></SaveErrorField>
          </div>
          {templates.length === 0 && (
            <p className="mt-1 text-micro text-status-warn-deep">
              テンプレートがまだありません。先に「テンプレート」で作ってください。
            </p>
          )}
        </div>
      )}

      {intent === 'switch' && (
        <Field label="切り替え先のページ">
          <SaveErrorField names={["targetPageId","data.targetPageId","target_page_id","data.target_page_id"]}><EntitySelect
            value={(data.targetPageId as string) ?? ''}
            onChange={(value) => onUpdate({ actionData: { ...data, targetPageId: value } })}
            aria-label="切り替え先のページ"
            invalid={Boolean(error)}
            options={[
              { value: '', label: '選択…' },
              ...pages.map((p) => ({ ...entityOptionMetadata(p), value: p.id, label: p.name })),
            ]}
            size="full"
          /></SaveErrorField>
          {pages.length < 2 && (
            <p className="mt-1 text-micro text-status-warn-deep">
              タブの切り替えには2ページ以上必要です。先にページを追加してください。
            </p>
          )}
          <FieldError id={`${inputId}-action-error`}>{error}</FieldError>
        </Field>
      )}

      {intent === 'postback' && (
        <>
          <Field label="合図の文字列（postback data）">
            <SaveErrorField names={["data.data"]}><SharedTextField
              value={(data.data as string) ?? ''}
              onChange={(e) => onUpdate({ actionData: { ...data, data: e.target.value } })}
              maxLength={200}
              className={inputClass}
            /></SaveErrorField>
          </Field>
          <Field label="トークに残す文言（任意）">
            <SaveErrorField names={["displayText","data.displayText","display_text","data.display_text"]}><SharedTextField
              value={(data.displayText as string) ?? ''}
              onChange={(e) => onUpdate({ actionData: { ...data, displayText: e.target.value } })}
              maxLength={300}
              className={inputClass}
            /></SaveErrorField>
          </Field>
        </>
      )}

      {intent === 'datetime' && (
        <>
          <Field label="日時の種類" hint="友だちに見せるカレンダーや時計の形を決めます。">
            <SaveErrorField names={["mode","data.mode"]}><Select
              value={(data.mode as string) ?? 'datetime'}
              onChange={(value) => onUpdate({ actionData: { ...data, mode: value } })}
              aria-label="日時の種類"
              options={[
                { value: 'date', label: '日付（2026-10-01）' },
                { value: 'time', label: '時刻（10:00）' },
                { value: 'datetime', label: '日時（2026-10-01 10:00）' },
              ]}
              size="full"
            /></SaveErrorField>
          </Field>
          <Field label="はじめの値（任意）" hint="空欄なら、開いたときの日時が使われます。">
            <SaveErrorField names={["initial","data.initial"]}><SharedTextField
              value={(data.initial as string) ?? ''}
              onChange={(e) => onUpdate({ actionData: { ...data, initial: e.target.value } })}
              placeholder="例：2026-10-01"
              className={inputClass}
            /></SaveErrorField>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="いちばん前（任意）">
              <SaveErrorField names={["min","data.min"]}><SharedTextField
                value={(data.min as string) ?? ''}
                onChange={(e) => onUpdate({ actionData: { ...data, min: e.target.value } })}
                placeholder="例：2026-09-01"
                className={inputClass}
              /></SaveErrorField>
            </Field>
            <Field label="いちばん後（任意）">
              <SaveErrorField names={["max","data.max"]}><SharedTextField
                value={(data.max as string) ?? ''}
                onChange={(e) => onUpdate({ actionData: { ...data, max: e.target.value } })}
                placeholder="例：2026-12-31"
                className={inputClass}
              /></SaveErrorField>
            </Field>
          </div>
        </>
      )}

      {intent === 'clipboard' && (
        <Field label="コピーする文字" hint="押すと、この文字が友だちの端末に写ります。">
          <SaveErrorField names={["text","data.text"]}><SharedTextField
            value={(data.text as string) ?? ''}
            onChange={(e) => onUpdate({ actionData: { ...data, text: e.target.value } })}
            maxLength={1000}
            placeholder="例：合言葉は「さくら」"
            className={inputClass}
          /></SaveErrorField>
        </Field>
      )}

      {/* 押されたときの追加の動き */}
      {tapValue.kind !== RESTAURANT_MENU_ACTION.kind && <div className="border-hairline space-y-3 border-t pt-3">
        <p className="text-ink-secondary text-xs font-medium">押されたときに、あわせて行うこと</p>

        {!sideEffectsAvailable ? (
          <p className="text-ink-faint text-micro">
            {intent === 'url'
              ? 'URLを開くボタンでタグを付けたいときは、上の「計測リンクを使う」を選んでください。計測リンク側でタグを設定できます。'
              : 'この動きは LINE の中で完結するため、押されたことがこちらに届きません。タグ付けやスコアは設定できません。'}
          </p>
        ) : (
          <>
            <TapSideEffects tags={tags} tagIds={selectedTagIds} score={area.scoreChange}
                onChange={
                  onUpdate}
              />

            {intent === 'text' && (area.tagIds?.length || area.scoreChange) ? (
              <p className="text-ink-faint text-micro">
                タグかスコアを設定すると、押されたことを受け取るしくみに切り替わります。
                トークの見え方は変わりません。
              </p>
            ) : null}
          </>
        )}
      </div>}
    </div>
  )
}
