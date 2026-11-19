import { tzDateStr } from '../../services/availability.js';

export function prepareAutoLineLiveCap(db: D1Database, accountId: string, intentId: string, now: Date, reservationId: string): D1PreparedStatement {
  const at = now.toISOString();
  const dayJst = tzDateStr('Asia/Tokyo', now);
  // Every check and the insert share a single SQLite write statement. Missing or
  // contradictory identity, consent, or product evidence leaves the candidate held.
  return db.prepare(`INSERT INTO ec_auto_line_cap_reservations
    (id, tenant_id, user_id, account_id, friend_id, live_intent_id, mode, canonical_product_id, source_product_id, day_jst, reserved_at, state)
    SELECT ?, a.tenant_id, l.user_id, a.id, f.id, s.id, 'live', p.canonical_product_id, s.product_id, ?, ?, 'reserved'
    FROM ec_auto_line_live_intents s
    JOIN line_accounts a ON a.id=s.account_id AND a.tenant_id IS NOT NULL
    JOIN friends f ON f.id=s.friend_id AND f.line_account_id=a.id AND f.is_following=1
    JOIN friend_identity_links l ON l.friend_id=f.id AND l.tenant_id=a.tenant_id AND l.unlinked_at IS NULL
    JOIN identity_candidates ic ON ic.id=l.candidate_id AND ic.tenant_id=a.tenant_id AND ic.status='linked'
    JOIN users u ON u.id=l.user_id AND u.tenant_id=a.tenant_id AND u.status='active'
    JOIN ec_auto_line_product_identities p ON p.tenant_id=a.tenant_id AND p.account_id=a.id
      AND p.product_id=s.product_id AND p.revoked_at IS NULL AND length(trim(p.canonical_product_id))>0
      AND length(trim(p.evidence_ref))>0 AND julianday(p.verified_at) IS NOT NULL AND julianday(p.verified_at)<=julianday(?)
    WHERE s.id=? AND a.id=? AND s.state='scheduled' AND s.kind IN ('cart','browse','restock')
      AND julianday(s.due_at)<=julianday(?)
      AND EXISTS (SELECT 1 FROM friend_delivery_consents c WHERE c.line_account_id=a.id AND c.friend_id=f.id
        AND c.purpose IN ('promotion','marketing','advertising','宣伝') AND c.state='granted')
      AND NOT EXISTS (SELECT 1 FROM friend_delivery_consents c WHERE c.line_account_id=a.id AND c.friend_id=f.id
        AND c.purpose IN ('promotion','marketing','advertising','宣伝') AND c.state!='granted')
      AND NOT EXISTS (SELECT 1 FROM friend_identity_links h WHERE h.friend_id=f.id AND (h.tenant_id!=a.tenant_id OR h.user_id!=l.user_id))
      AND NOT EXISTS (SELECT 1 FROM friend_identity_links h JOIN friend_identity_links other ON other.friend_id=h.friend_id
        WHERE h.tenant_id=a.tenant_id AND h.user_id=l.user_id AND (other.tenant_id!=a.tenant_id OR other.user_id!=l.user_id))
      AND julianday(s.due_at) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ec_auto_line_live_intents earlier
        JOIN line_accounts ea ON ea.id=earlier.account_id AND ea.tenant_id=a.tenant_id
        JOIN friend_identity_links el ON el.friend_id=earlier.friend_id AND el.tenant_id=a.tenant_id
          AND el.user_id=l.user_id AND el.unlinked_at IS NULL
        WHERE earlier.id!=s.id AND earlier.state='scheduled' AND julianday(earlier.due_at)>julianday(?,'-3 hours')
          AND EXISTS(SELECT 1 FROM account_settings test JOIN json_each(CASE WHEN json_valid(test.value) THEN CASE WHEN json_type(test.value)='array' THEN test.value ELSE '[]' END ELSE '[]' END) recipient
            WHERE test.line_account_id=earlier.account_id AND test.key='test_recipients' AND recipient.type='text' AND recipient.value=earlier.friend_id
            AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(test.value) THEN CASE WHEN json_type(test.value)='array' THEN test.value ELSE '[]' END ELSE '[]' END) invalid WHERE invalid.type!='text' OR length(trim(invalid.value))=0))
          AND (julianday(earlier.due_at) IS NULL
            OR julianday(earlier.due_at)<julianday(s.due_at)
            OR (julianday(earlier.due_at)=julianday(s.due_at) AND earlier.id<s.id)))
      AND NOT EXISTS (SELECT 1 FROM ec_auto_line_cap_reservations x
        LEFT JOIN ec_auto_line_product_identities oldp ON oldp.tenant_id=x.tenant_id AND oldp.account_id=x.account_id AND oldp.product_id=x.source_product_id
        WHERE x.tenant_id=a.tenant_id AND x.user_id=l.user_id AND x.mode='live' AND x.state!='released'
          AND julianday(x.reserved_at)>julianday(?,'-30 days')
          AND (oldp.product_id IS NULL OR oldp.revoked_at IS NOT NULL OR length(trim(oldp.evidence_ref))=0
            OR julianday(oldp.verified_at) IS NULL OR oldp.canonical_product_id!=x.canonical_product_id))
      AND NOT EXISTS (SELECT 1 FROM ec_auto_line_cap_reservations x WHERE x.tenant_id=a.tenant_id AND x.user_id=l.user_id AND x.mode='live'
        AND x.state IN ('started', 'unknown'))
      AND NOT EXISTS (SELECT 1 FROM ec_auto_line_cap_reservations x WHERE x.tenant_id=a.tenant_id AND x.user_id=l.user_id AND x.mode='live'
        AND x.state!='released' AND (x.day_jst=? OR (x.canonical_product_id=p.canonical_product_id
          AND julianday(x.reserved_at)>julianday(?,'-30 days'))))
      AND (SELECT count(*) FROM ec_auto_line_cap_reservations x WHERE x.tenant_id=a.tenant_id AND x.user_id=l.user_id AND x.mode='live'
        AND x.state!='released' AND julianday(x.reserved_at)>julianday(?,'-7 days')) < 3
    ON CONFLICT DO NOTHING`).bind(reservationId, dayJst, at, at, intentId, accountId, at, at, at, dayJst, at, at);
}
