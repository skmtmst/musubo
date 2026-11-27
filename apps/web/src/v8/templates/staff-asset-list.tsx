'use client'

import Link from '@/components/shared/list-navigation'
import { useCallback, useEffect, useState } from 'react'
import { api, type BroadcastAssetKind, type BroadcastMessageAsset } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { formatDateTime } from '@/lib/format'
import ListState from '@/components/shared/list-state'
import { useResponseGate } from '@/lib/use-response-gate'

const LABELS: Record<BroadcastAssetKind, { title: string; singular: string }> = {
  rich_message: { title: 'リッチメッセージ', singular: 'リッチメッセージ' },
  card_message: { title: 'カルーセル', singular: 'カルーセル' },
  coupon: { title: 'クーポン', singular: 'クーポン' },
  research: { title: 'リサーチ', singular: 'リサーチ' },
}

/*
 * N-144: staff 向けの資産一覧。作成・変更・削除APIは owner/admin 限定なので、
 * 変更系の操作を持つ BroadcastAssetManager は出さず、こちらは閲覧だけに絞る。
 * 「一斉配信で使う」は画面遷移であり変更操作ではないため残す。
 */
export default function StaffAssetList({ kind }: { kind: BroadcastAssetKind }) {
  const { selectedAccountId } = useAccount()
  const [items, setItems] = useState<BroadcastMessageAsset[]>([])
  /*
   * PKG110：読めなかったことを「まだありません」や前の一覧と混ぜない。
   * 種類・アカウントを変えたら、前の遅い応答は捨てる。
   */
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const gate = useResponseGate()

  const load = useCallback(async () => {
    const token = gate.begin()
    setState('loading')
    setItems([])
    try {
      const res = await api.broadcastMessageAssets.list({ accountId: selectedAccountId || undefined, kind })
      if (!gate.current(token)) return
      if (!res?.success || !Array.isArray(res.data)) {
        setState('error')
        return
      }
      setItems(res.data)
      setState('ready')
    } catch {
      if (gate.current(token)) setState('error')
    }
  }, [kind, selectedAccountId, gate])

  useEffect(() => { void load() }, [load])

  const meta = LABELS[kind]

  if (state === 'loading') {
    return <p className="text-ink-faint py-8 text-center text-sm">読み込み中…</p>
  }
  if (state === 'error') {
    return <ListState kind="error" title={`${meta.title}を読み込めませんでした`} onRetry={() => void load()} />
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <article key={item.id} className="bg-canvas rounded-card content-card border p-5">
          <span className="bg-accent-soft text-accent-deep rounded-pill px-2 py-1 text-xs font-medium">{meta.title}</span>
          <h3 className="text-ink mt-3 truncate font-bold">{item.name}</h3>
          <p className="text-ink-faint mt-1 text-xs">更新 {formatDateTime(item.updatedAt)}</p>
          <div className="mt-4">
            <Link href={`/broadcasts/new?contentTemplateId=${encodeURIComponent(item.id)}`} className="border-accent text-accent-deep rounded-control inline-block border px-3 py-2 text-sm font-bold">一斉配信で使う</Link>
          </div>
        </article>
      ))}
      {items.length === 0 && (
        <div className="bg-canvas border-hairline text-ink-faint col-span-full rounded-card border border-dashed p-12 text-center text-sm">
          まだ{meta.singular}テンプレートがありません。
        </div>
      )}
    </div>
  )
}
