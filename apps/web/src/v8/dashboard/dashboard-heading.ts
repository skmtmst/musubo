import { canManageRole } from '@/lib/staff-role'
import { formatDashboardAsOf } from '@/components/dashboard/freshness'



/**
 * ダッシュボード編集（自分の並び）を出してよい役割か。隠すのは閲覧のみ（読み取り専用。
 * `/api/staff/me` の role が 'viewer'＝サーバーが保存を断る人）だけ。書き込みできる
 * スタッフは押せるので出す（決まりは「押せないボタンを隠す」）。読めるまで（null）は隠す。
 */
export function canEditDashboardLayout(role: string | null): boolean {
  return canManageRole(role) || role === 'staff'
}


/** 時間帯のあいさつ（日本時間）。 */
export function greeting(name: string | null, now = new Date()): string {
  const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Tokyo' }).format(safeNow))
  const word = hour >= 4 && hour < 10 ? 'おはようございます' : hour >= 10 && hour < 18 ? 'こんにちは' : 'こんばんは'
  const first = typeof name === 'string' ? name.trim().split(/\s+/)[0] : ''
  return first ? `${word}、${first} さん` : word
}


/** 見出しの下の1行：「更新 1月13日（火）9:30 ・ 正常に動いています」。 */
export function headline(asOf: string | null | undefined, risk: 'normal' | 'warning' | 'danger' | null): string {
  const time = formatDashboardAsOf(asOf)?.replace(/） /, '）')
  const health = risk === 'normal' ? '正常に動いています' : risk === 'warning' ? '確かめることがあります' : risk === 'danger' ? '止まっているところがあります' : '動きを確かめています'
  return time ? `更新 ${time}・${health}` : health
}
