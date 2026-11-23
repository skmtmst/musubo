'use client'

import { useEffect } from 'react'
import { reportClientRuntimeError } from '@/lib/client-error-reporting'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    void reportClientRuntimeError(error, 'next.global-error').catch(() => undefined)
  }, [error])

  return (
    <html lang="ja">
      <head>
        <title>画面を表示できませんでした</title>
      </head>
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f6f7f6' }}>
        <main style={{ maxWidth: 560, margin: '12vh auto', padding: 32, background: '#fff', borderRadius: 16 }}>
          <h1 style={{ fontSize: 22 }}>画面を表示できませんでした</h1>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: '#555' }}>
            エラーは自動的に担当者へ報告されました。再読み込みしても直らない場合は、表示された時刻をお知らせください。
          </p>
          <button type="button" onClick={reset} style={{ padding: '10px 18px', borderRadius: 8, border: 0, cursor: 'pointer' }}>
            もう一度試す
          </button>
        </main>
      </body>
    </html>
  )
}
