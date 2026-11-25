'use client'

import { useStaffRole } from '@/lib/staff-role'
import { PageHeading } from '@/components/templates/page-frame'
import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'
import { usePageTitle } from '@/components/shell/page-chrome'
import ListState from '@/components/shared/list-state'
import Progress from '@/components/shared/progress'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import Select from '@/components/shared/select'
import Avatar from '@/components/shared/avatar'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { parseJstDateTime, shortDateTime } from '@/lib/hq-banners'
import { ChevronDown } from 'lucide-react'
import { formatDateTime, formatNumber } from '@/lib/format'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'

interface LineAccount {
  id: string
  channelId: string
  name: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface AccountHealthLog {
  id: string
  lineAccountId: string
  errorCode: number | null
  errorCount: number
  checkPeriod: string
  riskLevel: 'normal' | 'warning' | 'danger'
  createdAt: string
}

/*
 * R168: BAN検知はcronで5分ごとに走る。最後の確認がしきい値より古いなら
 * 「確認が止まっている」として区別する。古い正常の記録を現在の
 * 正常稼働として見せないための区切り。
 */
const STALE_CHECK_AFTER_MS = 60 * 60 * 1000

type AccountHealthState = AccountHealthLog['riskLevel'] | 'unknown' | 'error' | 'stale'

interface AccountHealthSnapshot {
  state: AccountHealthState
  logs: AccountHealthLog[]
  checkedAt?: string | null
}

interface AccountHealthResponse {
  success: boolean
  data?: unknown
}

interface AccountMigration {
  id: string
  fromAccountId: string
  toAccountId: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  migratedCount: number
  totalCount: number
  createdAt: string
  completedAt: string | null
}

type MigrationLoadState = 'loading' | 'ready' | 'error'

const riskConfig = {
  normal: { label: '正常', color: 'bg-success', textColor: 'text-success', bgColor: 'bg-success-bg' },
  warning: { label: '警告', color: 'bg-status-warn', textColor: 'text-status-warn-deep', bgColor: 'bg-status-warn-soft' },
  danger: { label: '危険', color: 'bg-danger', textColor: 'text-danger', bgColor: 'bg-danger-bg' },
  unknown: { label: '未確認', color: 'bg-ink-faint', textColor: 'text-ink-faint', bgColor: 'bg-canvas-sunken' },
  error: { label: '取得失敗', color: 'bg-danger', textColor: 'text-danger', bgColor: 'bg-danger-bg' },
  stale: { label: '確認停止中', color: 'bg-status-warn', textColor: 'text-status-warn-deep', bgColor: 'bg-status-warn-soft' },
} satisfies Record<AccountHealthState, { label: string; color: string; textColor: string; bgColor: string }>

/** 最終確認がしきい値より古いか。時刻が読めないものは「古い」とは言えないので stale にしない。 */
function isStaleCheck(createdAt: string | null | undefined, now = new Date()): boolean {
  if (!createdAt) return false
  const checkedAt = parseJstDateTime(createdAt)
  if (Number.isNaN(checkedAt.getTime())) return false
  return now.getTime() - checkedAt.getTime() > STALE_CHECK_AFTER_MS
}

function isRiskLevel(value: unknown): value is AccountHealthLog['riskLevel'] {
  return value === 'normal' || value === 'warning' || value === 'danger'
}

function resolveAccountHealth(response: AccountHealthResponse): AccountHealthSnapshot {
  if (!response.success) return { state: 'error', logs: [] }

  const payload = response.data && typeof response.data === 'object'
    ? response.data as { riskLevel?: unknown; logs?: unknown; connection?: { checkedAt?: unknown } }
    : {}
  const logs = Array.isArray(payload.logs) ? payload.logs as AccountHealthLog[] : []
  const state = isRiskLevel(payload.riskLevel)
    ? payload.riskLevel
    : 'unknown'

  return { state, logs, checkedAt: typeof payload.connection?.checkedAt === 'string' ? payload.connection.checkedAt : null }
}

async function loadAccountHealthStates(
  accountIds: string[],
  getHealth: (accountId: string) => Promise<AccountHealthResponse>,
): Promise<Record<string, AccountHealthSnapshot>> {
  const entries = await Promise.all(accountIds.map(async (accountId) => {
    try {
      return [accountId, resolveAccountHealth(await getHealth(accountId))] as const
    } catch {
      return [accountId, { state: 'error', logs: [] }] as const
    }
  }))

  return Object.fromEntries(entries)
}

const statusConfig: Record<AccountMigration['status'], { label: string; textColor: string; bgColor: string }> = {
  pending: { label: '待機中', textColor: 'text-ink-secondary', bgColor: 'bg-canvas-sunken' },
  in_progress: { label: '移行中', textColor: 'text-status-info', bgColor: 'bg-status-info-soft' },
  completed: { label: '完了', textColor: 'text-success', bgColor: 'bg-success-bg' },
  failed: { label: '失敗', textColor: 'text-danger', bgColor: 'bg-danger-bg' },
}

export default function HealthPage() {
  usePageTitle('BAN検知ダッシュボード')
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [healthLogs, setHealthLogs] = useState<Record<string, AccountHealthLog[]>>({})
  const [connectionCheckedAt, setConnectionCheckedAt] = useState<Record<string, string | null>>({})
  const [latestRisk, setLatestRisk] = useState<Record<string, AccountHealthState>>({})
  const [migrations, setMigrations] = useState<AccountMigration[]>([])
  const [migrationLoadState, setMigrationLoadState] = useState<MigrationLoadState>('loading')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [migrateFrom, setMigrateFrom] = useState<string | null>(null)
  const [migrateToId, setMigrateToId] = useState('')
  const [migrating, setMigrating] = useState(false)
  const [retryingHealthIds, setRetryingHealthIds] = useState<Set<string>>(new Set())
  /*
   * M018：アカウント一覧の読み込み失敗は、空（未登録）とは別の状態で持つ。
   * 失敗なのに「登録されていません」と出すと、障害時に登録作業へ誘導してしまう。
   */
  const [accountsError, setAccountsError] = useState<unknown>(null)
  // M019：移行口は owner 専用（サーバの権限表）。画面側でも役割で出し分ける目安。
  const role = useStaffRole()

  const loadAccounts = useCallback(async () => {
    setLoading(true)
    setAccountsError(null)
    try {
      const res = await api.health.accounts()
      if (res.success) {
        const data = res.data as unknown as LineAccount[]
        setAccounts(data)
        const snapshots = await loadAccountHealthStates(
          data.map((account) => account.id),
          (accountId) => api.health.getHealth(accountId),
        )
        setHealthLogs(Object.fromEntries(
          Object.entries(snapshots).map(([accountId, snapshot]) => [accountId, snapshot.logs]),
        ))
        setConnectionCheckedAt(Object.fromEntries(Object.entries(snapshots).map(([id, snapshot]) => [id, snapshot.checkedAt ?? null])))
        setLatestRisk(Object.fromEntries(
          Object.entries(snapshots).map(([accountId, snapshot]) => [accountId, snapshot.state]),
        ))
      } else {
        setAccountsError(new Error(res.error))
      }
    } catch (caught) {
      setAccountsError(caught)
    } finally {
      setLoading(false)
    }
  }, [])

  const retryAccountHealth = useCallback(async (accountId: string) => {
    setRetryingHealthIds((current) => new Set(current).add(accountId))
    const snapshots = await loadAccountHealthStates(
      [accountId],
      (id) => api.health.getHealth(id),
    )
    const snapshot = snapshots[accountId]
    setHealthLogs((current) => ({ ...current, [accountId]: snapshot.logs }))
    setConnectionCheckedAt((current) => ({ ...current, [accountId]: snapshot.checkedAt ?? null }))
    setLatestRisk((current) => ({ ...current, [accountId]: snapshot.state }))
    setRetryingHealthIds((current) => {
      const next = new Set(current)
      next.delete(accountId)
      return next
    })
  }, [])

  const loadMigrations = useCallback(async () => {
    setMigrationLoadState('loading')
    try {
      const res = await api.health.migrations()
      if (res.success && Array.isArray(res.data)) {
        setMigrations(res.data as AccountMigration[])
        setMigrationLoadState('ready')
      } else {
        setMigrationLoadState('error')
      }
    } catch {
      setMigrationLoadState('error')
    }
  }, [])

  useEffect(() => {
    loadAccounts()
    loadMigrations()
    try {
    } catch {
      // ストレージが使えなくても画面は出せる
    }
  }, [loadAccounts, loadMigrations])

  const handleExpand = (accountId: string) => {
    setExpandedId(expandedId === accountId ? null : accountId)
  }

  const handleMigrate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!migrateFrom || !migrateToId) return
    setMigrating(true)
    try {
      await api.health.migrate(migrateFrom, { toAccountId: migrateToId })
      setMigrateFrom(null)
      setMigrateToId('')
      loadMigrations()
    } catch (caught) {
      // M019：一律の汎用文にせず、403 は権限不足として区別する。
      setError(japaneseDetailOf(caught) || describeApiFailure(caught, '移行', {
        forbidden: '友だちの移行はオーナーだけができます。オーナーの方に操作してもらってください。',
      }))
    } finally {
      setMigrating(false)
    }
  }

  // M019：役割が分かっていて owner でないときは移行の入口を出さない。最終の門はサーバ。
  const canMigrate = role === 'owner'

  const getAccountName = (id: string): string => {
    const account = accounts.find((a) => a.id === id)
    return account?.name || id
  }

  return (
    <div className="flex flex-col gap-4">
      <div><PageHeading title="BAN検知ダッシュボード" /></div>
      {/* カード同士の縦の間隔はこの親の gap-4（16px）だけで作る。子ごとの mb/mt は付けない。 */}

      {/* Error */}
      {error && (
        <Notice tone="danger" message={error} onClose={() => setError('')} className="mb-4" />
      )}

      {/* Loading */}
      {loading ? (
        <div className="bg-canvas rounded-card border border-hairline p-8 text-center text-ink-faint">
          読み込み中…
        </div>
      ) : accountsError !== null ? (
        /*
         * M018：読み込み失敗は「未登録」と出さない。捕まえた失敗を共通部品へ
         * 渡し、再試行口を出す（403 は権限の案内になり、再試行口は出ない）。
         */
        <div className="bg-canvas rounded-card border border-hairline p-8">
          <ListState kind="error" error={accountsError} onRetry={() => void loadAccounts()} />
        </div>
      ) : accounts.length === 0 ? (
        <div className="bg-canvas rounded-card border border-hairline p-8 text-center text-ink-faint">
          <p className="mb-2">LINEアカウントが登録されていません</p>
          <p className="text-xs text-ink-faint">先にアカウント管理からLINEアカウントを登録してください</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Account Health Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {accounts.map((account) => {
              const storedRisk = latestRisk[account.id] ?? 'unknown'
              const isExpanded = expandedId === account.id
              const logs = healthLogs[account.id] || []
              const checkedAt = connectionCheckedAt[account.id] ?? null
              // R168: 最終確認が古いときは、記録上の結果ではなく「確認が止まっている」を出す。
              const stale = storedRisk !== 'unknown' && storedRisk !== 'error' && isStaleCheck(checkedAt)
              const risk: AccountHealthState = stale ? 'stale' : storedRisk
              const config = riskConfig[risk]
              const healthUnavailable = risk === 'unknown' || risk === 'error' || risk === 'stale'

              return (
                <div key={account.id} className="bg-canvas rounded-card border border-hairline overflow-hidden">
                  <button
                    onClick={() => handleExpand(account.id)}
                    className="w-full p-4 text-left hover:bg-canvas-sunken transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {/* ★V7：全員同じ「L」の緑の四角では見分けられないので、他の画面と同じ頭文字の丸にする。 */}
                        <Avatar name={account.name} size={40} />
                        <div>
                          <h3 className="text-sm font-bold text-ink">{account.name}</h3>
                          <p className="text-xs text-ink-faint">チャネル {account.channelId}</p>
                          {/* R168: いつ確かめた結果かを常に出す。 */}
                          <p className="text-xs text-ink-faint">
                            最終確認 {checkedAt ? shortDateTime(checkedAt) : '—'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium px-2.5 py-1 rounded-pill ${config.bgColor} ${config.textColor}`}>
                          <span className={`w-2 h-2 rounded-pill ${config.color} ${risk === 'danger' ? 'animate-pulse' : ''}`} />
                          {config.label}
                        </span>
                        <ChevronDown aria-hidden="true" className={`size-4 text-ink-faint transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </div>
                    </div>
                  </button>

                  {/* Expanded: Health Logs */}
                  {isExpanded && (
                    <div className="border-t border-hairline p-4">
                      {healthUnavailable && (
                        <div className="border-hairline bg-canvas-sunken text-ink-secondary mb-3 rounded-card border p-3 text-sm">
                          <p>
                            {risk === 'error'
                              ? 'ヘルス情報を取得できませんでした。'
                              : risk === 'stale'
                                ? `最後の確認は ${checkedAt ? shortDateTime(checkedAt) : '—'} です。確認が止まっているため、現在の状態は分かりません（最後の結果は「${storedRisk !== 'unknown' && storedRisk !== 'error' && storedRisk !== 'stale' ? riskConfig[storedRisk].label : '—'}」）。`
                                : '接続の確認がまだです。'}
                          </p>
                          <button
                            type="button"
                            onClick={() => void retryAccountHealth(account.id)}
                            disabled={retryingHealthIds.has(account.id)}
                            className="text-action mt-2 text-sm font-medium underline underline-offset-2 disabled:cursor-not-allowed"
                          >
                            {retryingHealthIds.has(account.id) ? '再取得中…' : '再試行'}
                          </button>
                        </div>
                      )}

                      {/* 確認が止まっていても、最後の結果が危険なら移行の入口は残す。 */}
                      {storedRisk === 'danger' && (
                        <div className="mb-3">
                          {/*
                            M019：移行口は owner 専用。押せない役割には
                            ボタンの代わりに理由を出す（最終の門はサーバ）。
                          */}
                          {canMigrate ? (
                            <Button variant="danger" className="px-3 py-1.5 text-xs font-medium border-0 h-auto whitespace-normal" onClick={() => {
                                setMigrateFrom(account.id)
                                setMigrateToId('')
                              }}>
                              友だちを移行する
                            </Button>
                          ) : (
                            <p className="text-xs text-ink-secondary">友だちの移行はオーナーだけができます。</p>
                          )}
                        </div>
                      )}

                      {logs.length > 0 ? (
                        <DataTable>
                            <thead>
                              <TableHeadRow>
                                <Th style={{ width: '20%' }}>エラーコード</Th>
                                <Th style={{ width: '12%' }}>エラー数</Th>
                                <Th style={{ width: '20%' }}>チェック期間</Th>
                                <Th style={{ width: '18%' }}>リスク</Th>
                                <Th style={{ width: '30%' }}>日時</Th>
                              </TableHeadRow>
                            </thead>
                            <tbody>
                              {logs.map((log) => {
                                const logConfig = riskConfig[log.riskLevel]
                                return (
                                  <Tr key={log.id}>
                                    <Td className="font-mono text-ink-secondary">
                                      {log.errorCode !== null ? log.errorCode : '-'}
                                    </Td>
                                    <Td className="text-ink-secondary">{log.errorCount}</Td>
                                    <Td className="text-ink-secondary">{log.checkPeriod}</Td>
                                    <Td>
                                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-pill ${logConfig.bgColor} ${logConfig.textColor}`}>
                                        <span className={`w-1.5 h-1.5 rounded-pill ${logConfig.color} ${log.riskLevel === 'danger' ? 'animate-pulse' : ''}`} />
                                        {logConfig.label}
                                      </span>
                                    </Td>
                                    <Td className="text-ink-faint text-xs">
                                      {formatDateTime(log.createdAt)}
                                    </Td>
                                  </Tr>
                                )
                              })}
                            </tbody>
                        </DataTable>
                      ) : !healthUnavailable ? (
                        <p className="text-sm text-ink-faint text-center py-4">ヘルスログがありません</p>
                      ) : null}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Migration Form Modal */}
          {migrateFrom && (
            <div className="bg-canvas rounded-card border border-danger/30 p-6">
              <h2 className="text-sm font-bold text-ink mb-4">
                友だち移行: {getAccountName(migrateFrom)}
              </h2>
              <form onSubmit={handleMigrate}>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-ink-secondary mb-1">移行先アカウント</label>
                  <EntitySelect size="full"
                    value={migrateToId}
                    onChange={(value) => setMigrateToId(value)}
                    aria-label="移行先アカウント"
                    options={[
                      { value: '', label: '選択してください' },
                      ...accounts
                        .filter((account) => account.id !== migrateFrom && account.isActive)
                        .map((account) => ({ ...entityOptionMetadata(account),
                          value: account.id,
                          label: `${account.name} (${account.channelId})`,
                        })),
                    ]}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button type="submit" variant="primary" disabled={migrating || !migrateToId} busy={migrating} busyLabel="移行中…">移行を開始
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setMigrateFrom(null)
                      setMigrateToId('')
                    }}
                  >
                    キャンセル
                  </Button>
                </div>
              </form>
            </div>
          )}

          {/* Migrations Table */}
          <div>
            <h2 className="text-lg font-bold text-ink mb-4">移行履歴</h2>
            {migrationLoadState === 'loading' ? (
              <div className="border-hairline bg-canvas text-ink-faint rounded-card border p-8 text-center">
                移行履歴を読み込んでいます…
              </div>
            ) : migrationLoadState === 'error' ? (
              <Notice
                tone="danger"
                message="移行履歴を取得できませんでした。"
                action={
                  <Button variant="text" size="inline" data-notice-inline-action
                    type="button"
                    onClick={() => void loadMigrations()}
                  >
                    再読み込み
                  </Button>
                }
              />
            ) : migrations.length === 0 ? (
              <div className="bg-canvas rounded-card border border-hairline p-8 text-center text-caption text-ink-faint">
                移行履歴はありません
              </div>
            ) : (
              <DataTable>
                    <thead>
                      <TableHeadRow>
                        <Th style={{ width: '16%' }}>移行元</Th>
                        <Th style={{ width: '16%' }}>移行先</Th>
                        <Th style={{ width: '14%' }}>ステータス</Th>
                        <Th style={{ width: '24%' }}>進捗</Th>
                        <Th style={{ width: '15%' }}>開始日時</Th>
                        <Th style={{ width: '15%' }}>完了日時</Th>
                      </TableHeadRow>
                    </thead>
                    <tbody>
                      {migrations.map((migration) => {
                        const status = statusConfig[migration.status]
                        const countText = `${formatNumber(migration.migratedCount)} / ${formatNumber(migration.totalCount)} 人`
                        const percent = migration.totalCount > 0
                          ? (migration.migratedCount / migration.totalCount) * 100
                          : 0
                        return (
                          <Tr key={migration.id} interactive>
                            <Td className="text-ink font-medium">
                              {getAccountName(migration.fromAccountId)}
                            </Td>
                            <Td className="text-ink font-medium">
                              {getAccountName(migration.toAccountId)}
                            </Td>
                            <Td>
                              <span className={`inline-flex text-xs font-medium px-2.5 py-1 rounded-pill ${status.bgColor} ${status.textColor}`}>
                                {status.label}
                              </span>
                            </Td>
                            <Td>
                              {/*
                                移行の進みは共通部品 Progress（★V7 xiHO8）で出す。
                                実行中→active、完了→done、失敗→partial（残りは赤の欠け）、
                                待ち→preparing。数は文字でも残す（n / m 人）。
                              */}
                              {migration.status === 'in_progress' ? (
                                <Progress state="active" title="移行中" percent={percent} countText={countText} className="min-w-48" />
                              ) : migration.status === 'completed' ? (
                                <Progress state="done" title="移行が完了しました" note={countText} className="min-w-48" />
                              ) : migration.status === 'failed' ? (
                                <Progress
                                  state="partial"
                                  title={migration.migratedCount > 0 ? `${countText}まで移行し、途中で止まりました` : `移行できませんでした（${countText}）`}
                                  percent={percent}
                                  className="min-w-48"
                                />
                              ) : (
                                <Progress state="preparing" title="移行待ち" note={countText} className="min-w-48" />
                              )}
                            </Td>
                            <Td className="text-ink-faint text-xs">
                              {formatDateTime(migration.createdAt)}
                            </Td>
                            <Td className="text-ink-faint text-xs">
                              {migration.completedAt
                                ? formatDateTime(migration.completedAt)
                                : '-'}
                            </Td>
                          </Tr>
                        )
                      })}
                    </tbody>
              </DataTable>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
