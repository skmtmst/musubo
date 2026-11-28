import Card from '@/components/shared/card'
import type { AccountStyle } from '@line-crm/shared'
import Button from '@/components/shared/button'
import { CreateStepColumns } from '@/components/templates/create-step-columns'
import { STYLE_EXPERIENCE_SCRIPT } from '@/v8/onboarding/style-experience-player'
import styles from './register.module.css'

/*
 * ★LINE新規追加_v07.pen（2026-10-18承認）④使い方を選ぶ X0pGdw の描画だけ。
 * register.tsx が行数の関所（apps/web/scripts/v8-guard/code-size.mjs）を越えたので
 * 切り出した。登録④の背景画面だけを描き、選択は共通のスタイル体験を使うポップアップで行う。
 */
export default function Step4Template({ templateKey, onOpen }: {
  templateKey: AccountStyle | ''
  onOpen: () => void
}) {
  return (
    <CreateStepColumns data-design-node="X0pGdw" previewTitle="あとから変えられます" previewLabel="変更できる設定を見る" preview={(
        <Card className={styles.aside} layout="vertical" surface="muted" contentPadding="var(--tpl-htn-aside-pad)" gap="var(--tpl-htn-aside-gap)" aria-label="あとから変えられます">
        <h2 className={styles.asideH2}>あとから変えられます</h2>
        <p className={styles.asideP}>選んだ使い方でダッシュボードの並びが決まります。</p>
        <p className={styles.asideP}>カードは、あとから自分で足し引きできます。</p>
      </Card>
      )}>
      <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label="使い方を選ぶ">
        <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>使い方のスタイルを選ぶ</h2>
        <p className={styles.asideP}>見本を見て、お店に近いスタイルを選んでください。あとから設定で変更できます。</p>
        {templateKey ? <p className={styles.asideP}>選択中：{STYLE_EXPERIENCE_SCRIPT.styles[templateKey].label}（まだ保存していません）</p> : null}
        <Button type="button" onClick={onOpen}>スタイルを選択する</Button>
      </Card>
    </CreateStepColumns>
  )
}
