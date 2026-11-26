import styles from './musubo-logo.module.css'

type LogoSize = 'auth' | 'ops' | 'mobile' | 'staff'
const WIDTHS: Record<LogoSize, number> = { auth: 188, ops: 176, mobile: 95, staff: 140 }

/** 透過余白を含む元画像を、表示幅と画素密度に合わせて縮小したもの。 */
export function musuboLogoSources(size: LogoSize) {
  const width = WIDTHS[size]
  const path = (density: number) => `/brand/musubo-color-${width}-${density}x.png`
  return { src: path(1), srcSet: [1, 2, 3].map(density => `${path(density)} ${density}x`).join(', ') }
}

/** 公式ロゴを、透過余白を除いた表示サイズで共通して使う。 */
export default function MusuboLogo({ size = 'auth' }: { size?: LogoSize }) {
  return <span className={styles.viewport} data-size={size}>
    {/* eslint-disable-next-line @next/next/no-img-element -- 表示幅に合わせた公式ロゴを使用する */}
    <img className={styles.image} {...musuboLogoSources(size)} width={3020} height={890} alt="musubo" />
  </span>
}
