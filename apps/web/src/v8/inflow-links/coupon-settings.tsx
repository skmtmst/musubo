'use client'
import { RadioCardGroup } from '@/components/shared/radio-card'

import { useEffect, useState } from 'react'
import { couponDate, couponPayloadError } from '@line-crm/shared'
import { api, type BroadcastMessageAsset } from '@/lib/api'
import { CardHeader } from '@/components/shared/card'
import { Field } from '@/components/shared/form-controls'
import Toggle from '@/components/shared/toggle'
import Radio from '@/components/shared/radio'
import { Ticket } from 'lucide-react'
import HelpTip from '@/components/shared/help-tip'
import StatusBadge from '@/components/shared/status-badge'
import ListState from '@/components/shared/list-state'
import styles from './new/create.module.css'
import { EntityPickerDialog, EntityPickerSummary } from '@/components/shared/entity-picker'

export type CouponSettingsValue = { couponEnabled: boolean; couponAssetId: string | null; couponAudience: 'new_friends' | 'all_friends' }

/** 作成と編集で同じ設定を使う。未公開・期限外・別の店の候補は渡さない。 */
export default function CouponSettings({ accountId, value, onChange, onOptionsLoaded, disabled = false }: {
  accountId?: string | null; value: CouponSettingsValue; onChange: (next: CouponSettingsValue) => void; onOptionsLoaded?: (items: BroadcastMessageAsset[]) => void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<BroadcastMessageAsset[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setOpen(false); setItems([]); setState('loading')
    if (!value.couponEnabled || !accountId) return
    void api.broadcastMessageAssets.list({ accountId, kind: 'coupon' }).then((response) => {
      if (!current) return
      if (!response.success) throw new Error('unavailable')
      const now = Date.now()
      const eligible = response.data.filter((item) => {
        const payload = item.publishedPayload ?? item.payload
        return item.lineAccountId === accountId && (item.publishedVersion ?? 0) > 0
          && !couponPayloadError(payload) && now >= couponDate(payload.startsAt as string) && now < couponDate(payload.endsAt as string)
      })
      setItems(eligible)
      onOptionsLoaded?.(eligible)
      setState('ready')
    }).catch(() => { if (current) setState('error') })
    return () => { current = false }
  }, [accountId, value.couponEnabled, attempt, onOptionsLoaded])
  const selected = items.find((item) => item.id === value.couponAssetId)
  const payload = selected?.publishedPayload ?? selected?.payload
  return <>
    <CardHeader size="stacked" title="読み取った人にクーポンを渡す" meta="LINE公式の「クーポンQRコード」と同じ。友だち追加のあと、トークにクーポンが届きます" help={<HelpTip label="クーポンを渡す条件の説明">1人1回だけ渡します。同じ人が何度読み取っても、2枚目は渡しません。すでに友だちの人にも渡す設定では、読み取るとクーポンの画面が開きます。</HelpTip>} />
    {/* 絵 QUF2R：スイッチは左、名前を横に。オンのときだけ右に「クーポン付き QR」。 */}
    <div className={styles.couponSwitchRow}>
      <Toggle checked={value.couponEnabled} disabled={disabled} label="クーポンを渡す"
        onChange={(couponEnabled) => onChange({ ...value, couponEnabled })} />
      <span className={styles.couponSwitchLabel} aria-hidden="true">クーポンを渡す</span>
      {value.couponEnabled ? <StatusBadge tone="warning" dot={false} size="compact"><Ticket size={16} aria-hidden="true" />クーポン付き QR</StatusBadge> : null}
    </div>
    {value.couponEnabled ? <>
      <Field label="渡すクーポン" required note={selected ? undefined : '公開中で、利用期間内のクーポンを選んでください。'}>
        <EntityPickerSummary label="渡すクーポン" noun="クーポン" icon={Ticket} valuePrefix="クーポン"
          name={selected?.name} meta={selected ? `${String(payload?.description ?? '')}・期限 ${String(payload?.endsAt ?? '')}` : undefined}
          ariaLabel={selected ? 'クーポンを変更する' : 'クーポンを選択する'} disabled={disabled || !accountId} onOpen={() => setOpen(true)} />
      </Field>
      <Field label="渡す相手">
        <RadioCardGroup className={styles.couponAudience} legend="渡す相手">
          {([['new_friends', '新しく友だちになった人だけ'], ['all_friends', 'すでに友だちの人にも']] as const).map(([key, text]) => (
            <Radio key={key} name="coupon-audience" value={key} checked={value.couponAudience === key} disabled={disabled}
              onChange={() => onChange({ ...value, couponAudience: key })}>{text}</Radio>
          ))}
        </RadioCardGroup>
      </Field>
      {/* 決まり2: 渡す条件の説明は帯にせず、題の横の「？」へ入れる。 */}
      {open ? <EntityPickerDialog title="クーポンを選ぶ" initialId={value.couponAssetId ?? undefined}
        items={items.map((item) => ({ id: item.id, name: item.name, meta: `${String((item.publishedPayload ?? item.payload).description ?? '')}・期限 ${String((item.publishedPayload ?? item.payload).endsAt ?? '')}` }))}
        state={state === 'loading' ? <ListState kind="loading" /> : state === 'error' ? <ListState kind="error" title="クーポンを読み込めませんでした" onRetry={() => setAttempt((n) => n + 1)} /> : undefined}
        onConfirm={(couponAssetId) => { onChange({ ...value, couponAssetId }); setOpen(false) }} onCancel={() => setOpen(false)} /> : null}
    </> : null}
  </>
}
