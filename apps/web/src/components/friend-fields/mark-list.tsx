'use client'

import { useEffect, useRef } from 'react'

import type { SupportMarkArchiveImpact, SupportMarkListItem } from '@/lib/api'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { formatNumber } from '@/lib/format'

type MarkRow = SupportMarkListItem

export function autoRuleLabel(mark: MarkRow): string {
  if (mark.automationRules.length > 0) return mark.automationRules.map((rule) => rule.name).join('・')
  return mark.autoOnInbound ? '受信時' : '—'
}

export const DISPLAY_TARGET_LABELS: Record<NonNullable<MarkRow['displayTargets']>[number], string> = {
  inbox: '受信箱', friend_list: '友だち一覧', friend_detail: '友だち詳細', dashboard: 'ダッシュボード', broadcast: '一斉配信', automation: 'オートメーション',
}

/**
 * どこから呼ばれているか（設計 `rIhbN` の右から2列目）。
 *
 * **友だちの人数はここに混ぜない。** 隣の「使用中」列と同じ数がもう一度出て、
 * しかも `友だち8` と単位が落ちるため、8人なのか8件なのか読めなかった。
 * この列は配信・シナリオなど**設定側からの参照だけ**を数える。
 *
 * `usedIn` が無いのは「参照0」ではなく**まだ取れていない**状態。0件と
 * 言い切ると、消してよいマークだと読めてしまうので `—` を出す。
 */
export function usageLabel(mark: MarkRow): string {
  const display = mark.displayTargets?.map((target) => DISPLAY_TARGET_LABELS[target]) ?? []
  const usedIn = mark.usedIn
  const parts: string[] = []
  if (usedIn?.broadcasts) parts.push(`配信${usedIn.broadcasts}件`)
  if (usedIn?.scenarios) parts.push(`シナリオ${usedIn.scenarios}件`)
  if (usedIn?.autoReplies) parts.push(`自動応答${usedIn.autoReplies}件`)
  if (usedIn?.savedSearches) parts.push(`保存検索${usedIn.savedSearches}件`)
  if (usedIn?.automations) parts.push(`自動化${usedIn.automations}件`)
  return [...display, ...parts].length ? [...display, ...parts].join('・') : mark.usedIn === undefined ? '—' : 'なし'
}

export function referenceCount(mark: MarkRow): number {
  return (mark.usedIn?.broadcasts ?? 0)
    + (mark.usedIn?.scenarios ?? 0)
    + (mark.usedIn?.autoReplies ?? 0)
    + (mark.usedIn?.savedSearches ?? 0)
    + (mark.usedIn?.automations ?? 0)
}

export function isUsed(mark: MarkRow): boolean {
  return mark.friendCount > 0 || referenceCount(mark) > 0
}

export function ArchiveMarkDialog({ mark, accountId, impact, replacementMarkId, loading, saving, error, onReplacement, onCancel, onConfirm }: {
  mark: MarkRow
  accountId: string | null
  impact: SupportMarkArchiveImpact | null
  replacementMarkId: string
  loading: boolean
  saving: boolean
  error: string
  onReplacement: (id: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  /* ★V8 の小窓  の題・実行ボタン・案内を使う。 */

  /* R138横展開: 確認窓の名前として見出しを読ませる。 */
  /*
    ATTR-17: 以前は画面上端から margin-top:310px に固定しており、
    390×600 のような縦の短い画面ではボタンが画面外に出た。
    画面の中に収め、中身が溢れたらダイアログの内側だけをスクロールする。
    見出しと操作ボタンは常に見えたままにする。
  */
  /*
   * R180: 使っている友だちが0人のときは置換先なしで保管できる。
   * 以前は0人でも置換先が必須で、独自マーク1件だけのアカウントでは
   * 候補が空（共有は除外・自身も除外）になり保管実行を押せなかった。
   * 友だちがいるときに候補が無い・保管できないときは理由と次の操作を出す。
   */
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const close = () => { if (active.current && !saving) { active.current = false; onCancel() } }
  const confirm = () => { if (active.current) onConfirm() }
  const friendCount = impact?.friendCount ?? 0
  const needsReplacement = friendCount > 0
  const noCandidates = needsReplacement && (impact?.replacementOptions.length ?? 0) === 0
  const blockReason = !impact
    ? ''
    : !impact.canArchive
      ? (mark.isDefault
        ? '初期値のマークは保管できません。先に別のマークを初期値にしてください。'
        : mark.isInherited
          ? '共有のマークは保管できません。'
          : '使用先があるため保管できません。使用先を外してから保管してください。')
      : noCandidates
        ? '置き換え先にできる対応マークがありません。先に新しい対応マークを作ってください。'
        : ''
  const canConfirm = !loading && !saving && Boolean(impact?.canArchive) && (!needsReplacement || Boolean(replacementMarkId))
  return (
    <Dialog open confirmation role="alertdialog" designNode="fy5dz" title={`「${mark.name}」を保管しますか`}
      designWidth={560} designHeaderPadding="24px 24px 0" designContentPadding="12px 24px 12px" designFooterPadding="14px 24px 24px"
      onCancel={close} onConfirm={confirm} busy={saving} confirmDisabled={!canConfirm}
      confirmLabel={needsReplacement ? '置き換えて保管する' : '保管する'} busyLabel="保管中…">
      <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
      {/* ★V8 fy5dz：説明は題の段ではなく本文の頭。説明・置き換え先・注意を 12 ずつ縦に並べる。 */}
      <div className="flex flex-col gap-3">
          <p className="text-xs leading-[18px] text-ink-secondary">{needsReplacement ? `いま ${formatNumber(friendCount)} 人に付いています。保管すると、この ${formatNumber(friendCount)} 人は下で選んだマークへ置き換え、履歴に残します。` : '使っている友だちはいないので、そのまま保管できます。'}</p>
          {loading ? <p className="rounded-control bg-surface-soft p-3 text-sm text-ink-faint">影響を確認しています…</p> : impact && needsReplacement ? (
            <SaveErrorField names={["replacementMarkId","replacement_mark_id"]}><EntitySelect
              aria-label="置き換え先"
              value={replacementMarkId}
              onChange={onReplacement}
              options={[{ value: '', label: '選んでください' }, ...impact.replacementOptions.map((option) => ({ ...entityOptionMetadata(option), value: option.id, label: `${option.name}${option.isDefault ? '（初期値）' : ''}` }))]}
              size="full"
            /></SaveErrorField>
          ) : null}
          <p className="text-xs leading-[18px] text-ink-secondary">初期値のマーク・共有しているマーク・自動のきまりで使っているマークは保管できません。</p>
          {blockReason ? <p className="rounded-control bg-canvas-sunken p-3 text-xs leading-5 text-ink-secondary">{blockReason}</p> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Dialog>
  )
}
