import type { RichMenuAreaIntent } from '@line-crm/shared'
export const INTENT_OPTIONS: { value: RichMenuAreaIntent; label: string; hint: string }[] = [
  { value: 'url', label: 'URLを開く', hint: 'ホームページや申し込みページに飛ばす' },
  { value: 'text', label: 'メッセージを送る', hint: '押した人がその言葉を送ったことにする' },
  { value: 'template', label: 'テンプレートを送る', hint: '作ってあるメッセージをこちらから送る' },
  { value: 'form', label: '回答フォームを開く', hint: 'アンケートや申し込みフォームを開く' },
  { value: 'tel', label: '電話をかける', hint: 'スマホの電話アプリが立ち上がる' },
  { value: 'switch', label: 'リッチメニューを切り替える', hint: 'タブのように別ページを出す' },
  { value: 'postback', label: 'こちらで処理する', hint: '自動応答やオートメーションの合図を送る（上級）' },
  { value: 'datetime', label: '日時を選ぶ', hint: 'カレンダーや時計を出して選んでもらう' },
  { value: 'clipboard', label: '文字をコピーする', hint: '合言葉などを端末に写す' },
]
