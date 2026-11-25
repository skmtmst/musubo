'use client'

import { type StarterSetItem } from '@/lib/api/helpers/styles'

import { type StarterItemState, type StyleState } from './model'

/*
 * はじめの質問（★V8 修正案の列 VHp7p：xxpM9 スタイル選び・RZW83 見た目・lS1Gh/rJ36f 1問の画面・
 * oKSsG 最後の［まとめて動かす］。決まり ・）。動きは BEHAVIOR.md。
 *
 * 窓の幅は V8 の 4 段の 960（xxpM9 の絵は 880 → 絵を直す）。
 */

export type WizardStep = number | 'summary'

export type Props = {
  accountId: string
  state: StyleState
  /** 開く手順（0＝スタイル、1＝見た目、2〜＝質問、'summary'＝最後の一覧）。 */
  initialStep?: WizardStep
  styleOnly?: boolean
  onClose: (changed: boolean) => void
}

export type Pair = { item: StarterSetItem; state: StarterItemState }

export type SummaryData = { inserted: Pair[]; activation: Pair[] }
