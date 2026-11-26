'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useListUrlValue } from '@/components/shared/list-url-state'
import Button from '@/components/shared/button'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import EntitySelect from '@/components/shared/entity-select'
import Select from '@/components/shared/select'
import { AttentionCount } from '@/components/shared/attention-count'
import { RowMenu } from '@/components/shared/row-actions'
import { RowNameButton } from '@/components/shared/table'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import { ListToolbarEnd, ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { ListPage } from '@/components/templates'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useAccount, type AccountWithStats } from '@/contexts/account-context'
import { lineAccountConnectionState } from '@/lib/line-account-state'
import { connectionReasonLine } from '@/v8/hq/connection-reasons'
import { api } from '@/lib/api'
import { notifyToast } from '@/components/shared/toast'
import type { AccountStyle } from '@line-crm/shared'
import { hqStyleApi } from '@/lib/api/helpers/styles'
import { styleLabel } from '@/v8/onboarding/public/model/index'
import styles from './attention.module.css'

/*
 * 統括の「対応が要るもの」（★V8 修正案の列 VHp7p `Kyf8U`。決まり ）。
 *
 * 見る権限のあるアカウントごとに、未対応のトーク・承認待ちの予約・未払い・接続の異常・止まった配信の件数を出す。
 * 件数を押すと、そのアカウントに切り替えて受信箱・予約・配信の画面を開く。権限の無いアカウントは口が返さない（出さない）。
 * 口は組4の `GET /api/hq/style-attention`（作り中。撮影は見本）。
 */

type HqAttentionKind = 'unhandledChats' | 'pendingBookings' | 'unpaid' | 'connections' | 'stoppedDeliveries'
type HqAttentionItem = { accountId: string; name: string; style?: AccountStyle; counts: Partial<Record<string, number>>; details: Partial<Record<string, Array<{ id: string; href?: string }>>> }

const KINDS: ReadonlyArray<{ key: HqAttentionKind; label: string; href: string }> = [
  { key: 'unhandledChats', label: '未対応のトーク', href: '/chats?status=unread' },
  { key: 'pendingBookings', label: '承認待ちの予約', href: '/booking/bookings' },
  { key: 'unpaid', label: '未払い', href: '/booking/bookings' },
  { key: 'connections', label: '接続の異常', href: '/accounts' },
  { key: 'stoppedDeliveries', label: '止まった配信', href: '/broadcasts' },
]

/** 口の行き先のうち、今の画面に無い道（予約設定・LINE アカウント）は今ある画面へ読み替える。 */
function hrefOf(item: HqAttentionItem, kind: { key: HqAttentionKind; href: string }): string {
  if (kind.key === 'connections') return `/accounts/detail?id=${encodeURIComponent(item.accountId)}`
  const href = item.details[kind.key]?.[0]?.href
  if (!href || href.startsWith('/booking/settings') || href.startsWith('/line-accounts')) return kind.href
  return href
}

const count = (item: HqAttentionItem, kind: HqAttentionKind) => item.counts[kind] ?? 0
const total = (item: HqAttentionItem) => KINDS.reduce((sum, kind) => sum + count(item, kind.key), 0)

export default function HqAttentionV8() {
  usePageTitle('対応が要るもの')
  const router = useRouter()
  const { accounts, setSelectedAccountId } = useAccount()
  const [connectionError, setConnectionError] = useState(false)
  const [connectionAccounts, setConnectionAccounts] = useState<AccountWithStats[]>([])
  const [items, setItems] = useState<HqAttentionItem[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  /* 種類は URL に置く（統括トップの「接続に問題」から ?kind=connections で来る）。知らない値はすべて扱い。 */
  const [kindParam, setKindParam] = useListUrlValue('kind', 'all')
  const kind = (kindParam === 'all' || KINDS.some((item) => item.key === kindParam) ? kindParam : 'all') as 'all' | HqAttentionKind
  const setKind = (next: 'all' | HqAttentionKind) => setKindParam(next)
  const [order, setOrder] = useState<'count' | 'name'>('count')
  const [folder, setFolder] = useState('all')
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setConnectionError(false)
    try {
      const res = await hqStyleApi.attention()
      if (!res.success) throw new Error('attention failed')
      const byId = new Map<string, HqAttentionItem>(res.data.items.map(item => [item.accountId, item]))
      try {
        const accountRes = await api.lineAccounts.list()
        if (!accountRes.success) throw new Error('accounts failed')
        const accountRows = accountRes.data as AccountWithStats[]
        setConnectionAccounts(accountRows)
        setConnectionError(false)
        for (const [id, item] of byId) byId.set(id, { ...item, counts: { ...item.counts, otherConnections: item.counts.connections ?? 0, connections: 0 } })
        for (const account of accountRows) {
          const state = lineAccountConnectionState(account).label
          const existing = byId.get(account.id)
          if (!existing && state !== '要確認' && state !== '未確認') continue
          const item = existing ?? { accountId: account.id, name: account.name, counts: {}, details: {} }
          const needsAttention = state === '要確認' || state === '未確認'
          byId.set(account.id, { ...item, counts: { ...item.counts, otherConnections: needsAttention ? 0 : item.counts.otherConnections ?? 0, connections: needsAttention ? 1 : 0 } })
        }
      } catch {
        setConnectionAccounts([])
        setConnectionError(true)
      }
      setItems([...byId.values()])
    } catch (caught) {
      setError(describeApiFailure(caught, '読み込み', { scope: 'hq' }))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void api.lineAccountFolders.list().then((res) => { if (res.success) setFolders(res.data.folders.map((item) => ({ id: item.id, name: item.name }))) }).catch(() => { /* フォルダが読めなくても全部は出す */ })
  }, [])

  const folderOf = (accountId: string) => (accounts.find((account) => account.id === accountId) as { folderId?: string | null } | undefined)?.folderId ?? null
  const shown = useMemo(() => (items ?? [])
    .filter((item) => (kind === 'all' ? total(item) > 0 : count(item, kind) > 0))
    .filter((item) => folder === 'all' || folderOf(item.accountId) === folder)
    .sort((a, b) => order === 'name'
      ? a.name.localeCompare(b.name, 'ja')
      : (kind === 'all' ? total(b) - total(a) : count(b, kind) - count(a, kind))),
  [items, kind, folder, order, accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  /* そのアカウントに切り替えてから開く。 */
  const open = (accountId: string, href: string) => {
    const name = items?.find((item) => item.accountId === accountId)?.name
    setSelectedAccountId(accountId)
    notifyToast(`${name || '選んだアカウント'} に切り替えました`, { tone: 'info' })
    router.push(href)
  }

  const otherConnections = (items ?? []).filter(item => (item.counts.otherConnections ?? 0) > 0)
  const sum = (key: HqAttentionKind) => (items ? items.reduce((value, item) => value + count(item, key), 0) : null)
  const accountsWith = (key: HqAttentionKind) => (items ?? []).filter((item) => count(item, key) > 0)

  const stats = (
    <KpiBand>
      {KINDS.map((item) => {
        const withCount = accountsWith(item.key)
        return (
          <KpiCard
            key={item.key}
            title={item.label}
            value={sum(item.key)}
            unit="件"
            icon={null}
            loading={items === null}
            detail={withCount.length === 1 && item.key === 'connections' ? withCount[0].name : `${withCount.length} アカウント`}
          />
        )
      })}
    </KpiBand>
  )

  const toolbar = (
    <ListToolbarFrame>
      <ListToolbarRow>
        <Select aria-label="種類" value={kind} onChange={(value) => setKind(value as typeof kind)} options={[{ value: 'all', label: '種類：すべて' }, ...KINDS.map((item) => ({ value: item.key, label: `種類：${item.label}` }))]} />
        <EntitySelect compact aria-label="アカウントのフォルダ" noun="フォルダ" valuePrefix="フォルダ：" value={folder} onChange={setFolder} options={[{ value: 'all', label: 'すべて' }, ...folders.map((item) => ({ value: item.id, label: item.name }))]} />
        <ListToolbarEnd><Select aria-label="並び" label="並び" value={order} onChange={(value) => setOrder(value as 'count' | 'name')} options={[{ value: 'count', label: '件数の多い順' }, { value: 'name', label: '名前順' }]} /></ListToolbarEnd>
      </ListToolbarRow>
    </ListToolbarFrame>
  )

  return (
    <ListPage
      boardId="Kyf8U"
      title="対応が要るもの"
      help="アカウントごとに、すぐ対応が要るものの件数を出します。件数を押すと、そのアカウントに切り替えて受信箱・予約・配信の画面を開きます。見る権限の無いアカウントは出しません。"
      actions={<Button onClick={() => void load()} busy={loading} busyLabel="読み直しています…"><RefreshCw aria-hidden="true" className={styles.buttonIcon} />すべて読み直す</Button>}
      stats={stats}
      toolbar={toolbar}
      tableInset
    >
      {otherConnections.length > 0 ? <Notice tone="warn"><details><summary>別の接続点検に異常 {otherConnections.length} アカウント</summary>{otherConnections.map(item => <div key={item.accountId}>{item.name} <Button onClick={() => open(item.accountId, `/accounts/detail?id=${encodeURIComponent(item.accountId)}`)}>設定を開く</Button></div>)}</details></Notice> : null}
      {connectionError ? <Notice tone="warn">アカウントの接続状態を取得できませんでした。接続の数は従来の点検件数です。読み直してください。</Notice> : null}
      {error ? <Notice tone="danger" action={<Button onClick={() => void load()}>もう一度試す</Button>}>{error}</Notice> : null}
      <div className={styles.stack}>
      {items === null ? (error ? null : <ListState kind="loading" title="読み込んでいます…" />) : shown.length === 0 && !error ? (
        <ListState kind="empty" title="今、対応が要るものはありません" emptyPreset="readonly" />
      ) : (
        <div className={styles.table}><GridTable label="対応が要るもの" design={{ columns: 'minmax(0, 1fr) var(--hqa-col-wide) var(--hqa-col-wide) var(--hqa-col-narrow) var(--hqa-col-mid) var(--hqa-col-mid) var(--hqa-col-menu)', gap: 'var(--polish-space-card)', rowPadding: '8px var(--polish-space-section)', rowHeight: 'auto', fontSize: 'var(--text-body)' }}>
          <GridHeadRow>
            <GridCell role="columnheader">アカウント</GridCell>
            {KINDS.map((item) => <GridCell key={item.key} role="columnheader">{item.label}</GridCell>)}
            <GridCell role="columnheader">操作</GridCell>
          </GridHeadRow>
          {shown.map((item) => (
            <GridRow key={item.accountId}>
              <GridCell className={styles.account}>
                <RowNameButton className={styles.name} title={item.name} onClick={() => router.push(`/accounts/detail?id=${encodeURIComponent(item.accountId)}`)}>{item.name}</RowNameButton>
                {item.style ? <span className={styles.style} title={styleLabel(item.style)}>{styleLabel(item.style)}</span> : null}
                {count(item, 'connections') > 0 && (() => { const account = connectionAccounts.find(a => a.id === item.accountId); if (!account) return null; const state = lineAccountConnectionState(account).label; return <span className={styles.style} title={state === '要確認' ? connectionReasonLine(account).title : '未確認：接続を確認できていません'}>{state}：{state === '未確認' ? '接続を確認できていません' : connectionReasonLine(account).text}</span> })()}
              </GridCell>
              {KINDS.map((entry) => {
                const value = count(item, entry.key)
                const href = hrefOf(item, entry)
                return <GridCell key={entry.key}><AttentionCount value={value} urgent={entry.key === 'connections' || entry.key === 'unpaid'} onClick={() => open(item.accountId, href)} label={`${item.name}の${entry.label} ${value}件を開く`} /></GridCell>
              })}
              <GridCell>
                <RowMenu appearance="box" size="row" label={`${item.name}の操作`} items={KINDS.filter((entry) => count(item, entry.key) > 0 || (entry.key === 'connections' && (item.counts.otherConnections ?? 0) > 0)).map((entry) => ({ id: entry.key, label: entry.key === 'connections' ? '設定を開く' : `${entry.label}を開く`, onSelect: () => open(item.accountId, hrefOf(item, entry)) }))} />
              </GridCell>
            </GridRow>
          ))}
        </GridTable></div>
      )}
      </div>
    </ListPage>
  )
}
