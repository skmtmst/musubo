'use client'

/*
 * マイルタブ。残高と履歴はマイル画面（この人のマイル詳細）で見る。
 * 会員ランクの履歴（日時・前→後・理由）は、ここに出す（mAbif）。ランクを動かしていない店では、段を出さない。
 */
import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import ListState from '@/components/shared/list-state'
import { useAccount } from '@/contexts/account-context'
import { memberRanksApi } from '@/lib/api/helpers/gap3'
import EmptyTab from './empty-tab'
import styles from './delivery-consent.module.css'

type RankHistory = { id: string; from_tier_id: string | null; to_tier_id: string; reason: string; at: string }

const REASONS: Record<string, string> = { activated: 'ランクを動かした', upgrade: '条件を満たした', downgrade: '条件を下回った', grace: '猶予が終わった', recovered: '回復した', manual: '店が変えた' }
const md = (value: string) => `${value.slice(0, 4)}/${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`

export default function MilesTab({ friendId, balanceSource }: { friendId: string; balanceSource: 'ec' | 'musubo' | null }) {
  const { selectedAccountId } = useAccount()
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ key: string; status: 'ready'; history: RankHistory[]; names: Record<string, string> } | { key: string; status: 'loading' | 'error' } | null>(null)
  const key = JSON.stringify([selectedAccountId, friendId])
  const visible = state?.key === key ? state : null
  useEffect(() => {
    if (!selectedAccountId) return
    let alive = true
    setState({ key, status: 'loading' })
    void Promise.all([memberRanksApi.friend(selectedAccountId, friendId), memberRanksApi.program(selectedAccountId)]).then(([rank, program]) => {
      if (!alive) return
      if (!rank.success || !program.success) throw new Error('rank history unavailable')
      setState({ key, status: 'ready', history: ((rank.data as { history?: RankHistory[] } | null)?.history) ?? [], names: Object.fromEntries(program.data.tiers.map((tier) => [tier.id, tier.name])) })
    }).catch(() => { if (alive) setState({ key, status: 'error' }) })
    return () => { alive = false }
  }, [selectedAccountId, friendId, key, retry])
  const history = visible?.status === 'ready' ? visible.history : []
  const names = visible?.status === 'ready' ? visible.names : {}
  return (
    <>
      <EmptyTab
        icon={<Star size={16} />}
        title="この友だちのマイルはマイル画面で見られます"
        text="マイル残高と履歴は、マイル画面で確認できます。"
        actions={[{ label: 'マイルを確認 ↗', href: `/mileage/friends/detail?id=${encodeURIComponent(friendId)}` }]}
      />
      {balanceSource !== null && selectedAccountId && visible?.status === 'error' ? <ListState kind="error" title="会員ランクの履歴を読み込めませんでした" onRetry={() => setRetry(value => value + 1)} /> : null}
      {history.length > 0 && balanceSource !== null ? (
        <section className={styles.body} aria-label={balanceSource === 'ec' ? 'musubo側の会員ランク履歴' : '会員ランクの履歴'}>
          <h3 className={styles.sectionTitle}>{balanceSource === 'ec' ? 'musubo側の会員ランク履歴' : '会員ランクの履歴'}</h3>
          <DataTable>
            <thead><TableHeadRow><Th>日時</Th><Th>前 → 後</Th><Th grow>理由</Th></TableHeadRow></thead>
            <tbody>
              {history.map((row) => (
                <Tr key={row.id}>
                  <Td>{md(row.at)}</Td>
                  <Td>{`${row.from_tier_id ? names[row.from_tier_id] ?? '—' : '—'} → ${names[row.to_tier_id] ?? '—'}`}</Td>
                  <Td grow>{REASONS[row.reason] ?? row.reason}</Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        </section>
      ) : null}
    </>
  )
}
