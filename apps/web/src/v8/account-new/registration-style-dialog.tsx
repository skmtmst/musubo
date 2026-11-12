'use client'

import { useEffect, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { ArrowRight, Info } from 'lucide-react'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import HelpTip from '@/components/shared/help-tip'
import { ProgressBar } from '@/components/shared/progress'
import { StyleChoiceStep, StyleChoiceSwitcher, STYLE_CHOICE_START_ID, StyleChoiceStatus, StyleChooseAction } from '@/v8/onboarding/public/style-choice'
import { InitialMenuChoice, type InitialMenuSelection } from '@/v8/onboarding'
import styles from '@/v8/onboarding/wizard.module.css'

/** 登録の④でも、はじめの質問と同じ見本を見てからスタイルを選ぶ。 */
export default function RegistrationStyleDialog({ open, accountId, accountName, menu, onMenuChange, choice, busy, ready, error, onChoose, onSave, onSkip, onClose }: {
  accountId: string
  accountName?: string
  menu: InitialMenuSelection
  onMenuChange: (next:InitialMenuSelection)=>void
  open: boolean
  choice: AccountStyle | ''
  busy: boolean
  ready: boolean
  error: string
  onChoose: (style: AccountStyle) => void
  onSave: () => void
  onSkip: () => void
  onClose: () => void
}) {
  const [menuStep,setMenuStep]=useState(false)
  const [demoOpen, setDemoOpen] = useState(false)
  const [demoPage, setDemoPage] = useState(0)
  const [viewing, setViewing] = useState<AccountStyle>(() => choice || 'restaurant')
  useEffect(() => { if (choice) setViewing(choice) }, [choice])
  useEffect(() => { if (!open) { setDemoOpen(false); setDemoPage(0); setMenuStep(false) } }, [open])
  if (!open) return null
  return <Dialog
    open
    title={menuStep?'最初のリッチメニューを選ぶ':'使い方のスタイルを選ぶ'}
    titleHelp={<HelpTip label="使い方のスタイルの説明">ダッシュボードと初期設定が、選んだスタイルに合わせて変わります。あとから設定で変更できます。</HelpTip>}
    initialFocusId={menuStep?undefined:STYLE_CHOICE_START_ID}
    size="wide"
    designTop={60}
    fitViewport
    contentLayout={!menuStep ? 'form' : undefined}
    steps={!menuStep ? <StyleChoiceSwitcher viewing={viewing} onView={setViewing} chosen={choice || null} disabled={busy} /> : undefined}
    designNode="xxpM9"
    onCancel={demoOpen ? () => setDemoOpen(false) : onClose}
    busy={busy}
    error={error}
    footerDivider={false}
    designFooterPadding="16px 24px"
    designContentPadding="16px 24px 24px"
    footer={demoOpen ? <DialogActions leadingAction={<Button onClick={() => { if (demoPage > 0) setDemoPage(demoPage - 1) }} aria-disabled={demoPage === 0} disabled={busy}>前のページ</Button>}>
      <StyleChooseAction primary viewing={viewing} chosen={choice || null} onChoose={onChoose} disabled={busy} />
      <Button onClick={() => { if (demoPage < 4) setDemoPage(demoPage + 1) }} aria-disabled={demoPage === 4} disabled={busy}>次のページ</Button>
    </DialogActions> : <DialogActions leadingAction={menuStep ? <Button onClick={()=>setMenuStep(false)} disabled={busy}>スタイルを選び直す</Button> : <Button type="button" variant="text" onClick={onSkip} disabled={busy || !ready}>あとで設定する</Button>}>
      <Button type="button" variant="primary" onClick={()=>{if(menuStep)onSave();else setMenuStep(true)}} disabled={busy || !ready || !choice || (menuStep&&menu.value==='existing'&&!menu.resourceId)} busy={busy} busyLabel="保存しています…" disabledReason={!choice ? '「このスタイルにする」を押して選んでください' : null}>{menuStep?'このメニューで進む':'次へ'}<ArrowRight size={16} aria-hidden="true" /></Button>
    </DialogActions>}
  >
    <div className={styles.body}>
      <div className={styles.progress}>
        <span className={styles.progressCount}>登録の手順 4 / 5</span>
        <ProgressBar appearance="quota" className={styles.track} value={4} max={5} label="登録の進み" />
        <span className={styles.progressName}>使い方のスタイル</span>
      </div>
      <StyleChoiceStatus chosen={choice || null} />
      {menuStep&&choice?<InitialMenuChoice accountId={accountId} style={choice} value={menu} onChange={onMenuChange} disabled={busy}/>:<StyleChoiceStep accountName={accountName} viewing={viewing} onView={setViewing} chosen={choice || null} onChoose={onChoose} disabled={busy} switcher="external" detail={demoOpen} onDetailChange={setDemoOpen} demoPage={demoPage} onDemoPage={setDemoPage} />}
      <p className={styles.where}><Info aria-hidden="true" className={styles.whereIcon} />あとから変えられます（設定 › アカウント）。</p>
    </div>
  </Dialog>
}
