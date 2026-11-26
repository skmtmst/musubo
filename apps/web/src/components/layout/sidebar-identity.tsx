'use client'

import styles from './sidebar-identity.module.css'
import { musuboLogoSources } from '@/components/shared/musubo-logo'

/**
 * 共通メニューのいちばん上に置く公式ロゴ。
 * 店舗・統括・停止中・モバイルの各メニューで同じ画像を使う。
 */
export default function SidebarIdentity({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`${styles.logoRoot} ${compact ? styles.compact : ''}`} data-design-node="J33xq/V2WbXF">
      <span className={styles.logoViewport}>
        {/* eslint-disable-next-line @next/next/no-img-element -- 提供されたロゴの透過ピクセルをそのまま表示する */}
        <img className={styles.logoImage} {...musuboLogoSources('staff')} width={3020} height={890} alt="musubo" />
      </span>
    </div>
  )
}
