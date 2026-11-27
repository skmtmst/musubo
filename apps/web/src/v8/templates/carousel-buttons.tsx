'use client'

import { Fragment, useState } from 'react'
import { Zap } from 'lucide-react'
import { CardHeader } from '@/components/shared/card'
import { Field, FieldError } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import Button from '@/components/shared/button'
import { EntityPickerSummary } from '@/components/shared/entity-picker'
import InlineSettings from '@/components/shared/inline-settings'
import TapActionField, { type TapActionExtraKind } from '@/components/shared/tap-action-field'
import { type TapActionSources } from '../../components/shared/tap-action-source-types'
import InlineActionList, { type useActionOptions } from '@/components/auto-replies/inline-action-list'
import type { useFormErrors } from '@/lib/use-form-errors'
import { isTapActionKind } from '@/lib/tap-actions'
import { MESSAGE_TEXT_MAX, type Panel, type ChoiceKind } from './carousel-core'
import { inlineActionsText } from './carousel-button-options'

export default function CarouselButtons({ actions, selectedIndex, fields, hqHost, host, folderAccountId, liffId, sources, actionOptions, onChange, kindOptions, extraKinds }: {
  kindOptions: (current: ChoiceKind) => ChoiceKind[]
  extraKinds: readonly TapActionExtraKind[]
  actions: Panel['actions']
  selectedIndex: number
  fields: ReturnType<typeof useFormErrors>
  hqHost: boolean
  host: boolean
  folderAccountId: string | null
  liffId: string | null
  sources: TapActionSources
  actionOptions: ReturnType<typeof useActionOptions>
  onChange: (actions: Panel['actions']) => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  return <>{actions.map((action, ai) => {
    const setAction = (patch: Partial<typeof action>) => onChange(actions.map((item, index) => index === ai ? { ...item, ...patch } : item))
    const label = <Field label="ボタンの文字"><SaveErrorField names={[`actions.${ai}.label`, 'label', 'action.label']}>
      <TextField value={action.label} placeholder="ボタンの文字" aria-label={`カード${selectedIndex + 1}のボタン${ai + 1}の文字`} onChange={event => setAction({ label: event.target.value })} />
    </SaveErrorField></Field>
    const editActions = () => <InlineActionList actions={action.actions} {...actionOptions} onChange={next => setAction({ actions: next })} />
    const tap = <Field label={host ? '押したら・中身' : undefined}><SaveErrorField names={['action']}><TapActionField
      name={`カード${selectedIndex + 1}のボタン${ai + 1}`} kindLabel={`カード${selectedIndex + 1}のボタン${ai + 1}の動き`}
      labelControl={host ? undefined : label}
      allowExtras accountId={hqHost ? null : folderAccountId} extrasError={fields.error(`card-${selectedIndex}-button-${ai}`)}
      value={{ kind: action.kind, uri: action.uri, text: action.text, refId: action.formId, tapExtras: action.tapExtras }}
      onChange={patch => setAction({
        ...(patch.kind !== undefined ? { kind: patch.kind as ChoiceKind } : {}),
        ...(patch.uri !== undefined ? { uri: patch.uri } : {}),
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.refId !== undefined ? { formId: patch.refId } : {}),
        ...(patch.tapExtras !== undefined ? { tapExtras: patch.tapExtras } : {}),
      })}
      kinds={kindOptions(action.kind).filter(isTapActionKind)} extraKinds={extraKinds}
      renderBody={kind => kind !== 'action' ? undefined : host ? editActions() : <EntityPickerSummary label="動き" noun="処理" icon={Zap}
        name={inlineActionsText(action.actions, actionOptions.tags)} ariaLabel={`カード${selectedIndex + 1}のボタン${ai + 1}の動きを変更する`} onOpen={() => setEditing(editing === ai ? null : ai)} />}
      scope={hqHost ? 'hq' : 'shop'} hasLiff={Boolean(liffId)}
      liffSettingsHref={folderAccountId ? `/accounts/detail?id=${encodeURIComponent(folderAccountId)}` : '/accounts'} sources={sources}
      textMax={MESSAGE_TEXT_MAX}
    /></SaveErrorField></Field>
    return <Fragment key={ai}>
      <CardHeader size="stacked" headingLevel={3} title={`ボタン ${ai + 1}`} />
      <div {...fields.bind(`card-${selectedIndex}-button-${ai}`)} aria-describedby={fields.invalid(`card-${selectedIndex}-button-${ai}`) ? `cr-button-${ai}-error` : undefined}>
        {host ? <SettingsFormRow layout="columns">{label}{tap}</SettingsFormRow> : tap}
      </div>
      <FieldError id={`cr-button-${ai}-error`}>{fields.error(`card-${selectedIndex}-button-${ai}`)}</FieldError>
      {actions.length > 1 ? <div><Button variant="text" textTone="danger" aria-label={`カード${selectedIndex + 1}のボタン${ai + 1}を外す`} onClick={() => { setEditing(null); onChange(actions.filter((_, index) => index !== ai)) }}>このボタンを消す</Button></div> : null}
      {host ? null : <InlineSettings flow="column" open={editing === ai && action.kind === 'action'} title={`ボタン${ai + 1}の動き`} onClose={() => setEditing(null)}>{editing === ai && action.kind === 'action' ? editActions() : null}</InlineSettings>}
    </Fragment>
  })}</>
}
