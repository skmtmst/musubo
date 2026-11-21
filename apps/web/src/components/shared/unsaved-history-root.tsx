'use client'

import { useUnsavedHistoryInterception } from '@/lib/unsaved-history'

/**
 * 未保存の入力を守る戻る・進むの受け口を、Next のルーターより先に付ける。管理画面のいちばん外側に1つだけ置く。
 * 画面には何も描かない。番兵（useUnsavedGuard）が無い間は、戻る・進むをそのまま通す。
 */
export default function UnsavedHistoryRoot() {
  useUnsavedHistoryInterception()
  return null
}
