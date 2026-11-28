'use client'

import { LineChart, FunnelChart } from '@/components/shared/charts'

/*
 * ★V8 ウェビナーの分析（Pencil ）。
 * 頭（戻る・題・説明・CSV）→ タブ → 数の帯 → 「どこで人数が減っているか」→「どこまで見られたか」。
 * その下に、前からある詳しい数字（回別・日別・フォーム）と視聴者コメントを畳んで残す。
 * 口・権限・失敗の扱いは BEHAVIOR.md に記録。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from '@/components/shared/list-navigation'
import { CircleCheck, Download, History, LogIn, Send } from 'lucide-react'
import { PageFrame } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import Disclosure from '@/components/shared/disclosure'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { ApiError, downloadApiFile, webinarApi, type WebinarAnalytics, type WebinarUserComment } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { DetailHead } from './chrome'
import { fmtSec, percent, thisMonthReservations } from './helpers'
import type { DetailChrome, EditContext } from './types'
import styles from './analytics.module.css'
import { formatListDateTime as polishFormatListDateTime } from '@/lib/format'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'

export default function AnalyticsPane({ ctx, chrome }: { ctx: EditContext; chrome: DetailChrome }) {
  const { webinar, analytics, analyticsState } = ctx
  const [permission, setPermission] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading')
  const [permissionRetrying, setPermissionRetrying] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const locked = useRef(false)

  /* 集計の権限と、個人情報を含む CSV の権限は別。許可が確かめられるまで CSV の口を出さない。 */
  useEffect(() => {
    const request = ++generation.current
    setPermission('loading')
    setError('')
    void webinarApi.participants(webinar.id, undefined, 1).then((response) => {
      if (!Array.isArray(response.data.items)) throw new Error('invalid_participants')
      if (request === generation.current) setPermission('ready')
    }).catch((cause) => {
      if (request === generation.current) setPermission(cause instanceof ApiError && cause.status === 403 ? 'denied' : 'error')
    }).finally(() => {
      if (request === generation.current) setPermissionRetrying(false)
    })
    return () => { generation.current += 1 }
  }, [webinar.id, attempt])

  const download = useCallback(() => {
    if (permission !== 'ready' || locked.current) return
    const request = generation.current
    locked.current = true
    setBusy(true)
    setError('')
    void downloadApiFile(webinarApi.participantsCsvUrl(webinar.id), csvFileName("動画セミナー参加者")).catch((cause) => {
      if (request !== generation.current) return
      if (cause instanceof ApiError && cause.status === 403) {
        setPermission('denied')
        setError(permissionDeniedMessage('store'))
      } else setError('CSVを書き出せませんでした。通信を確認して、もう一度お試しください。')
    }).finally(() => {
      locked.current = false
      if (request === generation.current) setBusy(false)
    })
  }, [permission, webinar.id])

  const retryPermission = useCallback(() => {
    if (permission === 'loading' || permissionRetrying) return
    setPermissionRetrying(true)
    setAttempt((value) => value + 1)
  }, [permission, permissionRetrying])

  const csvButton = permission === 'ready' && analyticsState === 'ready'
    ? <Button onClick={download} disabled={busy} busy={busy} busyLabel="書き出しています…"><Download size={16} aria-hidden="true" />CSVで書き出す</Button>
    : null

  const summary = analytics?.summary ?? null
  const analyticsError = analyticsState === 'error'
  const analyticsLoading = analyticsState === 'loading' || (!analytics && !analyticsError)
  const unavailableDetail = analyticsError ? '読み込めませんでした' : analyticsLoading ? '読み込んでいます' : emptyValue('unknown')
  const kpis = [
    { key: 'reservations', title: '申込', icon: History, value: analyticsError ? null : (summary?.reservations ?? null), unit: '人', detail: summary && !analyticsError ? `今月 +${formatNumber(thisMonthReservations(analytics?.daily ?? []))}` : unavailableDetail, help: '予約した人の数です。今月の数はサーバーの集計日（UTC）を基準にしています。' },
    { key: 'viewers', title: '参加', icon: LogIn, value: analyticsError ? null : (summary?.viewers ?? null), unit: '人', detail: summary && !analyticsError ? `申込の ${percent(summary.viewers, summary.reservations)}` : unavailableDetail, help: '入場した人の数です。予約せず直接入場した人も含みます。' },
    { key: 'completed', title: '視聴完了', icon: CircleCheck, value: analyticsError ? null : (summary?.completed ?? null), unit: '人', detail: summary && !analyticsError ? `参加の ${percent(summary.completed, summary.viewers)}` : unavailableDetail, help: '動画の9割以上を実際に見た人です。' },
    { key: 'forms', title: 'フォーム送信', icon: Send, value: analyticsError ? null : (summary?.formSubmissions ?? null), unit: '人', detail: summary && !analyticsError ? `案内ボタンを押した ${formatNumber(summary.ctaClicks)} 人のうち` : unavailableDetail, help: 'フォームを送信した人の数です。同じ人が複数回送信しても1人に数えます。各段の人数差は、同じ人が順番に進んだ割合を表すものではありません。' },
  ]

  return (
    <PageFrame kind="list" boardId="z2dgw">
      <DetailHead {...chrome} current="analytics" actions={csvButton} />
      <div className={styles.stats} data-template-region="stats">
        <KpiBand>
          {kpis.map((kpi) => (
            <KpiCard key={kpi.key} presentation="band" title={kpi.title} icon={<kpi.icon size={16} aria-hidden="true" />} help={kpi.help} loading={analyticsLoading} value={kpi.value} unit={kpi.value === null ? '' : kpi.unit} detail={kpi.detail} />
          ))}
        </KpiBand>
      </div>
      <div className={styles.body} data-wc-pane="analytics">
        {analyticsError ? (
          <Notice tone="info" action={<Button onClick={ctx.retryAnalytics}>もう一度読み込む</Button>}>分析データを読み込めませんでした。通信を確認してください。</Notice>
        ) : !analytics ? (
          <ListState kind="loading" title="分析データを読み込んでいます" />
        ) : (
          <>
            {permission === 'error' || permissionRetrying
              ? <Notice tone="info" action={<Button onClick={retryPermission} disabled={permissionRetrying} busy={permissionRetrying} busyLabel="確認しています…">もう一度読み込む</Button>}>CSVで書き出す権限を確認できませんでした。分析の集計は表示しています。</Notice>
              : error ? <Notice tone="info">{error}</Notice> : null}
            <Funnel summary={analytics.summary} />
            <Retention analytics={analytics} durationSeconds={webinar.durationSeconds} />
            <Details analytics={analytics} />
            <ViewerComments webinarId={webinar.id} />
          </>
        )}
      </div>
    </PageFrame>
  )
}

function Funnel({ summary }: { summary: WebinarAnalytics['summary'] }) {
  const stages = [
    { label: '申込', value: summary.reservations, unit: '人' },
    { label: '参加（入場）', value: summary.viewers, unit: '人' },
    { label: '視聴完了', value: summary.completed, unit: '人' },
    { label: '案内ボタンを押した', value: summary.ctaClicks, unit: '人' },
    { label: 'フォーム送信', value: summary.formSubmissions, unit: '人' },
  ]
  const top = Math.max(1, ...stages.map((stage) => stage.value))
  let biggest = { drop: 0, from: '', to: '' }
  stages.forEach((stage, index) => {
    if (index === 0) return
    const drop = stages[index - 1].value - stage.value
    if (drop > biggest.drop) biggest = { drop, from: stages[index - 1].label, to: stage.label }
  })
  return (
    <section className={styles.card} aria-labelledby="webinar-funnel-title" id="webinar-analytics-funnel">
      <h3 id="webinar-funnel-title" className={styles.cardTitle}>どこで人数が減っているか</h3>
      <p className={styles.cardDesc}>
        {biggest.drop > 0 ? `申込から相談の申込まで。いちばん減っているのは「${biggest.from} → ${biggest.to}」です` : '申込から相談の申込まで。'}
      </p>
      <FunnelChart label="どこで人数が減っているか" items={stages.map((stage,i)=>({key:stage.label,label:stage.label,value:stage.value,detail:i>0?<span>{`${stages[i-1].value>=stage.value?'−':'+'}${formatNumber(Math.abs(stages[i-1].value-stage.value))}`}</span>:undefined}))} />
    </section>
  )
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 「どこまで見られたか」：見ていた人の割合の線と、申し込みボタンを出した時刻の縦線。 */
function Retention({ analytics, durationSeconds }: { analytics: WebinarAnalytics; durationSeconds: number }) {
  const retention = analytics.retention ?? { bucketSeconds: 60, started: 0, points: [] }
  const { bucketSeconds, started, points } = retention
  const ctaAt = analytics.ctaAtSeconds ?? null
  const completed = analytics.summary.completed
  const empty = points.length === 0 || started === 0
  const maxX = Math.max(bucketSeconds, durationSeconds, ctaAt ?? 0, ...points.map((point) => point.atSeconds))
  const rateOf = (viewers: number | null): string => (viewers === null || started <= 0 ? emptyValue('unknown') : `${Math.round((viewers / started) * 100)}%`)
  const at = (sec: number): number | null => points.find((point) => point.atSeconds >= sec)?.viewers ?? null
  const half = durationSeconds > 0 ? at(durationSeconds / 2) : null
  const ctaViewers = ctaAt !== null ? at(ctaAt) : null
  const completedRate = started > 0 ? `${Math.round((completed / started) * 100)}%` : emptyValue('unknown')
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${((point.atSeconds / maxX) * 1000).toFixed(1)} ${((1 - Math.min(point.viewers, started) / Math.max(started, 1)) * 100).toFixed(1)}`)
    .join(' ')
  const ctaPct = ctaAt !== null && ctaAt >= 0 && ctaAt <= maxX ? (ctaAt / maxX) * 100 : null
  return (
    <section className={styles.card} data-gap="wide" aria-labelledby="webinar-retention-title" id="webinar-analytics-retention">
      <h3 id="webinar-retention-title" className={styles.cardTitle}>どこまで見られたか</h3>
      <p className={styles.cardText}>見ていた人の割合の線です。縦線は申し込みボタンを出した時刻。一時停止や隠れている時間は数えていません。</p>
      {empty ? <p className={styles.cardText}>まだ視聴データがありません</p> : (
        <LineChart label={`見ていた人の割合の線。始まりに見ていた${started}人。`} unit="%" maxX={maxX} maxY={100} points={points.map(p=>({x:p.atSeconds,label:fmtClock(p.atSeconds),value:Math.min(p.viewers,started)/started*100}))} marker={ctaAt!==null?{x:ctaAt,label:`${fmtClock(ctaAt)} 申し込みボタンを出した`}:undefined} />
      )}
      <p className={styles.cardText}>
        {`最後まで見た人 ${completedRate}（${formatNumber(completed)} 人）・半分まで ${rateOf(half)}・申し込みボタンを出したとき ${rateOf(ctaViewers)}`}
      </p>
      {(analytics.heartbeatRejects ?? 0) > 0 ? <p className={styles.warn}>異常な報告を{formatNumber(analytics.heartbeatRejects ?? 0)} 件除いています（視聴時間に数えていません）。</p> : null}
    </section>
  )
}

function retentionDetail(analytics: WebinarAnalytics): string | null {
  const { bucketSeconds, started, points } = analytics.retention ?? { bucketSeconds: 60, started: 0, points: [] }
  if (started <= 0 || points.length === 0) return null
  const completed = analytics.summary.completed
  const completedRate = `${Math.round((completed / started) * 100)}%`
  let dropAt: number | null = null
  let dropMax = 0
  for (let index = 0; index + 1 < points.length; index += 1) {
    const lost = points[index].viewers - points[index + 1].viewers
    if (lost > dropMax) {
      dropMax = lost
      dropAt = points[index + 1].atSeconds
    }
  }
  const from = dropAt === null ? null : Math.floor((dropAt - bucketSeconds) / 60)
  const to = dropAt === null ? null : Math.floor(dropAt / 60)
  const dropRange = from === null ? emptyValue('unknown') : from === to ? `${from}分` : `${from}〜${to}分`
  return `始まりに見ていた${formatNumber(started)}人・最後まで見た${formatNumber(completed)}人（${completedRate}）・いちばん離れた所${dropRange}`
}

/** 前から確かめられた詳しい数字。主なグラフの下へ畳んで残す。 */
function Details({ analytics }: { analytics: WebinarAnalytics }) {
  const funnel = analytics.formFunnel
  const retentionSummary = retentionDetail(analytics)
  return (
    <Disclosure size="compact" title="回別・日別とフォームの詳しい数字">
      <div className={styles.details}>
        {retentionSummary ? <p className={styles.cardText}>{retentionSummary}</p> : null}
        <div>
          <h4 className={styles.detailTitle}>開催回ごとの結果</h4>
          {analytics.sessions.length === 0 ? <p className={styles.cardText}>まだ開催回の視聴データがありません。</p> : (
            <DataTable label="項目ごとの到達人数" className={styles.detailTable}>
              <thead><TableHeadRow><Th>開催日時</Th><Th align="right">参加</Th><Th align="right">平均視聴</Th><Th align="right">案内ボタン</Th></TableHeadRow></thead>
              <tbody>{analytics.sessions.map((session) => (
                <Tr key={session.sessionStartAt}>
                  <Td>{polishFormatListDateTime(session.sessionStartAt * 1000)}</Td>
                  <Td align="right">{formatNumber(session.viewers)} 人</Td>
                  <Td align="right">{fmtSec(session.avgWatchedSeconds)}</Td>
                  <Td align="right">{`${formatNumber(session.ctaClicks)} 人（${percent(session.ctaClicks, session.viewers)}）`}</Td>
                </Tr>
              ))}</tbody>
            </DataTable>
          )}
        </div>
        <div>
          <h4 className={styles.detailTitle}>日別の結果</h4>
          {analytics.daily.length === 0 ? <p className={styles.cardText}>まだ日別のデータがありません。</p> : (
            <DataTable label="項目ごとの到達人数" className={styles.detailTable}>
              <thead><TableHeadRow><Th>日付</Th><Th align="right">申込</Th><Th align="right">参加</Th><Th align="right">案内ボタン</Th><Th align="right">送信</Th></TableHeadRow></thead>
              <tbody>{analytics.daily.map((day) => (
                <Tr key={day.date}><Td>{day.date}</Td><Td align="right">{formatNumber(day.reservations)}</Td><Td align="right">{formatNumber(day.viewers)}</Td><Td align="right">{formatNumber(day.ctaClicks)}</Td><Td align="right">{formatNumber(day.formSubmissions)}</Td></Tr>
              ))}</tbody>
            </DataTable>
          )}
        </div>
        <div>
          <h4 className={styles.detailTitle}>フォームの到達</h4>
          {funnel ? (
            <>
            <dl className={styles.reach}>
              {([
                ['案内ボタンの表示', funnel.ctaImpressions], ['案内ボタンを押した', funnel.ctaClicks], ['フォームを開いた', funnel.formOpens],
                ['入力を始めた', funnel.formStarts], ['送信を試みた', funnel.submitAttempts], ['送信できた', funnel.submitSuccesses], ['送信エラー', funnel.submitErrors],
              ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatNumber(Number(value))} 人</dd></div>)}
            </dl>
            {(funnel.fieldCompletions ?? []).length > 0 ? <DataTable label="項目ごとの到達人数" className={styles.detailTable}>
              <thead><TableHeadRow><Th>項目</Th><Th align="right">到達人数</Th></TableHeadRow></thead>
              <tbody>{funnel.fieldCompletions.map((field) => <Tr key={field.fieldName}><Td><span title={field.fieldName}>{field.fieldName}</span></Td><Td align="right">{formatNumber(field.users)} 人</Td></Tr>)}</tbody>
            </DataTable> : null}
            </>
          ) : <p className={styles.cardText}>フォームの集計を取得できていません。</p>}
        </div>
      </div>
    </Disclosure>
  )
}

/** 視聴者コメント。取得の失敗で分析を消さない。 */
function ViewerComments({ webinarId }: { webinarId: string }) {
  const [comments, setComments] = useState<WebinarUserComment[] | null>(null)
  const [error, setError] = useState('')
  const [denied, setDenied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const inFlight = useRef(false)
  useEffect(() => {
    let active = true
    inFlight.current = true
    setLoading(true)
    setComments(null)
    setError('')
    setDenied(false)
    void webinarApi.userComments(webinarId).then((response) => {
      if (!Array.isArray(response.data)) throw new Error('invalid_comments')
      if (active) setComments(response.data)
    }).catch((cause) => {
      if (!active) return
      const isDenied = cause instanceof ApiError && cause.status === 403
      setDenied(isDenied)
      setError(isDenied ? permissionDeniedMessage('store') : '視聴者コメントを読み込めませんでした。')
    }).finally(() => {
      if (active) {
        inFlight.current = false
        setLoading(false)
      }
    })
    return () => { active = false }
  }, [webinarId, attempt])
  const retry = () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setAttempt((count) => count + 1)
  }
  const hint = comments ? `${formatNumber(comments.length)}件` : error ? (denied ? '権限なし' : '読み込めませんでした') : loading ? '読み込み中' : emptyValue('unknown')
  return (
    <Disclosure size="compact" title="視聴者コメント" hint={hint}>
      {error ? <Notice tone="danger" action={<> <Button size="compact" onClick={retry} disabled={loading} busy={loading}>もう一度読み込む</Button> </>} >{error}</Notice>
        : comments === null ? <p role="status" className={styles.cardText}>コメントを読み込んでいます…</p>
          : comments.length === 0 ? <p className={styles.cardText}>まだコメントはありません。</p>
            : (
              <ul className={styles.comments}>
                {comments.map((comment) => {
                  const name = comment.friendName ?? `友だち ${comment.friendId.slice(0, 6)}`
                  return (
                    <li key={comment.id}>
                      <Link href={`/chats?friend=${encodeURIComponent(comment.friendId)}`} className={styles.commentName}>{`${name}・${fmtSec(comment.atSeconds)}`}</Link>
                      <p className={styles.cardText}>{comment.body}</p>
                    </li>
                  )
                })}
              </ul>
            )}
    </Disclosure>
  )
}
