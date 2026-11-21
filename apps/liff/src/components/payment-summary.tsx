/** お支払い前に、料金と今回払う額を同じ形で確認できるようにする。 */
export default function PaymentSummary({ total, amount, remaining, cancellation }: { total: number; amount: number; remaining: number; cancellation: string }) {
  const rows = [['料金', total], ['今お支払い', amount], ['お店で', remaining]] as const;
  return <div className="space-y-3 text-sm text-ink">
    <dl className="space-y-2">{rows.map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-3"><dt>{label}</dt><dd className="text-right font-bold tabular-nums">{value.toLocaleString('ja-JP')}円</dd></div>)}</dl>
    <p className="text-xs leading-5 text-liff-sub">{cancellation}</p>
  </div>;
}
