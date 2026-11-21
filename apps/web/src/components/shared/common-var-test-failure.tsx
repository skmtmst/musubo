'use client'

import { ApiError } from '@/lib/api/transport/errors'
import Button from './button'
import Card from './card'
import styles from './common-var-test-failure.module.css'

export type CommonVarFailure = { displayName: string; reason: string }

/** 対象のエラーだけ、サーバーが返した共通情報の表示名を使う。 */
export function commonVarFailureNames(error: unknown): CommonVarFailure[] | null {
  if (!(error instanceof ApiError) || error.code !== 'COMMON_VAR_UNRESOLVED' || !error.data || typeof error.data !== 'object') return null
  const data = error.data as { variables?: unknown }
  if (!Array.isArray(data.variables) || data.variables.length === 0) return null
  const names: CommonVarFailure[] = []
  for (const variable of data.variables) {
    if (!variable || typeof variable !== 'object') return null
    const item = variable as { key?: unknown; displayName?: unknown; reason?: unknown }
    if (typeof item.key !== 'string' || typeof item.displayName !== 'string' || !item.displayName.trim()) return null
    names.push({displayName:item.displayName,reason:typeof item.reason === 'string' ? item.reason : 'unknown'})
  }
  return names
}

export function CommonVarTestFailure({ names }: { names: CommonVarFailure[] }) {
  const labels = names.map(({displayName}) => `「${displayName}」`).join('、')
  const missing = names.every(({reason}) => reason === 'missing')
  return <Card layout="vertical" padding="default" gap="normal" role="alert">
    <strong className={styles.heading}>テスト送信できませんでした</strong>
    <p className={styles.message}>{labels}{missing ? 'の共通情報がまだ登録されていません。' : 'の共通情報が使える状態になっていません。'}<br />{missing ? '共通情報で登録してから' : '共通情報で設定を確認してから'}、もう一度テスト送信してください。</p>
    <div><Button variant="primary" href="/contents/vars">共通情報を開く</Button></div>
  </Card>
}
