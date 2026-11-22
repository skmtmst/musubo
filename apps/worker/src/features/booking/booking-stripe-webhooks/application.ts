import { claimWorkflowStep, finishWorkflowStep, getWorkflowStep, releaseWorkflowStep } from '@line-crm/db';
import { bindingScope } from './bindings.js';
import { bookingStripeReceiptId, getBookingStripeReceipt, receiptRef } from './receipts.js';
import { BINDING_PROCESS, BOOKING_STRIPE_EVENT_KINDS, BookingStripeError, STRIPE_BOOKING_API_VERSION, type BookingStripeBinding, type BookingStripeEvent } from './types.js';
/** 業務側のCAS・一意制約と同じbatchに受信の完了を入れる。prepare内では外部通信しない。 */
export async function applyBookingStripeReceipt(db: D1Database, account: string, eventId: string,
  prepare: (context: {event: BookingStripeEvent; binding: BookingStripeBinding; receiptId: string}) => Promise<D1PreparedStatement[]>,
  options: {now?: number; owner?: string; leaseMs?: number} = {},
): Promise<'applied' | 'duplicate' | 'pending' | 'processing' | 'review_required'> {
  const receipt = await getBookingStripeReceipt(db,account,eventId);
  if (!receipt) throw new BookingStripeError('stripe_receipt_not_found',400);
  if (receipt.row.status === 'succeeded') return 'duplicate';
  if (receipt.row.status === 'exhausted') return 'review_required';
  const {event} = receipt.input, ref = receiptRef(account,eventId);
  const review = async (code: string) => {
    await db.prepare(`UPDATE workflow_steps SET error_code=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key='apply' AND status='pending'`)
      .bind(code,ref.scopeId,ref.processKind,ref.subjectId).run();
    return 'review_required' as const;
  };
  if (event.apiVersion !== STRIPE_BOOKING_API_VERSION) return review('stripe_api_version_unsupported');
  if (!BOOKING_STRIPE_EVENT_KINDS[event.object.kind]?.includes(event.type)) return review('stripe_event_type_unsupported');
  const bound = await getWorkflowStep(db,{scopeId: bindingScope(account),processKind: BINDING_PROCESS,subjectId: event.object.id,stepKey: 'binding'});
  if (!bound) return 'pending';
  const binding = JSON.parse(bound.input_json!) as BookingStripeBinding;
  if (binding.connectAccount !== event.account || binding.objectId !== event.object.id || binding.objectKind !== event.object.kind
    || (event.object.kind === 'checkout.session' && event.object.checkoutMode !== (binding.purpose === 'payment_method' ? 'setup' : 'payment'))
    || binding.customerId !== event.object.customer || (binding.purpose !== 'payment_method' && (binding.amount !== event.object.amount || binding.currency !== event.object.currency))
    || (receipt.input.retentionAccountId !== null && receipt.input.retentionAccountId !== binding.accountId)) return review('stripe_binding_mismatch');
  // 後からの再接続先へ付け替えない。元の店・本人・tenantが残ることもbatchで再検査する。
  const guard = db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id JOIN friends f ON f.line_account_id=a.id
    WHERE a.id=? AND a.tenant_id=? AND a.is_active=1 AND a.data_purged_at IS NULL AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL AND t.status='active' AND f.id=? AND f.data_purged_at IS NULL) THEN 'true' ELSE 'stripe_binding_scope_mismatch' END)`)
    .bind(binding.accountId,binding.tenantId,binding.friendId);
  const claimed = await claimWorkflowStep(db,ref,options);
  if (!claimed?.lease_owner) return 'processing';
  try {
    const statements = await prepare({event,binding,receiptId: await bookingStripeReceiptId(account,eventId)});
    await finishWorkflowStep(db,ref,claimed.lease_owner,{now: options.now,result: {applied: true},statements: [guard,...statements]});
    return 'applied';
  } catch (error) {
    // この口はDB内の反映だけ。失敗したbatchは未適用なので回数を戻して安全に再開する。
    await releaseWorkflowStep(db,ref,claimed.lease_owner,options.now);
    throw error;
  }
}
