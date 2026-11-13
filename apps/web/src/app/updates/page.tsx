'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { PageTitle } from '@/components/templates/page-frame'

import { useEffect, useState } from 'react'
import ListState from '@/components/shared/list-state'
import NoteBar from '@/components/shared/note-bar'
import Notice from '@/components/shared/notice'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { formatDateTime } from '@/lib/format'
import { updateRunStatusLabel } from '@/lib/status-labels'

const API_URL = process.env.NEXT_PUBLIC_API_URL!
// self-update を構成した環境でのみ設定される。
// 未設定 = 自動アップデート非構成環境なので、この画面は fetch せず案内のみ表示する。
const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_API_KEY

interface Row {
  id: string
  started_at: number
  completed_at: number | null
  from_version: string
  to_version: string
  status: string
  error: string | null
  rollback_expires_at: number | null
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: Row[] }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string }

async function fetchHistory(adminKey: string): Promise<Row[]> {
  const r = await fetch(`${API_URL}/admin/update/history`, {
    headers: { 'x-admin-api-key': adminKey },
  })
  if (!r.ok) throw new Error(`history fetch ${r.status}`)
  const j = (await r.json()) as { history: Row[] }
  return j.history
}

export default function UpdatesPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [fromHq, setFromHq] = useState(false)
  usePageTitle('更新履歴')
  usePageCrumbs(fromHq ? [{ label: '統括', href: '/hq' }] : null)

  useEffect(() => {
    setFromHq(new URLSearchParams(window.location.search).get('from') === 'hq')
    if (!ADMIN_KEY) {
      setState({ kind: 'unconfigured' })
      return
    }
    fetchHistory(ADMIN_KEY)
      .then((rows) => setState({ kind: 'ready', rows }))
      .catch((e) => {
        // 401/403 = キー不一致 or 未構成。ネットワーク失敗も含め、
        // 運用者を驚かせる赤エラーではなく状況の説明を出す。
        const msg = e instanceof Error ? e.message : String(e)
        if (/ 40[13]$/.test(msg)) setState({ kind: 'unconfigured' })
        else setState({ kind: 'error', message: describeApiFailure(e, '更新履歴の読み込み') })
      })
  }, [])

  const rows = state.kind === 'ready' ? state.rows : []

  return (
    <div className="flex flex-col gap-4">
      {/* カード同士の縦の間隔はこの親の gap-4（16px）だけで作る。子ごとの mb/mt は付けない。 */}
      <PageTitle as="h1" className="text-ink text-xl font-semibold">アップデート履歴</PageTitle>
      {state.kind === 'unconfigured' && (
        <>
          <div><NoteBar>この環境では自動アップデートが構成されていないため、履歴はありません。</NoteBar></div>
          <section className="bg-canvas rounded-card border-hairline border">
            <ListState
              kind="empty"
              emptyPreset="readonly"
              title="更新履歴はまだありません"
              description="musubo の更新は運営が行います。この画面には、自動で更新した記録だけが出ます。"
            />
          </section>
        </>
      )}
      {state.kind === 'error' && (
        <Notice tone="warn" className="mb-4">
          {state.message}
        </Notice>
      )}
      {state.kind === 'ready' && rows.length === 0 && (
        <p className="text-ink-faint text-sm">履歴はまだありません。</p>
      )}
      {rows.length > 0 && (
        <DataTable>
            <thead>
              <TableHeadRow>
                <Th style={{ width: '25%' }}>開始</Th>
                <Th style={{ width: '30%' }}>From → To</Th>
                <Th style={{ width: '20%' }}>Status</Th>
                <Th style={{ width: '25%' }}>Rollback</Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="text-ink-secondary whitespace-nowrap tabular-nums">
                    {formatDateTime(r.started_at)}
                  </Td>
                  <Td className="font-mono text-xs">
                    <span className="block truncate" title={`${r.from_version} → ${r.to_version}`}>
                      {r.from_version} → {r.to_version}
                    </span>
                  </Td>
                  <Td>
                    <StatusBadge tone={statusTone(r.status)} size="compact">
                      {updateRunStatusLabel(r.status)}
                    </StatusBadge>
                  </Td>
                  <Td>
                    {r.status === 'success' &&
                    r.rollback_expires_at &&
                    Date.now() < r.rollback_expires_at ? (
                      /*
                        **押しても何も起きない口を置かない**（`docs/v8-design-rules.md` §5「出す＝使える」）。戻す仕組みは画面から使えないので、
                        押し口ではなく文で理由を出す。以前はブラウザの `alert` で
                        「rollback not implemented in MVP — use CLI」と内部語を出していた。
                      */
                      <span className="text-ink-faint text-xs">
                        戻せる期間内ですが、この画面からは戻せません
                      </span>
                    ) : (
                      <span className="text-ink-faint text-xs">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
        </DataTable>
      )}
    </div>
  )
}

function statusTone(s: string): StatusBadgeTone {
  if (s === 'success') return 'success'
  if (s === 'rolled_back') return 'warning'
  if (s === 'failed') return 'danger'
  if (s === 'running') return 'info'
  return 'neutral'
}
