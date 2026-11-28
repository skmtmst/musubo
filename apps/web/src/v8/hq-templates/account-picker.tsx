'use client'

/*
 * 配るアカウントの欄（統括のリッチメニューを作る③「配る先」 など）。共通の「配るアカウントを選ぶ」窓（dJZ7Q・）を開く1行。
 * 選べるのは統括のひな形の口が返す配り先（allowed）だけ。友だちの数は統括のアカウント一覧と同じ口から読み、
 * 選んだアカウントの友だちの合計を onFriendTotal で返す（1つでも読めないときは null。足し算で嘘の数を出さない）。
 */
import { useEffect, useMemo, useState } from 'react'
import { HqAccountPickerField } from '@/components/shared/hq-account-picker'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import SectionHeader from '@/components/shared/section-header'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import styles from '../hq-broadcasts/create.module.css'
import { emptyValue } from '@/components/shared/empty-value'

export default function HqAccountPicker({ title, help, allowed, selected, onChange, note, disabled, onFriendTotal }: {
  title: string
  /** 題の右の「？」の中身。 */
  help?: string
  /** 配れるアカウント（統括のひな形の口の配り先）。 */
  allowed: Array<{ id: string; name: string }>
  selected: string[]
  onChange: (ids: string[]) => void
  /** 欄の下の説明。無いときは出さない。 */
  note?: string
  disabled?: boolean
  /** 選んだアカウントの友だちの合計（読めないときは null）。 */
  onFriendTotal?: (total: number | null) => void
}) {
  const allowedKey = JSON.stringify(allowed.map((account) => account.id).sort())
  const scope = useMemo(() => ({ key: allowedKey }), [allowedKey])
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; state: 'ready' | 'error'; friends: Map<string, number | null> } | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setSnapshot(null)
    void Promise.resolve().then(() => api.lineAccounts.list()).then((list) => {
      if (!current) return
      if (list?.success) setSnapshot({ scope, state: 'ready', friends: new Map(list.data.map((account) => [account.id, account.stats?.friendCount ?? null])) })
      else setSnapshot({ scope, state: 'error', friends: new Map() })
    }).catch(() => { if (current) setSnapshot({ scope, state: 'error', friends: new Map() }) })
    return () => { current = false }
  }, [scope, retry])
  const friends = useMemo(() => snapshot?.scope === scope && snapshot.state === 'ready' ? snapshot.friends : new Map<string, number | null>(), [snapshot, scope])
  const failed = snapshot?.scope === scope && snapshot.state === 'error'
  const accounts = useMemo(() => allowed.map((account) => ({ ...account, friendCount: friends.has(account.id) ? friends.get(account.id) ?? null : null })), [allowed, friends])
  const total = useMemo(() => {
    if (selected.length === 0) return 0
    let sum = 0
    for (const id of selected) {
      const count = friends.get(id)
      if (count == null) return null
      sum += count
    }
    return sum
  }, [friends, selected])
  useEffect(() => { onFriendTotal?.(total) }, [onFriendTotal, total])
  return (
    <div className={styles.accounts} data-design-node="gQabc-accounts">
      <SectionHeader title={title} help={help} helpLabel={help ? `${title}の説明` : undefined} />
      <HqAccountPickerField label={title} accounts={accounts} value={selected} onChange={onChange} disabled={disabled}
        meta={(account) => `友だち ${account.friendCount == null ? emptyValue('unknown') : formatNumber(account.friendCount)}`} />
      {failed ? <Notice tone="warn" action={<Button onClick={() => setRetry(n => n + 1)}>友だち数を読み直す</Button>}>友だち数を読み込めませんでした。</Notice> : null}
      {note ? <p className={styles.accountsNote} aria-live="polite">{selected.length === 0 ? `アカウントを選んでください。${note}` : `${formatNumber(selected.length)} アカウントを選んでいます。${note}`}</p> : null}
    </div>
  )
}
