'use client'

/*
 * 「前の入力を戻す」の帯。共通の帯（Notice）に、戻す操作と閉じる（捨てる）を載せるだけ。
 * 見た目は共通の帯のまま（画面の CSS を足さない）。
 */
import { useEffect, useState } from 'react'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'
import { BROWSER_DRAFT_WORDS } from './use-browser-draft'
import { SCENARIO_DRAFT_WORDS } from './use-scenario-draft'
import { AUTOSAVE_DELAY_MS } from './use-draft-autosave'

export function BrowserDraftNotice({
  ago,
  onRestore,
  onDiscard,
}: {
  ago: string | null
  onRestore: () => void
  onDiscard: () => void
}) {
  if (ago === null) return null
  return (
    <Notice
      tone="info"
      data-browser-draft
      message={`${BROWSER_DRAFT_WORDS.restoreTitle(ago)}閉じると消えます。`}
      action={<Button type="button" size="compact" onClick={onRestore}>{BROWSER_DRAFT_WORDS.restore}</Button>}
      onClose={onDiscard}
    />
  )
}

/**
 * 下書きの競合の帯（シナリオの下書きの口が 409 を返したとき）。共通の帯のまま、
 * 「最新の下書きを読み込む」を載せ、閉じる（×）を「自分の入力で上書きする」にする。
 * 帯は操作を1つまでの決まりなので、もう1つは閉じるに当てる。どちらかを選ぶまで上書きしない。
 */
export function ScenarioDraftConflictNotice({
  ago,
  onLoadLatest,
  onOverwrite,
}: {
  ago: string | null
  onLoadLatest: () => void
  onOverwrite: () => void
}) {
  if (ago === null) return null
  return (
    <Notice
      tone="warn"
      role="alert"
      data-scenario-draft-conflict
      message={`${SCENARIO_DRAFT_WORDS.conflict(ago)}${SCENARIO_DRAFT_WORDS.closeToOverwrite}`}
      action={<Button type="button" size="compact" onClick={onLoadLatest}>{SCENARIO_DRAFT_WORDS.loadLatest}</Button>}
      onClose={onOverwrite}
    />
  )
}

/** 下書きの失敗は短く伝え、入力を残したことと次の手順を読む窓へまとめる。 */
export function ScenarioDraftStatus({ label }: { label: string | null | undefined }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (label !== SCENARIO_DRAFT_WORDS.failed) setOpen(false) }, [label])
  if (label !== SCENARIO_DRAFT_WORDS.failed) return <>{label}</>
  return <>
    <span className="inline-flex items-center gap-2 whitespace-nowrap" data-scenario-draft-failed>
      自動保存できませんでした
      <Button variant="text" size="inline" onClick={() => setOpen(true)} aria-label="自動保存できなかった時の詳細">詳細</Button>
    </span>
    <Dialog open={open} onCancel={() => setOpen(false)} title="下書きを自動保存できませんでした" size="small" contentLayout="form"
      >
      <p className="text-body">入力内容はこの画面に残っています。画面を閉じる前に、必要な内容を控えてください。</p>
      <p className="text-body">通信状態を確かめて入力を続けると、入力が止まって{AUTOSAVE_DELAY_MS / 1000}秒後にもう一度自動保存します。</p>
      <p className="text-body">画面の保存・作成ボタンを押すと、この内容がそのまま保存されます。下書きだけを残す操作ではありません。配信中のシナリオでは、その後の配信にも反映されます。下書きだけを残す場合は、入力を変えて自動保存の完了を待ってください。</p>
    </Dialog>
  </>
}

/** 通常の状態は文字列を保ち、型が付けるtitleと帯なしの扱いも変えない。 */
export function scenarioDraftStatus(label: string | null | undefined) {
  return label === SCENARIO_DRAFT_WORDS.failed ? <ScenarioDraftStatus label={label} /> : label
}
