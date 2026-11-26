'use client'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

const interpolationPattern = /\{\{[^{}]+\}\}/

/**
 * 送ったときの見え方。`ready` の `unresolved` は口が実際に解決できなかった差し込みの全部
 * （予約の差し込みも、予約がある相手には入るので口の結果だけで決める）。
 * 確かめられなかった時は `failed`（「問題なし」にしない）。
 */
export type InboxPreview =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; preview: string; unresolved: string[] }
  | { status: 'failed' }

const IDLE: InboxPreview = { status: 'idle' }
const LOADING: InboxPreview = { status: 'loading' }

/** 見本と入らない差し込みは同じ応答で確かめ、前の宛先・本文の結果は表示しない。 */
export function useInboxPreview(chatId: string | null, content: string): InboxPreview {
  const scope = useRef({ chatId, content, generation: 0 })
  if (scope.current.chatId !== chatId || scope.current.content !== content) {
    scope.current = { chatId, content, generation: scope.current.generation + 1 }
  }
  const generation = scope.current.generation
  const [result, setResult] = useState<{ generation: number; chatId: string; content: string; preview: InboxPreview } | null>(null)
  useEffect(() => {
    if (!chatId || !interpolationPattern.test(content)) return
    let active = true
    const timer = setTimeout(() => {
      void api.chats.renderPreview(chatId, { content, messageType: 'text' }).then(response => {
        if (!active) return
        setResult({
          generation, chatId, content,
          preview: response.success ? { status: 'ready', preview: response.data.content, unresolved: response.data.unresolved } : { status: 'failed' },
        })
      }).catch(() => {
        if (active) setResult({ generation, chatId, content, preview: { status: 'failed' } })
      })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [chatId, content, generation])
  if (!chatId || !interpolationPattern.test(content)) return IDLE
  if (result?.generation !== generation || result.chatId !== chatId || result.content !== content) return LOADING
  return result.preview
}
