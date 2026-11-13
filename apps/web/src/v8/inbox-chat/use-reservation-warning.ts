'use client'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

const reservationVariable = /^var\.(reservation_datetime|course_name|guest_count)$/
const interpolationPattern = /\{\{[^{}]+\}\}/

/** 見本と予約の不足は同じ応答で確かめ、前の宛先・本文の結果は表示しない。 */
export function useInboxPreview(chatId: string | null, content: string): { preview: string | null; warning: string } {
  const scope = useRef({ chatId, content, generation: 0 })
  if (scope.current.chatId !== chatId || scope.current.content !== content) {
    scope.current = { chatId, content, generation: scope.current.generation + 1 }
  }
  const generation = scope.current.generation
  const [result, setResult] = useState<{ generation: number; chatId: string; content: string; preview: string; variables: string[] } | null>(null)
  useEffect(() => {
    if (!chatId || !interpolationPattern.test(content)) return
    let active = true
    const timer = setTimeout(() => {
      void api.chats.renderPreview(chatId, { content, messageType: 'text' }).then(response => {
        if (active && response.success) setResult({ generation, chatId, content, preview: response.data.content, variables: response.data.unresolved.filter(value => reservationVariable.test(value)) })
      }).catch(() => {})
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [chatId, content, generation])
  if (!chatId || !interpolationPattern.test(content) || result?.generation !== generation || result.chatId !== chatId || result.content !== content) return { preview: null, warning: '' }
  const warning = result.variables.length
    ? `予約の値がないため ${result.variables.map(value => `{{${value}}}`).join(' ')} を埋められません。内容を修正してください。`
    : ''
  return { preview: result.preview, warning }
}
