'use client'

import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'

export function ScenarioDraftLoadNotice({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  if (!failed) return null
  return <Notice tone="danger" role="alert" message="下書きを読み込めませんでした。読み直すまで自動保存を停止しています。"
    action={<Button type="button" size="compact" onClick={onRetry}>もう一度読み込む</Button>} />
}
