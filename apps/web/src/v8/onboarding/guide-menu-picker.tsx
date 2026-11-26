'use client'

import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { RESTAURANT_GUIDE_MENU_IDS, RESTAURANT_GUIDE_MENUS, type RestaurantGuideMenu } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { accountStyleUpdated } from '@/hooks/use-account-style'
import { ApiError } from '@/lib/api'
import { styleApi } from '@/lib/api/helpers/styles'
import styles from './guide-menu-picker.module.css'

export function GuideMenuPicker({ accountId, version, step, total, onLater, onSaved, onCreate, onReload }: {
  accountId: string
  version: number
  step: number
  total: number
  onLater: () => void
  onSaved: () => void
  onCreate: () => void
  onReload: () => void
}) {
  const pending = useRef(false)
  const saveErrors = useSaveFormErrors()
  const [saving, setSaving] = useState<RestaurantGuideMenu | null>(null)
  const [error, setError] = useState('')
  const [versionConflict, setVersionConflict] = useState(false)

  async function select(preset: RestaurantGuideMenu) {
    if (pending.current || versionConflict) return
    pending.current = true
    setSaving(preset)
    setError('')
    saveErrors.reset()
    try {
      const result = await styleApi.save(accountId, {
        expectedVersion: version,
        confirmInitialMenu: true,
        answers: { image: { mode: 'configured', value: 'simple' }, restaurantMenuPreset: { mode: 'configured', value: preset } },
      })
      if (!result.success) throw new Error('下書きを作れませんでした')
      accountStyleUpdated(accountId)
      onSaved()
    } catch (caught) {
      if (!saveErrors.capture(caught)) setError(describeApiFailure(caught, '保存'))
      setVersionConflict(caught instanceof ApiError && caught.code === 'version_conflict')
    } finally {
      pending.current = false
      setSaving(null)
    }
  }

  const title = 'リッチメニューを選ぶ'
  return (
    <Dialog open title={title} titleContent={<span className={styles.heading}>
      <span className={styles.step}>{step}/{total}</span>
      <span><strong>{title}</strong><span className={styles.description}>管理画面の「デザインの型」と同じ5つの型から。行き先URLは自動設定、あとからいつでも変更できます。</span></span>
    </span>} designNode="U1JI3i" designLayout="stacked-picker" designWidth={860} exactDesignWidth
      designMinHeight={726} headerIcon={false} busy={saving !== null} onCancel={onLater} footerDivider={false}
      footer={<div className={styles.footer}>
        <DialogActions>
          <Button size="inline" variant="text" onClick={onLater} disabled={saving !== null}>あとで</Button>
        </DialogActions>
        <small>クーポン等の強調色も各型のパレット内で統一</small>
      </div>}
    >
      {error ? <Notice tone="danger" role="alert">
        {error}
        {versionConflict ? <Button onClick={onReload}>読み直す</Button> : null}
      </Notice> : null}
      <SaveErrorScope errors={saveErrors}>
        <SaveErrorField names={['image', 'answers.image', 'restaurantMenuPreset', 'answers.restaurantMenuPreset', 'confirmInitialMenu']}>
          <div className={styles.designs} role="group" aria-label="リッチメニューの型" tabIndex={-1}>
            {RESTAURANT_GUIDE_MENU_IDS.map(id => {
              const preset = RESTAURANT_GUIDE_MENUS[id]
              return <Card as="article" aria-label={preset.label} key={id} edge="hairline" contentPadding="var(--space-8) var(--space-8)" className={styles.preset}>
                <img className={styles.artwork} src={`/onboarding/restaurant-menu/${id}.png`} alt="" width={486} height={328} />
                <div className={styles.details}>
                  <span className={styles.palette} aria-hidden="true">
                    {preset.colors.map(color => <span key={color} style={{ backgroundColor: color }} />)}
                  </span>
                  <span><strong>{preset.label}</strong><small>{preset.detail}</small></span>
                </div>
                <Button fullWidth size="compact" variant="primary" onClick={() => void select(id)}
                  busy={saving === id} disabled={versionConflict || (saving !== null && saving !== id)}>これにする</Button>
              </Card>
            })}
            <Card as="article" aria-label="0から自分で作る" edge="hairline" contentPadding="var(--space-8) var(--space-8)" className={styles.preset}>
              <div className={styles.scratchArtwork}><Plus aria-hidden="true" /></div>
              <div className={styles.details}><span><strong>0から自分で作る</strong><small>空のメニューから自分でボタンを決めます</small></span></div>
              <Button fullWidth size="compact" onClick={onCreate} disabled={saving !== null}>自分で作る</Button>
            </Card>
          </div>
        </SaveErrorField>
      </SaveErrorScope>
      <Notice tone="info" appearance="subtle" statusWord={false}>クーポン・ショップカードのボタンを使う場合は、運用開始前にクーポン／来店スタンプの設定を済ませてください</Notice>
    </Dialog>
  )
}
