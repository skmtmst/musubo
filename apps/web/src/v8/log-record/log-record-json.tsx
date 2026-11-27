'use client'

import { useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import Button from '@/components/shared/button'
import CodeBlock from '@/components/shared/code-block'
import CopyTextButton from '@/components/shared/copy-text-button'
import { formatNumber } from '@/lib/format'
import { formatLogRecord } from './redact'
import styles from './log-record-json.module.css'

/** これより長い JSON は先頭だけを画面に出す（写すのは全文）。 */
export const LOG_RECORD_SHOWN_CHARS = 1_000

/**
 * 記録の中身を JSON で開いて写す部品。閉じている間は整形しない（大きい記録でも
 * 画面を止めない）。出す値も写す値も、秘密値・個人情報を伏せた後のものだけ。
 * 写すのは開いて見えている記録だけで、閲覧のみの人には写す操作を出さない。
 */
export default function LogRecordJson({ value, label = '記録', canCopy }: {
  /** 画面がいま見せている範囲の記録。ここで伏せてから整形する。 */
  value: unknown
  /** 「〇〇の JSON を開く」の〇〇。 */
  label?: string
  /** 写す操作を出すか。閲覧のみの人には false を渡す。 */
  canCopy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<{ value: unknown; limit: number }>({ value, limit: LOG_RECORD_SHOWN_CHARS })
  const limit = shown.value === value ? shown.limit : LOG_RECORD_SHOWN_CHARS
  const bodyId = useId()
  const text = useMemo(() => (open ? formatLogRecord(value) : ''), [open, value])
  const cut = text.length > limit
  // 代理対の途中で切ると表示が壊れるため、文字の手前で止める。
  const cutAt = cut && /[\uD800-\uDBFF]/.test(text[limit - 1])
    ? limit - 1 : Math.min(limit, text.length)
  return (
    <div className={styles.root} data-log-record-json={open ? 'open' : 'closed'}>
      <div className={styles.head}>
        <Button size="compact" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => { setOpen(!open); if (open) setShown({ value, limit: LOG_RECORD_SHOWN_CHARS }) }}>
          {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          {open ? `${label}の JSON を閉じる` : `${label}の JSON を開く`}
        </Button>
        {open && canCopy ? <CopyTextButton value={text} variant="secondary" label="JSON をコピー" aria-label={`${label}の JSON をコピー`} /> : null}
      </div>
      {open ? (
        <div id={bodyId} className={styles.body}>
          <div className={styles.code}><CodeBlock wrap>{cut ? text.slice(0, cutAt) : text}</CodeBlock></div>
          {cut ? <Button size="compact" onClick={() => setShown({ value, limit: limit + LOG_RECORD_SHOWN_CHARS })}>{`続きを表示（残り ${formatNumber(text.length - cutAt)}文字）`}</Button> : null}
          <p className={styles.note}>
            {cut ? `長いので先頭の ${formatNumber(cutAt)} 文字だけを出しています。${canCopy ? 'コピーすると全文を写せます。' : ''}` : null}
            秘密値と個人情報は伏せた形で出しています。
          </p>
        </div>
      ) : null}
    </div>
  )
}
