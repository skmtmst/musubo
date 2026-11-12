'use client'

import { lineAccountConnectionState } from '@/lib/line-account-state'
import type { AccountWithStats } from '@/contexts/account-context'
import Button from '@/components/shared/button'
import Avatar from '@/components/shared/avatar'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { TableHeadRow, Th } from '@/components/shared/table'
import { formatNumber } from '@/lib/format'

export function accountIconUrl(account: AccountWithStats): string | null {
  return account.iconUrl || account.pictureUrl || null
}

function AccountIcon({ account }: { account: AccountWithStats }) {
  const name = account.displayName || account.name
  return <Avatar name={name} src={accountIconUrl(account)} size={36} shape="rounded" alt={name} />
}

function ConnectionStatus({ account }: { account: AccountWithStats }) {
  const state = lineAccountConnectionState(account)
  const tone: StatusBadgeTone = state.tone === 'ok' ? 'success' : state.tone === 'warn' ? 'warning' : 'neutral'
  return <StatusBadge tone={tone} size="compact">{state.label}</StatusBadge>
}

export default function HqAccountList({
  accounts,
  onSelect,
  onSettings,
  selectLabel = 'ログイン',
}: {
  accounts: AccountWithStats[]
  onSelect: (accountId: string) => void
  onSettings?: (account: AccountWithStats) => void
  selectLabel?: string
}) {
  return (
    <section data-design="List" data-design-node="vLMQ5" className="min-w-0 overflow-hidden rounded-card border border-hairline bg-canvas shadow-card-surface">
      {/*
        U042: 768px 未満では表の右端にある操作（ログイン・設定）へ
        横スクロールしないと届かなかった。スマホでは名前＋状態＋操作が
        先に見えるカードにし、数値は開いて確認する形にする。
      */}
      <ul className="divide-y divide-hairline md:hidden" data-design="List">
        {accounts.map((account) => (
          <li key={account.id} className="p-4">
            <div className="flex min-w-0 items-center gap-3">
              <AccountIcon account={account} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink" title={account.displayName || account.name}>{account.displayName || account.name}</p>
                <p className="mt-0.5 truncate text-xs text-ink-faint" title={account.basicId || ''}>{account.basicId || 'LINE ID未取得'}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge tone={account.isActive ? 'success' : 'neutral'} size="compact">{account.isActive ? '有効' : '停止中'}</StatusBadge>
              <ConnectionStatus account={account} />
            </div>
            <div className="mt-3 flex gap-2">
              {onSettings ? <Button type="button" variant="secondary" onClick={() => onSettings(account)}>設定</Button> : null}
              <Button type="button" variant="secondary" onClick={() => onSelect(account.id)}>{selectLabel}</Button>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-ink-secondary">詳しい数値を見る</summary>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-control bg-canvas-sunken px-2 py-2">
                  <dt className="text-nano text-ink-faint">友だち数</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{formatNumber(account.stats?.friendCount)}</dd>
                </div>
                <div className="rounded-control bg-canvas-sunken px-2 py-2">
                  <dt className="text-nano text-ink-faint">今月の配信数</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{formatNumber(account.stats?.messagesThisMonth)}</dd>
                </div>
                <div className="rounded-control bg-canvas-sunken px-2 py-2">
                  <dt className="text-nano text-ink-faint">担当者数</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{account.stats?.staffCount == null ? '—' : `${formatNumber(account.stats.staffCount)}人`}</dd>
                </div>
              </dl>
            </details>
          </li>
        ))}
      </ul>
      <div className="hidden w-full overflow-x-auto md:block">
        <table className="w-full min-w-max text-left">
          <thead>
            <TableHeadRow>
              <Th>アカウント</Th>
              <Th align="right">友だち数</Th>
              <Th align="right">今月の配信数</Th>
              <Th>接続状態</Th>
              <Th align="right">担当者数</Th>
              <Th>状態</Th>
              <Th align="right">操作</Th>
            </TableHeadRow>
          </thead>
          <tbody className="divide-y divide-hairline">
            {accounts.map((account) => (
              <tr key={account.id} className="h-16 hover:bg-canvas-sunken">
                <td className="px-5 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <AccountIcon account={account} />
                    <div className="min-w-0">
                      <p className="max-w-72 truncate text-sm font-semibold text-ink" title={account.displayName || account.name}>{account.displayName || account.name}</p>
                      <p className="mt-0.5 max-w-72 truncate text-xs text-ink-faint" title={account.basicId || ''}>{account.basicId || 'LINE ID未取得'}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums text-ink">{formatNumber(account.stats?.friendCount)}</td>
                <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums text-ink">{formatNumber(account.stats?.messagesThisMonth)}</td>
                <td className="px-4 py-2"><ConnectionStatus account={account} /></td>
                <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums text-ink">{account.stats?.staffCount == null ? '—' : `${formatNumber(account.stats.staffCount)}人`}</td>
                <td className="px-4 py-2"><StatusBadge tone={account.isActive ? 'success' : 'neutral'} size="compact">{account.isActive ? '有効' : '停止中'}</StatusBadge></td>
                <td className="px-5 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    {onSettings ? <Button type="button" variant="secondary" onClick={() => onSettings(account)}>設定</Button> : null}
                    <Button type="button" variant="secondary" onClick={() => onSelect(account.id)}>{selectLabel}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
