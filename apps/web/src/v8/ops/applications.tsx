'use client'

import { useEffect, useState } from 'react'
import { api, type OpsApplication } from '@/lib/api'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import ListState from '@/components/shared/list-state'
import SearchField from '@/components/shared/search-field'
import { PageFrame } from '@/components/templates/page-frame'
import styles from './applications.module.css'

const STATUS: Record<OpsApplication['status'], string> = {
  pending: '未対応', contacted: '連絡中', approved: '承認済み',
  rejected: '見送り', activated: '利用開始済み',
}

export default function OpsApplications() {
  const [rows, setRows] = useState<OpsApplication[]>([])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setError('')
    try {
      const res = await api.ops.applications.list()
      if (!res.success) { setError(res.error || '申込を読み込めませんでした'); return }
      setRows(res.data)
    } catch (caught) { setError(japaneseDetailOf(caught) || '申込を読み込めませんでした') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const visible = rows.filter((row) => {
    if (filter && row.status !== filter && !(filter === 'approved' && row.status === 'activated')) return false
    const query = q.trim().toLowerCase()
    return !query || [row.company_name, row.contact_name, row.email].some((value) => value.toLowerCase().includes(query))
  })
  const count = (status: OpsApplication['status']) => rows.filter((row) => row.status === status).length

  return <PageFrame kind="list" boardId="kWaRc" standalone>
    <article className={styles.panel}>
      <header><h1>申込アカウント</h1><p>申込内容を確認し、担当者から連絡した後に承認します。</p></header>
      <p className={styles.notice}><span aria-hidden="true">●</span> 要確認：承認するまで申込者はログインできません。操作は監査ログに記録されます。</p>
      <div className={styles.stats}>
        {([['未対応', count('pending'), '新しい申し込み'], ['連絡中', count('contacted'), '担当者の対応待ち'], ['承認済み', count('approved') + count('activated'), '招待メール送信済み'], ['見送り', count('rejected'), '利用不可']] as const).map(([label, value, description]) => <div key={label}><strong>{label}</strong><b>{loading ? '—' : value}件</b><small>{description}</small></div>)}
      </div>
      <div className={styles.toolbar}>
        <SearchField updateMode="immediate" value={q} onChange={setQ} onClear={() => setQ('')} placeholder="会社名・担当者・メールで探す" aria-label="申込を探す" />
        <div className={styles.filters}>
          <button type="button" data-active={!filter || undefined} onClick={() => setFilter('')}>すべて {rows.length}</button>
          {(['pending', 'contacted', 'approved', 'rejected'] as const).map((key) => <button key={key} type="button" data-active={filter === key || undefined} onClick={() => setFilter(key)}>{STATUS[key]}</button>)}
        </div>
      </div>
      {loading ? <ListState kind="loading" title="申込を読み込んでいます" />
        : error ? <ListState kind="error" title="申込を表示できませんでした" description={error} onRetry={() => void load()} />
        : visible.length === 0 ? <ListState kind="empty" title="該当する申し込みがありません" />
        : <div className={styles.tableScroll}><table aria-label="申込アカウント"><thead><tr><th>会社名</th><th>担当者</th><th>連絡先</th><th>きっかけ</th><th>状態</th><th>受付日</th></tr></thead><tbody>{visible.map((row) => {
          const href = `/ops/applications/detail?id=${encodeURIComponent(row.id)}`
          return <tr key={row.id}><td><a href={href}>{row.company_name}</a></td><td>{row.contact_name}</td><td>{row.email}<small>{row.phone}</small></td><td>{row.referral_source}</td><td><span className={styles.badge} data-status={row.status}>{Object.prototype.hasOwnProperty.call(STATUS, row.status) ? STATUS[row.status] : '状態不明'}</span></td><td>{new Date(row.created_at).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })}</td></tr>
        })}</tbody></table></div>}
      <footer className={styles.footer}><span>{visible.length ? `1–${visible.length}` : '0'} / {visible.length}件</span><span>申込を選ぶと詳細が開きます。</span></footer>
    </article>
  </PageFrame>
}
