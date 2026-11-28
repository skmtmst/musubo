'use client'

import { Hand } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { Field, TextInput } from '@/components/shared/form-controls'
import StatusBadge from '@/components/shared/status-badge'
import Toggle from '@/components/shared/toggle'
import { ListPageCards } from '@/components/templates/list-page'
import { FOLLOWUP_NAMES, FOLLOWUP_ORDER } from './board-model'
import { RESTAURANT_TRIGGER_ROWS } from './config'
import styles from './demo.module.css'

/** 実際のデータを読み書きしない、設定画面と保存結果の見本。 */
export function RestaurantFollowupDemo({ phase }: { phase: number }) {
  const editing = phase === 2
  const saved = phase === 4
  return <div className={styles.layout} role="group" aria-label="LINE来店フォローの見本">
    <p className={styles.note}>画面と操作の見本です。</p>
    <div className={styles.screen} aria-hidden="true" inert>
      <ListPageCards columns={4} narrowColumns={2} inset="parent">
        <Card as="article" padding="compact" layout="vertical" gap="tight">
          <strong>予約の回答フォーム</strong><p>リッチメニューの「予約」で開く</p><Button variant="text" size="inline" textTone="accent">変更する</Button><div className={styles.sample}>予約日時・人数を入力</div>
        </Card>
        {FOLLOWUP_ORDER.map(trigger => <Card as="article" key={trigger} padding="compact" layout="vertical" gap="tight">
          <div className={styles.head}><strong>{FOLLOWUP_NAMES[trigger]}</strong><Toggle label={`${FOLLOWUP_NAMES[trigger]}を使う`} checked={phase >= 3 && trigger === 'reservation_24h'} /></div>
          <div className={styles.head}><span>{trigger === 'reservation_24h' ? '予約の1日前に送る' : '送る時期を設定'}</span><span className={phase === 1 && trigger === 'reservation_24h' ? styles.target : undefined}><Button variant="text" size="inline" textTone="accent">変更する</Button>{phase === 1 && trigger === 'reservation_24h' && <Hand className={styles.hand} size={22} />}</span></div>
          <StatusBadge tone="neutral">{trigger === 'reservation_24h' && phase === 3 ? '未保存' : saved && trigger === 'reservation_24h' ? '準備済み・送信停止中' : '止めています'}</StatusBadge>
          <div className={styles.sample}><small>LINEでの見え方</small><p>{RESTAURANT_TRIGGER_ROWS.find(row => row.trigger === trigger)?.sampleText}</p></div>
        </Card>)}
      </ListPageCards>
      <div className={styles.actions}><span className={phase === 3 ? styles.target : undefined}><Button variant="primary">保存して作る</Button>{phase === 3 && <Hand className={styles.hand} size={22} />}</span></div>
      {editing && <div className={styles.overlay}><Card layout="vertical" padding="default" gap="normal">
        <strong>前日の確認を変える</strong>
        <div className={styles.columns}><div className={styles.fields}><Field label="だれに（きっかけ）"><TextInput readOnly value="予約が完了した人" /></Field><Field label="いつ送るか"><TextInput readOnly value="予約の前日" /></Field><Field label="送るもの"><TextInput readOnly value="明日はご予約の日です。お待ちしています。" /></Field></div><div className={styles.phone}><strong>届き方</strong><p>明日はご予約の日です。お待ちしています。</p></div></div>
        <div className={styles.actions}><Button variant="primary">この内容でオンにする</Button></div>
      </Card></div>}
      {saved && <div className={styles.overlay}><Card layout="vertical" padding="default" gap="normal"><strong>保存の結果</strong><p>まだ送っていません。テスト送信と承認のあと送り始めます。</p><ul className={styles.results}>{FOLLOWUP_ORDER.map(trigger => <li className={styles.head} key={trigger}><span>{FOLLOWUP_NAMES[trigger]}</span><span>{trigger === 'reservation_24h' ? 'リマインダに下書きを作りました' : 'オフのまま保存しました'}</span></li>)}</ul></Card></div>}
    </div>
    <p className={styles.note}>{phase < 2 ? '8枚のカードから送り方を選びます。' : editing ? '前日の確認の送り方を窓で変えます。' : phase === 3 ? '保存して送り方を作ります。' : '保存の結果を確認します。まだ送信されていません。'} 見本のため実際の設定は変わりません。</p>
  </div>
}
