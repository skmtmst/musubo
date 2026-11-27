'use client'

/*
 * ★V8 見つからない画面（板 ・V8.pen の修正案「採用 2026-10-07 リリース前」）。
 * 白い板の真ん中に、印（ file-question は丸の？で描かれているので CircleHelp）・題・説明・［前のページへ戻る］（副）［ダッシュボードへ］（主）。
 * 画面名は上の帯（ホーム › ページが見つかりません）が持つので、ここの題は h2。
 * 説明の下に開けなかった道（クエリ抜き）、ボタンの下に「よく使うページ」の文字リンク。
 * ログインしていない時は、外枠の認証の確かめがログインへ送るので、この画面は出ない。
 */
import { usePathname } from 'next/navigation'
import { CircleHelp } from 'lucide-react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import Button from '@/components/shared/button'
import TextLink from '@/components/shared/text-link'
import { useStaffIdentity } from '@/lib/staff-role'
import { frequentDestinations, missingPathLabel } from './frequent-destinations'
import styles from './not-found.module.css'

export default function NotFoundV8() {
  const router = useRouter()
  const pathname = usePathname()
  const missingPath = missingPathLabel(pathname)
  const hq = pathname === '/hq' || Boolean(pathname?.startsWith('/hq/'))
  const ops = pathname === '/ops' || Boolean(pathname?.startsWith('/ops/'))
  const home = ops ? '/ops/dashboard' : hq ? '/hq' : '/'
  // 役割と権限は本人の API（/api/staff/me）から。手元の保存値は書き換えられるので使わない。
  const staff = useStaffIdentity()
  const destinations = ops
    ? [{ href: '/ops/tenants', label: '契約先アカウント' }, { href: '/ops/support', label: 'お問い合わせ' }]
    : hq
    ? [{ href: '/hq/attention', label: '対応が要るもの' }, { href: '/hq/templates', label: 'テンプレート' }]
    : frequentDestinations(staff?.role ?? null, staff?.permissionKeys ?? [], staff?.permissionViewKeys ?? [])
  const goBack = () => {
    // 直接開いた（戻る先が無い）ときは、ダッシュボードへ。
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push(home)
  }
  return (
    <div className={styles.board} data-design-node="Nx5dz">
      <section className={styles.box} aria-labelledby="not-found-title">
        <span className={styles.mark} aria-hidden="true"><CircleHelp /></span>
        <h2 id="not-found-title" className={styles.title}>ページが見つかりません</h2>
        <p className={styles.description}>URL がまちがっているか、ページが移動・削除された可能性があります。</p>
        {missingPath ? <p className={styles.path} title={missingPath}>開こうとしたページ：{missingPath}</p> : null}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={goBack}>前のページへ戻る</Button>
          <Button href={home} variant="primary">{ops ? '運営ダッシュボードへ' : hq ? '統括へ' : 'ダッシュボードへ'}</Button>
        </div>
        <nav className={styles.destinations} aria-label="よく使うページ">
          <span className={styles.destinationsLabel}>よく使うページ</span>
          <ul className={styles.destinationList}>
            {destinations.map((destination) => (
              <li key={destination.href}><TextLink href={destination.href}>{destination.label}</TextLink></li>
            ))}
          </ul>
        </nav>
      </section>
    </div>
  )
}
