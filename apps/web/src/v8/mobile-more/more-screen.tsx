'use client'

import MobileScreen from '@/components/mobile/mobile-screen'
import { useMobileShell } from '@/components/mobile/mobile-shell'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { useFeatureVisibility } from '@/lib/use-feature-visibility'
import { mobileTodayPermission } from '@/lib/mobile-shell'
import { MobileCardLink, MobileCardList, MobileSection } from '@/components/templates'
import styles from './more.module.css'

export default function MobileMoreScreen() {
  return <MobileScreen title="もっと"><MoreBody /></MobileScreen>
}

function MoreBody() {
  const { canView } = useMobileShell()
  const { selectedAccountId } = useAccount()
  const style = useAccountStyle(selectedAccountId)
  const features = useFeatureVisibility(selectedAccountId)
  const bookingReady = style.status === 'ready' && !style.stale && features.status === 'ready' && features.enabled(style.data?.style === 'restaurant' ? 'restaurant_test' : 'booking')
  const bookingPermission = bookingReady ? mobileTodayPermission(style.data?.style) : null
  const links = [
    ...(canView('/friends') ? [{ href: '/friends', label: '友だちを探す' }] : []),
    ...(bookingPermission && canView(bookingPermission) ? [{ href: style.data?.style === 'restaurant' ? '/restaurant-test/reservations' : '/booking/bookings', label: '予約台帳' }] : []),
    { href: '/notifications', label: '通知' },
  ]
  return <MobileSection title="ほかの機能"><MobileCardList label="ほかの機能">
    {links.map(link => <MobileCardLink key={link.href} href={link.href}><span className={styles.item}><strong>{link.label}</strong><span>PC の画面で開く</span></span></MobileCardLink>)}
  </MobileCardList></MobileSection>
}
