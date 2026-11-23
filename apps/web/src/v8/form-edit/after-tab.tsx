'use client'


import Card from '@/components/shared/card'
import { useState } from 'react'
import { FileText, IdCard, MessageSquare, Bell, Tag, Workflow } from 'lucide-react'
import type { FormAction, FormOptions } from '@line-crm/shared'
import ActionEditor from '@/components/forms/action-editor'
import type { FormRefs } from '@/components/forms/form-refs'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import { TextField } from '@/components/shared/text-field'
import { RowActions } from '@/components/shared/row-actions'
import ReorderHandle, { useReorder } from '@/components/shared/reorder-handle'
import Segmented from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import { ACTION_ADDERS, describeAfterAction, emptyAction } from './model'
import styles from './edit.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'

/*
 * 「答え終わったあと」のタブ。お礼の画面と、答え終わったら行うこと。
 * 行うことは上から順に動く。行の「…」で直す・並べ替える・消す。
 */

type Props = {
  readOnly?: boolean
  options: FormOptions
  refs: FormRefs
  onSubmitTagId: string
  onChangeOptions: (next: Partial<FormOptions>) => void
  onChangeSubmitTag: (id: string) => void
}

export function AfterTab({ readOnly, options, refs, onSubmitTagId, onChangeOptions, onChangeSubmitTag }: Props) {
  const actions: FormAction[] = [
    ...( options.afterActions ?? []),
    ...(onSubmitTagId ? [{ kind: 'tag' as const, op: 'add' as const, tagIds: [onSubmitTagId] }] :[]),
  ]
  /** URLを開く：thanksUrl がある間。消すとお礼を出すに戻る（URL は欄の中だけに残す）。 */
  const [urlDraft, setUrlDraft] = useState(options.thanksUrl ?? '')
  const ending = options.thanksUrl ? 'url' : 'thanks'

  const setActions = (next: FormAction[]) => { onChangeOptions({ afterActions: next })
    if(onSubmitTagId) onChangeSubmitTag('') }

  if (readOnly) return <>
    <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)">
      <h2 className={styles.cardTitle}>答え終わったときの画面</h2>
      <p className="text-body">お礼の文：{options.thanksText || 'ご回答ありがとうございました。'}</p>
      <p className="text-body">終わったあと：{options.thanksUrl || 'お礼を出す'}</p>
    </Card>
    <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)">
      <h2 className={styles.cardTitle}>答え終わったら行うこと</h2> <ActionEditor value={actions} refs={refs} onChange={setActions} readOnly/>
    </Card>
  </>

  return (
    <>
      <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-labelledby="fe-thanks-title">
        <h2 id="fe-thanks-title" className={styles.cardTitle}>答え終わったときの画面</h2>
        <div className={styles.field}><Field label="お礼の文" htmlFor="fe-thanks-text"><SaveErrorField names={["thanksText","options.thanksText","thanks_text","options.thanks_text"]}><TextField id="fe-thanks-text" value={options.thanksText ?? ''} placeholder="ご回答ありがとうございました。" onChange={(e) => onChangeOptions({ thanksText: e.target.value })} /></SaveErrorField></Field></div>
        <div className={styles.endingRow}>
          <span className={styles.endingLabel}>終わったあと</span>
          <Segmented
            aria-label="答え終わったあと"
            value={ending}
            onChange={(value) => onChangeOptions({ thanksUrl: value === 'url' ? (urlDraft.trim() || 'https://') : null })}
            options={[
              { value: 'thanks', label: 'お礼を出す' },
              { value: 'url', label: 'URLを開く' },
            ]}
          />
        </div>
        {ending === 'url' ? (
          <div className={styles.field}><Field label="開くURL" htmlFor="fe-thanks-url"><SaveErrorField names={["thanksUrl","options.thanksUrl","urlDraft","thanks_url","options.thanks_url","url_draft"]}><TextField
              id="fe-thanks-url"
              type="url"
              value={options.thanksUrl ?? ''}
              placeholder="https://..."
              onChange={(e) => {
                setUrlDraft(e.target.value)
                onChangeOptions({ thanksUrl: e.target.value || 'https://' })
              }}
            /></SaveErrorField></Field></div>
        ) : null}
      </Card>

      <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-labelledby="fe-actions-title">
        <div className={styles.cardHeadText}>
          <h2 id="fe-actions-title" className={styles.cardTitle}>答え終わったら行うこと</h2>
          <p className={styles.cardNote}>上から順に行います。行を押すと中身を変えられます</p>
        </div> <ActionEditor value={actions} refs={refs} onChange={setActions} />
      </Card>
    </>
  )
}
