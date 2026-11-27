/** 進みの棒（会員証の次の段まで）。値は 0〜1。地は白の薄い線、棒の色は呼び出し側の文字色（currentColor）で決める。 */
export default function ProgressBar({ value, label, className = '' }: { value: number; label: string; className?: string }) {
  if (!Number.isFinite(value)) return <p role="status" className={className}>{`${label}の進み具合を確認できません`}</p>;
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className={`h-1.5 w-full overflow-hidden rounded-full bg-white/20 ${className}`}>
    <div className="h-full rounded-full bg-current" style={{ width: `${percent}%` }} />
  </div>;
}
