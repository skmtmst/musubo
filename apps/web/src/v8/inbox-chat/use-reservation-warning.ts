'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const reservationVariable = /^var\.(reservation_datetime|course_name|guest_count)$/
const reservationPattern = /\{\{\s*var\.(reservation_datetime|course_name|guest_count)\s*\}\}/

/** 現在の宛先と本文に対する結果だけを表示し、古い応答は使わない。 */
export function useReservationWarning(chatId: string | null, content: string): string {
  const [result, setResult] = useState<{ chatId: string; content: string; variables: string[] } | null>(null)
  useEffect(() => {
    if (!chatId || !reservationPattern.test(content)) return
    let active = true
    const timer = setTimeout(() => {
      void api.chats.renderPreview(chatId, { content, messageType: 'text' }).then(response => {
        if (active && response.success) setResult({ chatId, content, variables: response.data.unresolved.filter(value => reservationVariable.test(value)) })
      }).catch(() => {})
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [chatId, content])
  if (!chatId || result?.chatId !== chatId || result.content !== content || !result.variables.length) return ''
  return `予約の値がないため ${result.variables.map(value => `{{${value}}}`).join(' ')} を埋められません。内容を修正してください。`
}
