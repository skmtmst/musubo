'use client'

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { GuideControl, GuideSummary } from './guide-engine'
import type { useFirstRun } from './use-first-run'
import type { useStyleSetupProgress } from './use-style-setup-progress'

/*
  全画面に1つだけ置くガイドの持ち主を、はじめにやることの帯にも貸す入れ物。

  ガイドの状態（有効/一時停止・現在ステップ・現在手順）はユーザー×アカウントで
  サーバーが正本なので、同じ画面に2つの持ち主を作らない。
  入れ物が無い所（単体試験・入れ物の外）では、画面側が自分で持つ形に戻る。
*/

export type SharedGuide = { guide: GuideControl; summary: GuideSummary | null; dismissed?: boolean | null; setup?: { accountId: string | null; run: ReturnType<typeof useFirstRun>; progress: ReturnType<typeof useStyleSetupProgress>; setWatch: (id: symbol, enabled: boolean) => void } }

const GuideSharedContext = createContext<SharedGuide | null>(null)

export function GuideSharedProvider({ value, children }: { value: SharedGuide | null; children: ReactNode }) {
  return <GuideSharedContext.Provider value={value}>{children}</GuideSharedContext.Provider>
}

/** 貸してもらえるガイドがあれば返す。無ければ null（画面側が自分で持つ）。 */
export function useSharedGuide(): SharedGuide | null {
  return useContext(GuideSharedContext)
}
