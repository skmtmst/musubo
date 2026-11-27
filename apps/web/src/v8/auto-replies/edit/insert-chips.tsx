'use client'

/*
 * 自動応答の「差し込む」の札（4つ）。見た目は wizard-v8.module.css の札のまま。
 *
 * 札が入れる文字は、送るときに本当に置き換わる形（{{name}}・{{field.x}}・{{var.x}}）だけ。
 * 以前は {name}・{field}・{var}・{booking_at} を入れていて、どれも置き換わらずに
 * そのままお客さまへ届いていた（2026-10-07 の点検）。
 * 友だち情報・共通情報は項目を選ばないと形が決まらないので、押すと一覧が開く。
 * 予約日時は自動応答で差し込める値がまだ無いので、押せない札にして理由を出す。
 */
import { useEffect, useRef, useState } from 'react'
import ActionMenu from '@/components/shared/action-menu'
import Notice from '@/components/shared/notice'
import styles from './insert-chips.module.css'
import { EMPTY_REFERENCES, loadTemplateReferences, type TemplateReferences } from '@/v8/template-edit/public/core/index'
import { MessageInsertButton } from '@/components/shared/message-insert-row'

export const NAME_TOKEN = '{{name}}'

/** 本文に入っている差し込みを、札の名前で返す（右の「設定内容」の箱で使う）。 */
export function insertedLabels(content: string): string[] {
  const labels: string[] = []
  if (content.includes(NAME_TOKEN)) labels.push('名前')
  if (/\{\{field\.[a-z][a-z0-9_]*\}\}/.test(content)) labels.push('友だち情報')
  if (/\{\{\s*var\.[a-z][a-z0-9_]*\s*\}\}/.test(content)) labels.push('共通情報')
  return labels
}

type MenuKey = 'field' | 'var'

export default function AutoReplyInsertChips({
  accountId,
  onInsert,
  disabled = false, lockedReason,
  load = loadTemplateReferences,
  references: providedReferences,
  referenceState,
}: {
  accountId: string | null
  onInsert: (token: string) => void
  disabled?: boolean
  lockedReason?: string
  load?: (accountId: string) => Promise<TemplateReferences>
  references?: TemplateReferences
  referenceState?: 'idle' | 'loading' | 'ready' | 'failed'
}) {
  const [loadedReferences, setReferences] = useState<TemplateReferences>(EMPTY_REFERENCES)
  const [loadedState, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const references = providedReferences ?? loadedReferences
  const state = referenceState ?? loadedState
  const [menu, setMenu] = useState<MenuKey | null>(null)
  useEffect(() => { if (disabled || lockedReason) setMenu(null) }, [disabled, lockedReason])
  const fieldRef = useRef<HTMLButtonElement>(null)
  const varRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (providedReferences !== undefined) return
    if (!accountId) { setReferences(EMPTY_REFERENCES); setState('idle'); return }
    let alive = true
    setState('loading')
    load(accountId)
      .then((next) => { if (alive) { setReferences(next); setState('ready') } })
      .catch(() => { if (alive) setState('failed') })
    return () => { alive = false }
  }, [accountId, load, providedReferences])

  const pick = (token: string) => { if (disabled || lockedReason) return; setMenu(null); onInsert(token) }
  const why = (ready: boolean, label: string) =>
    state === 'loading' ? '読み込み中です'
      : state === 'failed' ? '差し込み項目を読み込めませんでした。画面を再読み込みしてください'
        : ready ? `${label}を差し込む` : `差し込める${label}がありません`
  const fieldsReady = state === 'ready' && references.friendFields.length > 0
  const varsReady = state === 'ready' && references.commonVars.length > 0

  return (
    <>
      {state === 'failed' ? <div className={styles.notice}><Notice tone="danger" message="差し込み項目を読み込めませんでした。画面を再読み込みしてください。" /></div> : null}
      <MessageInsertButton disabled={disabled} lockedReason={lockedReason} kind="name" label="名前" title="名前を差し込む" onClick={() => pick(NAME_TOKEN)} />
      <MessageInsertButton kind="field" label="友だち情報" ref={fieldRef} title={why(fieldsReady, '友だち情報')} expanded={menu === 'field'} disabled={disabled || !fieldsReady} lockedReason={lockedReason} onClick={() => setMenu(m => m === 'field' ? null : 'field')} />
      <MessageInsertButton kind="var" label="共通情報" ref={varRef} title={why(varsReady, '共通情報')} expanded={menu === 'var'} disabled={disabled || !varsReady} lockedReason={lockedReason} onClick={() => setMenu(m => m === 'var' ? null : 'var')} />
      <MessageInsertButton kind="date" label="予約日時" disabled lockedReason={lockedReason} title="自動応答では予約日時を差し込めません" onClick={() => {}} />
      <ActionMenu
        open={state === 'ready' && !disabled && !lockedReason && menu === 'field'}
        anchorRef={fieldRef}
        ariaLabel="差し込む友だち情報"
        onClose={() => setMenu(null)}
        items={references.friendFields.map((field) => ({ id: field.fieldKey, label: field.name, onSelect: () => pick(`{{field.${field.fieldKey}}}`) }))}
      />
      <ActionMenu
        open={state === 'ready' && !disabled && !lockedReason && menu === 'var'}
        anchorRef={varRef}
        ariaLabel="差し込む共通情報"
        onClose={() => setMenu(null)}
        items={references.commonVars.map((item) => ({ id: item.varKey, label: item.name, onSelect: () => pick(`{{var.${item.varKey}}}`) }))}
      />
    </>
  )
}
