'use client'
import { knownValue } from '@/lib/known-value'

import { useEffect, useState } from 'react'
import { FunnelChart } from '@/components/shared/charts'
import Card from '@/components/shared/card'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SectionHeader from '@/components/shared/section-header'
import { api, ApiError, type OpsDashboardPeriod, type OpsFirstRunFunnel, type OpsFirstRunStage } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { opsErrorMessage } from '@/components/ops/ops-ui'
import { useOpsReadOnly } from '../use-ops-read-only'
import parts from '../parts.module.css'

/**
 * 最初の 10 分の全アカウントのまとめ。期間（アカウントを作った日）ごとの数と割合だけを出す。
 * 閲覧のみの運営メンバーには出さない。代理ログイン中は口が 403 を返すので、段ごと隠す。
 */

const STAGE_LABELS: Record<OpsFirstRunStage, string> = {
  started: 'アカウントを作った',
  style: 'スタイルを選んだ',
  starter: '初期セットが入った',
  follow: '最初の友だち追加',
  firstMessage: '最初の1通が届いた',
}

export const firstRunStageWord = (stage: string) => knownValue(STAGE_LABELS, stage, '段を確認できません')

const HELP = '期間にアカウントを作った新しいお店の数です（運営自身と保管したアカウントは入れません）。'
  + '友だち追加は LINE から届いた友だち追加の記録だけを数え、取り込んだ友だちは入れません。'
  + 'じょうごの各段は、前の地点が全部そろったお店だけを数えます。'
  + '「6段を全部」の LINE をつなぐ段は、稼働中で LINE のシークレットがあるかだけを見ます（Webhook は問い合わせません）。'

function minutes(value: number | null): string {
  return value === null ? '—' : `${formatNumber(value)} 分`
}

/** 段の右の 1 行。1 段目は全体の割合、2 段目からは前の段からの割合とかかった分の中央値。 */
function stageDetail(stage: OpsFirstRunFunnel['stages'][number]): string {
  if (stage.fromPrevious === null) return `${stage.percent}%`
  return `前から ${stage.fromPrevious}%・中央値 ${minutes(stage.minutesFromPrevious)}`
}

export default function OpsFirstRunCard({ period }: { period: OpsDashboardPeriod }) {
  const readOnly = useOpsReadOnly()
  const [data, setData] = useState<OpsFirstRunFunnel | null>(null)
  const [error, setError] = useState('')
  const [hidden, setHidden] = useState(false)

  const [attempt, setAttempt] = useState(0)

  // 期間を切り替えた後に、前の期間の答えで上書きしない。
  useEffect(() => {
    if (readOnly) return
    let active = true
    setError('')
    setData(null)
    api.ops.firstRun(period).then(
      (res) => {
        if (!active) return
        if (res.success) setData(res.data)
        else setError(res.error || '読み込めませんでした')
      },
      (failure: unknown) => {
        if (!active) return
        if (failure instanceof ApiError && failure.status === 403) setHidden(true)
        else setError(failure instanceof ApiError ? opsErrorMessage(failure) : '読み込めませんでした')
      },
    )
    return () => { active = false }
  }, [period, readOnly, attempt])

  if (readOnly || hidden) return null

  return (
    <Card aria-label="最初の10分" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
      <SectionHeader title="最初の10分（新しいお店）" help={HELP} helpLabel="最初の10分の数え方" />
      {error ? (
        <ListState permissionScope="hq" kind="error" title="最初の10分を表示できませんでした" description={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !data ? (
        <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />
      ) : data.accounts === 0 ? (
        <ListState permissionScope="hq" kind="empty" title={`${data.periodLabel}に作られたアカウントはまだありません`} />
      ) : (
        <>
          <KpiBand density="compact">
            <KpiCard title="最初の1通まで（中央値）" valueText={minutes(data.minutesToFirstMessage.median)} icon={null} presentation="band" value={null} unit="" detail={null} />
            <KpiCard title="最初の1通まで（75%点）" valueText={minutes(data.minutesToFirstMessage.p75)} icon={null} presentation="band" value={null} unit="" detail={null} />
            <KpiCard title="10分以内に届いた" valueText={`${data.withinTenMinutesPercent}%`} icon={null} presentation="band" value={null} unit="" detail={null} />
            <KpiCard title="6段を全部終えた" valueText={`${data.allStepsDone.percent}%`} icon={null} presentation="band" value={null} unit="" detail={null} />
          </KpiBand>
          {data.biggestDrop ? (
            <Notice tone="warn">{`いちばん落ちている段：${firstRunStageWord(data.biggestDrop.key)}（前の段から ${data.biggestDrop.fromPrevious}%・${formatNumber(data.biggestDrop.lost)} 件がここで止まっています）`}</Notice>
          ) : null}
          <FunnelChart
            label="最初の10分の段ごとの数"
            unit="件"
            items={data.stages.map((stage) => ({ key: stage.key, label: firstRunStageWord(stage.key), value: stage.count, detail: <span>{stageDetail(stage)}</span> }))}
          />
          <p className={parts.note}>{`${data.periodLabel}に作られたアカウント ${formatNumber(data.accounts)} 件・最初の1通まで届いた ${formatNumber(data.minutesToFirstMessage.reached)} 件で数えています`}</p>
        </>
      )}
    </Card>
  )
}
