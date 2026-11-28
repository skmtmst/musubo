'use client'

/*
 * ★V8 /friends/migrations の入口。`?tab=uid` は UID移行、それ以外は CSVで書き出す・取り込む。
 */
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import CsvMigrationsV8 from './csv'
import UidMigrationV8 from './uid'

function Inner() {
  const params = useSearchParams()
  const tab = params?.get('tab')?.trim() ?? ''
  const run = params?.get('run')?.trim() || null
  if (tab === 'uid') return <UidMigrationV8 initialRunId={run} />
  return <CsvMigrationsV8 />
}

export default function FriendMigrationsV8() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  )
}
