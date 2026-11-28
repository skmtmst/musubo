'use client'

/*
 * 広告とのつなぎ・広告への送信履歴が共通で使う口と言葉。
 * 呼ぶ口は今の画面（app/inflow-links/ad-integration-v8.tsx の useAdV8Model）と同じ
 * （媒体の一覧・送信記録のページ・30日の集計）。対応表（F-21）と送り直し（F-22）を足した。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdEventMapping } from '@line-crm/shared'
import { api, type AdConversionLog, type AdPlatform } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { formatDate as polishFormatDate } from '@/lib/format'


export const AD_PROVIDER_LABEL: Record<string, string> = {
  google: 'Google広告',
  meta: 'Meta広告',
  tiktok: 'TikTok',
  x: 'X（旧Twitter）',
}

export function adPlatformLabel(platform: AdPlatform | undefined): string {
  if (!platform) return '—'
  return Object.prototype.hasOwnProperty.call(AD_PROVIDER_LABEL, platform.name)
    ? AD_PROVIDER_LABEL[platform.name]
    : platform.displayName ?? platform.name
}

/** 送信の状態（絵の札：待っている・送れた・断られた）。 */
export function adLogStatus(status: string): { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' } {
  if (status === 'sent' || status === 'success') return { label: '送れた', tone: 'success' }
  if (status === 'pending') return { label: '待っている', tone: 'info' }
  if (status === 'failed') return { label: '断られた', tone: 'danger' }
  if (status === 'skipped') return { label: '送っていない', tone: 'neutral' }
  return { label: '状態不明', tone: 'neutral' }
}

/** 月/日 時:分（日本時間）。 */
export function adDateTime(iso: string | null | undefined): string {
  return polishFormatDate(iso, { style: 'list', fallback: '—' })
}

export type AdLogSummary = { sentLast30Days: number; pendingLast30Days: number; failedLast30Days: number }

export const AD_LOG_PAGE_SIZE = 20

/** 媒体・送信記録（ページ）・30日の集計を読む。読み直しは reload。 */
export function useAdLogs(options: { page: number; status: string; query: string }) {
  const { selectedAccountId } = useAccount()
  const generationRef = useRef(0)
  const [platforms, setPlatforms] = useState<AdPlatform[]>([])
  const [logs, setLogs] = useState<AdConversionLog[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<AdLogSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const reload = useCallback(async () => {
    const generation = ++generationRef.current
    if (!selectedAccountId) {
      setPlatforms([])
      setLogs([])
      setTotal(0)
      setSummary(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setFailed(false)
    try {
      const [platformRes, logRes] = await Promise.all([
        api.adPlatforms.list(selectedAccountId),
        api.adPlatforms.logsPage({
          page: options.page,
          limit: AD_LOG_PAGE_SIZE,
          status: options.status,
          query: options.query,
          lineAccountId: selectedAccountId,
        }),
      ])
      if (generation !== generationRef.current) return
      if (!platformRes.success || !logRes.success) {
        setFailed(true)
        return
      }
      setPlatforms(platformRes.data)
      setLogs(logRes.data.items)
      setTotal(logRes.data.total)
      setSummary(logRes.data.summary ?? null)
    } catch {
      if (generation === generationRef.current) setFailed(true)
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [selectedAccountId, options.page, options.status, options.query])

  useEffect(() => {
    void reload()
    return () => { generationRef.current += 1 }
  }, [reload])

  /* 集計の口が無い古い返事のときは、読めた行から数える（今の画面と同じ）。 */
  const sentCount = summary?.sentLast30Days ?? logs.filter((log) => log.status === 'sent' || log.status === 'success').length
  const pendingCount = summary?.pendingLast30Days ?? logs.filter((log) => log.status === 'pending').length
  const failedCount = summary?.failedLast30Days ?? logs.filter((log) => log.status === 'failed').length

  return { selectedAccountId, platforms, logs, total, loading, failed, reload, sentCount, pendingCount, failedCount }
}

/** 成果地点ごとの対応（Google・Meta の2行を1行にまとめる）。 */
export type AdMappingRow = {
  pointId: string
  pointName: string
  google: AdEventMapping | null
  meta: AdEventMapping | null
}

export function groupAdMappings(mappings: AdEventMapping[]): AdMappingRow[] {
  const rows = new Map<string, AdMappingRow>()
  for (const mapping of mappings) {
    const row = rows.get(mapping.pointId) ?? { pointId: mapping.pointId, pointName: mapping.pointName, google: null, meta: null }
    row[mapping.provider] = mapping
    rows.set(mapping.pointId, row)
  }
  return [...rows.values()]
}

/** その媒体へ名前を返しているか（結びつけない・名前が無いときは返していない）。 */
export function adMappingReturns(mapping: AdEventMapping | null): boolean {
  return Boolean(mapping && mapping.mode !== 'off' && mapping.eventName)
}
