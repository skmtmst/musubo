'use client'

import { Info } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import Toggle from '@/components/shared/toggle'
import { formatNumber } from '@/lib/format'
import type { AbMetric, AbUndecided } from './api'
import { AB_DECIDE_HOURS, AB_MIN_TOTAL, AB_RATIOS, METRIC_WORD, UNDECIDED_WORD, abBlockedReason, decideTime, hm } from './model'
import type { BroadcastAb } from './use-ab'
import styles from './ab.module.css'

/*
 * ④ 送信設定の段「A/B で試す」（★V8 cM35y・要件 G1 §2-2・AB-02・AB-08・AB-09・AB-20）。
 * 初期オフ。全員への配信・2,000 人未満は使えない（理由と行き先を出す）。説明は見出しの「？」。
 */
export default function BroadcastAbSettings({ ab, total, targetAll, start, approvalThreshold, ecConnected, canEdit, onNarrow }: {
  ab: BroadcastAb
  total: number | null
  targetAll: boolean
  /** 送り始め（予約の日時。すぐ送るなら今）。 */
  start: Date
  approvalThreshold: number | null
  /** EC がつながっていない店は「購入」を選べない（理由つき）。 */
  ecConnected: boolean
  canEdit: boolean
  onNarrow: () => void
}) {
  if (!ab.hasB) return null
  const blocked = abBlockedReason(targetAll, total, true)
  const on = ab.enabled && blocked === null
  const half = ab.settings.testRatioPct / 2
  const decideAt = decideTime(start, ab.settings.decideAfterMinutes)
  const set = <K extends keyof typeof ab.settings>(key: K, value: (typeof ab.settings)[K]) => ab.setSettings({ ...ab.settings, [key]: value })
  return (
    <Card as="section" className={styles.settingsCard} contentPadding="var(--ab-pad)" data-on={on || undefined} aria-labelledby="ab-settings-title" data-design-node="cM35y">
      <div className={styles.settingsHead}>
        <h3 id="ab-settings-title" className={styles.title}>A/B で試す</h3>
        <HelpTip label="A/B で試すの説明">A 案・B 案を一部の人に試し、勝った方を残りの人へ送ります。2 つの割合の差が確からしさ 95% 以上・1 ポイント以上のときだけ勝ちを決め、そうでなければ「決められない」として送りません。試す人は無作為で、同じ人には 1 つの案だけ届きます。</HelpTip>
        <span className={styles.spacer} />
        {canEdit && blocked === null ? <Toggle label="A/B で試す" checked={ab.enabled} onChange={ab.setEnabled} /> : null}
      </div>
      {on ? <Notice tone="warn" appearance="soft">検証環境で設定がオンのとき、登録したテスト宛先だけに送ります。人数が足りないときは勝ちを決めず、自動では残りへ送りません。</Notice> : null}
      {blocked === 'all' ? (
        <Notice tone="warn" appearance="soft" action={canEdit ? <Button onClick={onNarrow}>絞り込みにする</Button> : undefined}>全員への配信ではA/Bを使えません。</Notice>
      ) : blocked === 'few' ? (
        <Notice tone="warn" appearance="soft">{`A/Bは送信未対応です。対象条件は ${formatNumber(AB_MIN_TOTAL)} 人以上です（今 ${formatNumber(total ?? 0)} 人）。`}</Notice>
      ) : on ? (
        <>
          <div className={styles.settingsGrid}>
            <div className={styles.column}>
              <span className={styles.label}>試す割合</span>
              <div className={styles.ratioBar} aria-hidden="true">
                <span className={styles.ratioA} style={{ flexBasis: `${half}%` }}>{`A ${half}%`}</span>
                <span className={styles.ratioB} style={{ flexBasis: `${half}%` }}>{`B ${half}%`}</span>
                {ab.settings.testRatioPct < 50 ? <span className={styles.ratioRest}>{`残り ${100 - ab.settings.testRatioPct}%`}</span> : null}
              </div>
              <Select aria-label="試す割合" size="full" value={String(ab.settings.testRatioPct)} onChange={(value) => set('testRatioPct', Number(value) as typeof ab.settings.testRatioPct)}
                options={AB_RATIOS.map((pct) => ({ value: String(pct), label: pct >= 50 ? '試す割合：50%（テスト宛先を半分ずつ）' : `試す割合：${pct}%（人数は最終確認で表示）` }))} />
            </div>
            <div className={styles.column}>
              <RadioCardGroup legend="勝ちの決め方" legendVisible className={styles.metricRow}>
                {(['click', 'booking', 'purchase'] as AbMetric[]).map((metric) => (
                  <RadioCard key={metric} variant="row" name="ab-metric" value={metric} checked={ab.settings.metric === metric} onChange={() => set('metric', metric)} title={METRIC_WORD[metric]}
                    disabled={metric !== 'click'} disabledReason={metric === 'purchase' && !ecConnected ? 'EC がつながっていません' : metric !== 'click' ? '現在はクリックのみ選べます' : undefined} />
                ))}
              </RadioCardGroup>
              <Select aria-label="決めるまでの時間" size="full" value={String(ab.settings.decideAfterMinutes)} onChange={(value) => set('decideAfterMinutes', Number(value))}
                options={AB_DECIDE_HOURS.map((hours) => ({ value: String(hours * 60), label: `決めるまで：${hours} 時間（${hm(decideTime(start, hours * 60))} に残りへ）` }))} />
              <Select aria-label="決まらないとき" size="full" value={ab.settings.undecidedPolicy} onChange={(value) => set('undecidedPolicy', value as AbUndecided)}
                options={(['stop', 'send_a'] as AbUndecided[]).map((policy) => ({ value: policy, label: `決まらないとき：${UNDECIDED_WORD[policy]}` }))} />
            </div>
          </div>
          {approvalThreshold !== null && total !== null && total >= approvalThreshold ? (
                <Notice tone="info" icon={<Info aria-hidden="true" />}>
                  {`${formatNumber(approvalThreshold)} 人以上の配信なので、送る前に承認が要ります。承認は 1 回で、試しと残りの両方を送れます。`}
                  {ab.settings.undecidedPolicy === 'stop' ? '決まらないときは 24 時間お待ちし、選ばなければ送らずに終えます。' : ''}
                </Notice>
          ) : (
                  <Notice tone="info" icon={<Info aria-hidden="true" />}>
                    {`${hm(decideAt)} に結果を確認します。人数が足りなければ自動送信しません。決まらないときは${ab.settings.undecidedPolicy === 'stop' ? '止めて知らせ、24 時間選ばなければ送らずに終えます' : ' A 案を送ります'}。夜の静かな時間（21〜8 時）にかかるときは 8:00 に送ります。`}
                  </Notice>
          )}
        </>
      ) : null}
    </Card>
  )
}

/** 送る前の確かめの窓に足す 1 行（★V8 a5r5Wg）。 */
export function abConfirmLine(ab: BroadcastAb, total: number | null, start: Date): string | null {
  if (!ab.enabled || total === null) return null
  void start
  return '検証環境のテスト宛先だけへ試験送信します。人数不足なら勝ちを決めず、残りへ自動送信しません。'
}
