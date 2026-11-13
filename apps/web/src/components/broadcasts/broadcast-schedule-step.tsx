'use client'

import { type BroadcastStepKey } from '@/components/broadcasts/broadcast-steps'
import Button from '@/components/shared/button'
import TextLink from '@/components/shared/text-link'
import Checkbox from '@/components/shared/checkbox'
import DateField from '@/components/shared/date-field'
import { TimeField } from '@/components/shared/date-time-field'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { type TargetMode } from '@/lib/broadcast-audience'
import { formatDay,formatNumber } from '@/lib/format'
import { BroadcastAbSettings } from '@/v8/broadcast-ab/public/settings/index'
import { useBroadcastAb } from '@/v8/broadcast-ab/public/use-ab/index'
import type { Dispatch,SetStateAction } from 'react'
import type { BroadcastSendMode, BroadcastSendChoice, BroadcastSpreadStart } from './broadcast-schedule'
import { formatScheduleTime } from './broadcast-form-model'
import styles from './broadcast-form-v8.module.css'
import { TextField as SharedTextField } from '@/components/shared/text-field'

type BroadcastScheduleStepContext = {
  limitToQuota: boolean
  setLimitToQuota: Dispatch<SetStateAction<boolean>>
  recipientLimitInput: string
  setRecipientLimitInput: Dispatch<SetStateAction<string>>
  selectedAccountId: string | null
  onRetryQuota: () => void
  ab: ReturnType<typeof useBroadcastAb>
  approvalConfig: { threshold: number; singleOperator: boolean; } | null
  audienceCount: number | null
  concurrentBroadcasts: { id: string; title: string; scheduledAt: string; }[]
  goToStep: (step: BroadcastStepKey) => void | undefined
  measureOpens: boolean
  quota: { unlimited?: boolean; monthlyUsed: number | null; monthlyLimit: number | null; remaining: number | null; planned: number; state: "available" | "insufficient" | "unavailable"; reason: string | null; } | null
  quotaInsufficient: boolean
  scheduledAtIso: () => string | null
  scheduledDate: string
  scheduledTime: string
  sendMode: BroadcastSendMode
  sendChoice: BroadcastSendChoice
  setSendChoice: Dispatch<SetStateAction<BroadcastSendChoice>>
  spreadStartMode: BroadcastSpreadStart
  setSpreadStartMode: Dispatch<SetStateAction<BroadcastSpreadStart>>
  setMeasureOpens: Dispatch<SetStateAction<boolean>>
  setScheduledDate: Dispatch<SetStateAction<string>>
  setScheduledTime: Dispatch<SetStateAction<string>>
  setSpreadMinutes: Dispatch<SetStateAction<string>>
  shows: (step: BroadcastStepKey) => boolean
  spreadMinutes: string
  targetMode: TargetMode
}

export function BroadcastScheduleStep({ limitToQuota, setLimitToQuota, recipientLimitInput, setRecipientLimitInput, selectedAccountId, onRetryQuota, ab, approvalConfig, audienceCount, concurrentBroadcasts, goToStep, measureOpens, quota, quotaInsufficient, scheduledAtIso, scheduledDate, scheduledTime, sendMode, sendChoice, setSendChoice, spreadStartMode, setSpreadStartMode, setMeasureOpens, setScheduledDate, setScheduledTime, setSpreadMinutes, shows, spreadMinutes, targetMode }: BroadcastScheduleStepContext) {
  return (<section id="broadcast-step-schedule" className={shows('schedule') ? styles.section : 'hidden'}>
          <h3>配信日</h3>
          <SaveErrorField names={["broadcast-send-mode","sendMode","spreadMinutes"]}><RadioCardGroup legend="配信日" className={styles.methodCards}>
            <RadioCard name="broadcast-send-mode" value="now" checked={sendChoice === 'now'} onChange={() => setSendChoice('now')} title="今すぐ配信" note="最終確認で送ると、すぐに届きます" />
            <RadioCard name="broadcast-send-mode" value="scheduled" checked={sendChoice === 'scheduled'} onChange={() => setSendChoice('scheduled')} title="日時を指定して予約" note="決めた日時に送ります" />
            <RadioCard name="broadcast-send-mode" value="spread" checked={sendChoice === 'spread'} onChange={() => setSendChoice('spread')} title="時間を分散して送る" note="少しずつ送り、集中を避けます" />
          </RadioCardGroup></SaveErrorField>
          {sendChoice === 'spread' && <RadioCardGroup legend="分散を始めるタイミング" legendVisible columns={2}>
            <RadioCard name="broadcast-spread-start" value="scheduled" checked={spreadStartMode === 'scheduled'} onChange={() => setSpreadStartMode('scheduled')} title="開始日時を指定する" variant="row" />
            <RadioCard name="broadcast-spread-start" value="now" checked={spreadStartMode === 'now'} onChange={() => setSpreadStartMode('now')} title="送信を確定してから始める" variant="row" />
          </RadioCardGroup>}
          {sendMode === 'scheduled' && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="bc-date" className="text-ink-secondary mb-1 block text-xs font-medium">
                  配信日（日本時間）
                </label>
                <SaveErrorField names={["scheduledDate","scheduled_date","scheduledAt","scheduled_at"]}><DateField
                  id="bc-date"
                  value={scheduledDate}
                  onChange={setScheduledDate}
                  aria-label="配信日（日本時間）"
                /></SaveErrorField>
              </div>
              <div>
                <label htmlFor="bc-time" className="text-ink-secondary mb-1 block text-xs font-medium">
                  時刻（日本時間）
                </label>
                <SaveErrorField names={["scheduledTime","scheduled_time"]}><TimeField
                  id="bc-time"
                  size="field"
                  value={scheduledTime}
                  onChange={setScheduledTime}
                  aria-label="時刻（日本時間）"
                /></SaveErrorField>
              </div>
              {/*
                設計 `Bw0zt` の注意書き。予約は条件を保存するだけで、実際の
                宛先は**予約の時刻に条件をもう一度あてて**決まる
                （`services/broadcast.ts` の cron が `buildSegmentQuery` を
                その場で組み直す）。いま出ている人数のまま固定されると
                思われると、増減したときに「数が合わない」と読まれる。

                **送信枠には触れない。** 残り通数を読む口がこの画面には無く、
                「送信枠も再確認します」と書くと出せない数を約束することになる。
              */}
              <Notice tone="warn" className="sm:col-span-2">
                予約した時刻に、そのときの条件でもう一度対象を数え直してから送ります。
                いま出ている人数から増減することがあります。
              </Notice>
            </div>
          )}

          {sendChoice === 'spread' && <div className="border-hairline mt-4 border-t pt-4">
      <label htmlFor="bc-spread" className="text-ink-secondary mb-1 block text-sm font-medium">
        分散する時間 <HelpTip label="分散して送る時間の説明">一度に大量に送るとLINEの制限を受けることがあります。少しずつ配り、途中で止まっても同じ人には二度届けません。</HelpTip>
      </label>
      <div className="flex items-center gap-1.5">
        <SaveErrorField names={["spreadMinutes","spread_minutes"]}><SharedTextField
          id="bc-spread"
          type="number"
          min={1}
          max={720}
          value={spreadMinutes}
          onChange={(e) => setSpreadMinutes(e.target.value)}
          className="border-hairline rounded-control w-24 border px-3 py-2 text-sm tabular-nums"
        /></SaveErrorField>
        <span className="text-ink-faint text-xs">分かけて</span>
      </div>
      <p className="text-ink-faint mt-1 text-xs leading-relaxed">
        {sendMode === 'scheduled' ? '指定した日時から' : '最終確認で送信を確定してから'}、この分数をかけて少しずつ送ります。
      </p>
          </div>}
          <div className={styles.quota}>
            <div className={styles.quotaHead}><strong>送信枠</strong><HelpTip label="送信枠の説明">LINE公式アカウントの月間送信枠です。テスト送信も枠を使用します</HelpTip><span>今月 残り {quota?.unlimited ? '上限未設定' : `${quota?.remaining == null ? '—' : formatNumber(quota.remaining)}通`}</span></div>
            <div className={styles.quotaTrack}><div style={{ width: quota?.monthlyLimit ? `${Math.min(100, ((quota.monthlyUsed ?? 0) + quota.planned) / quota.monthlyLimit * 100)}%` : '0%' }} /></div>
            <p>{quota?.monthlyUsed == null || quota.monthlyLimit == null ? '送信枠は配信前チェックで確認します' : `使った ${formatNumber(quota.monthlyUsed)} + 今回 ${formatNumber(quota.planned)} / 上限 ${formatNumber(quota.monthlyLimit)}通`}</p>
            {quota?.state === 'unavailable' && <Notice tone="warn">{quota.reason ?? 'LINEから送信枠を確認できませんでした。'}{' '}<TextLink inline href={selectedAccountId ? `/accounts/detail?id=${encodeURIComponent(selectedAccountId)}` : '/accounts'}>LINEの接続設定を見る</TextLink>{' '}<Button variant="text" onClick={onRetryQuota}>もう一度確認する</Button></Notice>}
            {quotaInsufficient && <p className="text-danger">送信枠が不足しています。配信する人数を減らしてください</p>}
          </div>
          <SaveErrorField names={["deliveryLimit","messageOptions"]}>
            <section className="mt-4 space-y-3">
              <h4 className="text-sm font-semibold text-ink">送る人数の上限</h4>
              <Checkbox checked={limitToQuota} onCheckedChange={setLimitToQuota}>残りの送信枠まで送る（無作為）</Checkbox>
              <div><label htmlFor="bc-recipient-limit" className="mb-1 block text-sm text-ink-secondary">上限人数（任意）</label><SharedTextField id="bc-recipient-limit" type="number" min={1} step={1} value={recipientLimitInput} onChange={event=>setRecipientLimitInput(event.target.value)} placeholder="指定しなければ全員" /></div>
              {(limitToQuota || recipientLimitInput.trim()) && <Notice tone="info">条件に合い、配信を受け取れる人から無作為に選びます。予約後に枠が増えても、最後に確認した人数を超えて送りません。途中で止まっても選び直しません。</Notice>}
            </section>
          </SaveErrorField>
          <SaveErrorField names={["measureOpens","measure_opens"]}><Checkbox checked={measureOpens} onCheckedChange={setMeasureOpens}>開封数の集計を取る</Checkbox></SaveErrorField>
          {sendMode === 'scheduled' && (
            <section className="mt-4 rounded-control border border-hairline p-4">
              <h4 className="text-sm font-bold text-ink">配信スケジュール</h4>
              <p className="mt-1 text-xs text-ink-faint">前後の配信と重ならないかを確認します。</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                {[-1, 0, 1, 2].map((offset) => {
                  const base = scheduledDate ? new Date(`${scheduledDate}T00:00:00+09:00`) : null
                  if (base) base.setDate(base.getDate() + offset)
                  const ymd = base ? formatDay(base) : '日付未設定'
                  const concurrent = offset === 0 ? concurrentBroadcasts : []
                  return <div key={offset} className={`rounded-control border p-3 text-xs ${offset === 0 ? 'border-accent bg-accent-soft' : 'border-hairline'}`}><p className="font-semibold text-ink">{ymd}{offset === 0 ? ' 今回' : ''}</p>{concurrent.length ? concurrent.map((item) => <p key={item.id} className="mt-2 truncate text-ink-secondary" title={item.title}>{formatScheduleTime(item.scheduledAt)}　{item.title}</p>) : <p className="mt-2 text-ink-faint">予定なし</p>}</div>
                })}
              </div>
              {concurrentBroadcasts.length > 0 && <Notice tone="warn">同じ時刻の前後1時間に別の配信があります。対象が重なる場合は、間隔を空けてください。</Notice>}
            </section>
          )}
          <BroadcastAbSettings ab={ab} total={audienceCount} targetAll={targetMode === 'all'} start={new Date(scheduledAtIso() ?? Date.now())} approvalThreshold={approvalConfig?.threshold ?? null} ecConnected canEdit onNarrow={() => goToStep('audience')} />
        </section>)
}
