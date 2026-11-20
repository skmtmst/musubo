'use client'

import { useEffect, useState } from 'react'
import { PartyPopper } from 'lucide-react'
import { api } from '@/lib/api'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import styles from './guide-publish-menu.module.css'

type Preview =
  | { state: 'loading' | 'multiple' | 'empty' }
  | { state: 'error'; error: unknown }
  | { state: 'ready'; id: string; name: string; image: string | null; size: 'large' | 'compact' }

export function GuidePublishMenu({ accountId, onLater, onReview }: {
  accountId: string
  onLater: () => void
  onReview: (href: string) => void
}) {
  const [preview, setPreview] = useState<Preview>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    void api.richMenuGroups.listPage(accountId, { limit: 2, filter: 'draft' }).then(response => {
      if (!current) return
      if (!response.success || !Array.isArray(response.data?.items)) throw new Error('リッチメニューを読み込めませんでした')
      const drafts = response.data.items.filter(item => item.status === 'draft' && item.accountId === accountId)
      if (drafts.length > 1) setPreview({ state: 'multiple' })
      else if (drafts.length === 0) setPreview({ state: 'empty' })
      else {
        const draft = drafts[0]
        setPreview({ state: 'ready', id: draft.id, name: draft.name, size: draft.size, image: draft.thumbnailR2Key })
      }
    }).catch(error => { if (current) setPreview({ state: 'error', error }) })
    return () => { current = false }
  }, [accountId, attempt])

  const href = preview.state === 'ready' ? `/rich-menus/edit?id=${encodeURIComponent(preview.id)}` : '/rich-menus'
  return (
    <Dialog open designNode="Hg6Zl" designWidth={540} exactDesignWidth title="予約の受け付けが始まりました"
      titleIcon={<PartyPopper aria-hidden="true" size={24} />} designLayout="stacked"
      description="リッチメニューを公開すると、LINEのトーク画面から予約できるようになります。"
      onCancel={onLater} footerDivider={false}
      footer={<DialogActions>
        <Button onClick={onLater}>あとで</Button>
        <Button variant="primary" onClick={() => onReview(href)}>リッチメニューを公開する</Button>
      </DialogActions>}
    >
      <div className={styles.preview}>
        {preview.state === 'loading' ? <ListState kind="loading" /> : null}
        {preview.state === 'error' ? <ListState kind="error" error={preview.error} onRetry={() => {
          setPreview({ state: 'loading' })
          setAttempt(value => value + 1)
        }} /> : null}
        {preview.state === 'ready' ? <figure className={styles.menu}>
          {preview.image ? <img className={styles.image} src={api.richMenuGroups.imageUrl(preview.image)}
            alt={preview.name} width={2500} height={preview.size === 'compact' ? 843 : 1686} /> : null}
          <figcaption>{preview.name}</figcaption>
        </figure> : null}
        {preview.state === 'multiple' ? <p>一覧から公開する下書きを選べます。</p> : null}
        {preview.state === 'empty' ? <p>リッチメニューの一覧から状況を確認できます。</p> : null}
        <p>公開前に内容を確認できます</p>
      </div>
    </Dialog>
  )
}
