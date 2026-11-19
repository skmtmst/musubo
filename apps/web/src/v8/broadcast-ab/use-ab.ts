'use client'

import { useCallback, useState } from 'react'
import type { BroadcastBubble } from '@line-crm/shared'
import { broadcastAbApi, type AbSettings } from './api'
import { AB_DEFAULT } from './model'

/**
 * 一斉配信の作成での A/B の状態（③ の A・B 案、④ の設定）。
 * A 案は今までの本文（フォームの bubbles）。B 案はここで持ち、保存のときに口へ送る。
 */
export function useBroadcastAb() {
  const [tab, setTab] = useState<'A' | 'B'>('A')
  const [b, setB] = useState<BroadcastBubble[] | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [settings, setSettings] = useState<AbSettings>(AB_DEFAULT)

  const addB = useCallback((from: BroadcastBubble[]) => {
    /* B 案は A 案の写しから始める（直す所だけ変えられる）。 */
    setB(from.map((bubble, index) => ({ ...bubble, id: `b-${Date.now()}-${index}`, content: { ...bubble.content } })))
    setTab('B')
    setEnabled(true)
  }, [])
  const removeB = useCallback(() => { setB(null); setTab('A'); setEnabled(false) }, [])

  const restoreDraft = useCallback((value: unknown) => {
    const draft = value && typeof value === 'object' ? value as Record<string, unknown> : null
    const bubbles = Array.isArray(draft?.bubbles) ? draft.bubbles.filter((item): item is BroadcastBubble =>
      Boolean(item) && typeof item === 'object' && typeof item.id === 'string' && typeof item.type === 'string' && Boolean(item.content)) : []
    const stored = draft?.settings && typeof draft.settings === 'object' ? draft.settings as Partial<AbSettings> : {}
    setB(bubbles.length ? bubbles : null)
    setEnabled(Boolean(bubbles.length && draft?.enabled))
    setSettings({
      testRatioPct: [10, 20, 30, 50].includes(Number(stored.testRatioPct)) ? stored.testRatioPct! : AB_DEFAULT.testRatioPct,
      metric: stored.metric === 'click' || stored.metric === 'booking' || stored.metric === 'purchase' ? stored.metric : AB_DEFAULT.metric,
      decideAfterMinutes: [60, 120, 240, 480, 1440].includes(Number(stored.decideAfterMinutes)) ? stored.decideAfterMinutes! : AB_DEFAULT.decideAfterMinutes,
      undecidedPolicy: stored.undecidedPolicy === 'send_a' ? 'send_a' : 'stop',
    })
    setTab('A')
  }, [])

  /* 保存のあと：B 案と設定を口へ送る。 */
  /* 版は配信の lock_version。案・設定を保存するたびに新しい版が返るので、続けて渡す。返り値は最後の版。 */
  const persist = useCallback(async (broadcastId: string, version: number, aBubbles: BroadcastBubble[]): Promise<number> => {
    if (!b || !enabled) return version
    const a = await broadcastAbApi.saveVariant(broadcastId, 'A', aBubbles, version)
    const bRes = await broadcastAbApi.saveVariant(broadcastId, 'B', b, a.data.version)
    const test = await broadcastAbApi.saveTest(broadcastId, { ...settings, expectedVersion: bRes.data.version })
    return test.data.version
  }, [b, enabled, settings])

  return { tab, setTab, b, setB, hasB: b !== null, enabled: enabled && b !== null, setEnabled, settings, setSettings, addB, removeB, restoreDraft, persist }
}

export type BroadcastAb = ReturnType<typeof useBroadcastAb>
