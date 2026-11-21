'use client'

import { useState, type ReactNode } from 'react'
import OgEditor from '@/components/shared/og-editor'
import { TextField as SharedTextField } from '@/components/shared/text-field'

// Shared form field building blocks for the LINE account create / edit flows.
// Kept as primitives (not a full form) so the create page (single submit) and
// the edit modal (partial PATCH) can share field rendering without forcing the
// same submit semantics.

export interface AccountFormState {
  name: string
  channelId: string
  channelSecret: string
  loginChannelId: string
  loginChannelSecret: string
  liffId: string
  // OGP brand settings (optional — only present/sent when the user edits them)
  ogSiteName: string | null
  ogDefaultDescription: string | null
  ogDefaultImageUrl: string | null
}

export const emptyAccountFormState: AccountFormState = {
  name: '',
  channelId: '',
  channelSecret: '',
  loginChannelId: '',
  loginChannelSecret: '',
  liffId: '',
  ogSiteName: null,
  ogDefaultDescription: null,
  ogDefaultImageUrl: null,
}

// Section: collapsible group of fields. Future "Provider" / "Rich Menu Default"
// sections can be added without touching the page layout, just by rendering
// another <FormSection>.
export function FormSection({
  title,
  description,
  defaultOpen = true,
  children,
}: {
  title: string
  description?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-hairline rounded-control overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-pearl hover:bg-shell text-left"
      >
        <div className="min-w-0 pr-3">
          <p className="text-sm font-semibold text-ink">{title}</p>
          {description && <p className="text-xs text-ink-faint mt-0.5">{description}</p>}
        </div>
        <span className="shrink-0 text-xs text-ink-faint">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="p-4 space-y-3 bg-canvas">{children}</div>}
    </div>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = 'text',
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
  type?: 'text' | 'password'
  hint?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink-secondary mb-1">
        {label}
        {required && <span className="text-status-danger ml-1">*</span>}
      </label>
      <SharedTextField
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full border border-hairline rounded-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
      />
      {hint && <p className="text-micro text-ink-faint mt-1">{hint}</p>}
    </div>
  )
}

// Renders the three sections used by both create and edit. Caller provides
// state + setter; this component is presentation-only.
export function AccountFormSections({
  state,
  update,
  showMessagingRequired,
  channelIdEditable = true,
  defaultOpen,
}: {
  state: AccountFormState
  update: (partial: Partial<AccountFormState>) => void
  // create form: messaging fields are required (new account needs them).
  // edit modal: not required (user may only be editing Login/LIFF; passing
  // empty messaging fields means "leave unchanged").
  showMessagingRequired: boolean
  // Channel ID is the immutable identifier of a Messaging API channel on
  // LINE's side — it's never re-issued for the same official account, and
  // the worker has no UPDATE path for `channel_id`. Render it read-only on
  // edit so users don't think they can fix a typo here (they'd need to
  // delete + recreate the row to change Channel ID).
  channelIdEditable?: boolean
  defaultOpen?: { messaging?: boolean; login?: boolean; liff?: boolean; ogp?: boolean }
}) {
  return (
    <div className="space-y-3">
      <FormSection
        title="Messaging API"
        description="LINE 公式アカウント本体の送信用設定（必須）"
        defaultOpen={defaultOpen?.messaging ?? true}
      >
        {channelIdEditable ? (
          <TextField
            label="Channel ID"
            value={state.channelId}
            onChange={(v) => update({ channelId: v })}
            placeholder="123456789"
            required={showMessagingRequired}
          />
        ) : (
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1">Channel ID</label>
            <SharedTextField
              value={state.channelId}
              readOnly
              disabled
              className="w-full border border-hairline rounded-control px-3 py-2 text-sm font-mono bg-surface-pearl text-ink-faint cursor-not-allowed"
            />
            <p className="text-micro text-ink-faint mt-1">
              Channel ID は変更できません（LINE 側で固定の識別子）
            </p>
          </div>
        )}
        <TextField
          label="Channel Secret"
          value={state.channelSecret}
          onChange={(v) => update({ channelSecret: v })}
          required={showMessagingRequired}
          type="password"
          hint={showMessagingRequired ? undefined : '設定済み（変更する場合のみ入力）'}
        />
        <p className="text-xs text-ink-muted">チャネルアクセストークンはmusuboが自動更新します。</p>
      </FormSection>

      <FormSection
        title="LINE Login（任意）"
        description="友だち追加 OAuth 導線で使う。後から追加可"
        defaultOpen={defaultOpen?.login ?? false}
      >
        <TextField
          label="Login Channel ID"
          value={state.loginChannelId}
          onChange={(v) => update({ loginChannelId: v })}
          placeholder="2009624792"
          hint="LINE Developers > Login channel > Channel ID"
        />
        <TextField
          label="Login Channel Secret"
          value={state.loginChannelSecret}
          onChange={(v) => update({ loginChannelSecret: v })}
          type="password"
          hint={showMessagingRequired ? undefined : '保存済みの値は表示しません。変更する場合のみ入力'}
        />
      </FormSection>

      <FormSection
        title="LIFF（任意）"
        description="LIFF page を開くときの ?liffId= で識別。後から追加可"
        defaultOpen={defaultOpen?.liff ?? false}
      >
        <TextField
          label="LIFF ID"
          value={state.liffId}
          onChange={(v) => update({ liffId: v })}
          placeholder="2009624792-XXXXXXXX"
          hint="LINE Developers > Login channel > LIFF タブで作成したものの ID"
        />
      </FormSection>

      <FormSection
        title="ブランド設定（OGP）"
        description="LINE / X / Facebook のリンクプレビューに使うブランド情報"
        defaultOpen={defaultOpen?.ogp ?? false}
      >
        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-1">
            サイト名（og:site_name）
          </label>
          <SharedTextField
            type="text"
            value={state.ogSiteName ?? ''}
            placeholder={`空欄なら「${state.name || 'アカウント名'}」がフォールバック`}
            onChange={(e) => update({ ogSiteName: e.target.value || null })}
            className="w-full border border-hairline rounded-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <p className="text-micro text-ink-faint mt-1">
            リンクプレビューでブランド名として表示されます。
          </p>
        </div>
        <OgEditor
          hideTitle
          value={{
            ogTitle: null,
            ogDescription: state.ogDefaultDescription,
            ogImageUrl: state.ogDefaultImageUrl,
          }}
          onChange={(v) =>
            update({
              ogDefaultDescription: v.ogDescription,
              ogDefaultImageUrl: v.ogImageUrl,
            })
          }
        />
      </FormSection>
    </div>
  )
}
