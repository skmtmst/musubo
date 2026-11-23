import { CredentialEncryptionKeyError, decryptCredential, encryptCredential } from '@line-crm/db';
import type { ConnectionProvider } from './booking-meeting-create.js';

type Scope = { accountId: string; staffId: string; provider: ConnectionProvider };
export type MeetingKeys = { activeId: string; keys: Record<string, string>; legacyKey: string; writeV2?: boolean; rejectLegacy?: boolean };
export type MeetingKeyInput = string | MeetingKeys;
export class MeetingKeyConfigurationError extends Error { constructor() { super('invalid_meeting_key_config'); } }

/** The LINE key remains the legacy key; a separate meeting ring may be deployed gradually. */
export function meetingCredentialKeys(env: { LINE_CREDENTIAL_ENCRYPTION_KEY?: string; BOOKING_MEETING_CREDENTIAL_KEYS?: string; BOOKING_MEETING_CREDENTIAL_V2_ENABLED?: string; BOOKING_MEETING_CREDENTIAL_REJECT_V1?: string }): MeetingKeys {
  const legacyKey = env.LINE_CREDENTIAL_ENCRYPTION_KEY ?? '';
  const writeV2 = env.BOOKING_MEETING_CREDENTIAL_V2_ENABLED === 'true';
  const rejectLegacy = env.BOOKING_MEETING_CREDENTIAL_REJECT_V1 === 'true';
  if (rejectLegacy && !writeV2) throw new Error('invalid_meeting_key_config');
  if (!env.BOOKING_MEETING_CREDENTIAL_KEYS) return { activeId: 'line', keys: { line: legacyKey }, legacyKey, writeV2, rejectLegacy };
  const value: unknown = JSON.parse(env.BOOKING_MEETING_CREDENTIAL_KEYS);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_meeting_key_config');
  const ring = value as Record<string, unknown>;
  if (typeof ring.activeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ring.activeId) || !ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys)) throw new Error('invalid_meeting_key_config');
  const keys = ring.keys as Record<string, unknown>;
  if ('line' in keys) throw new MeetingKeyConfigurationError();
  if (!Object.entries(keys).every(([id, key]) => /^[A-Za-z0-9_-]{1,64}$/.test(id) && typeof key === 'string' && key.length > 0) || typeof keys[ring.activeId] !== 'string') throw new Error('invalid_meeting_key_config');
  return { activeId: ring.activeId, keys: { line: legacyKey, ...keys } as Record<string, string>, legacyKey, writeV2, rejectLegacy };
}
function ringOf(input: MeetingKeyInput): MeetingKeys { return typeof input === 'string' ? { activeId: 'line', keys: { line: input }, legacyKey: input, writeV2: false } : input; }
function encode(bytes: Uint8Array): string { return btoa(Array.from(bytes, c => String.fromCharCode(c)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decode(value: string): Uint8Array { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_meeting_credential'); const s = value.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s.padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0)); }
function buffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
async function key(secret: string | undefined): Promise<CryptoKey> { try { if (!secret) throw new Error(); const raw = decode(secret.trim().replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')); if (raw.length !== 32) throw new Error(); return await crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']); } catch { throw new MeetingKeyConfigurationError(); } }
export async function validateMeetingEncryptionKey(input: MeetingKeyInput): Promise<void> { const ring = ringOf(input); await key(ring.writeV2 === false ? ring.legacyKey : ring.keys[ring.activeId]); }
function aad(scope: Scope, id: string): ArrayBuffer { return buffer(new TextEncoder().encode(JSON.stringify(['booking-meeting-v2', scope.accountId, scope.staffId, scope.provider, id]))); }
export async function encryptMeetingCredential(value: string, input: MeetingKeyInput, scope: Scope): Promise<string> {
 const ring = ringOf(input), id = ring.activeId, iv = crypto.getRandomValues(new Uint8Array(12));
 if (ring.writeV2 === false) return encryptCredential(value, ring.legacyKey);
 if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid_meeting_key_config');
 const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(iv), additionalData: aad(scope, id) }, await key(ring.keys[id]), buffer(new TextEncoder().encode(value)));
 return `v2.${id}.${encode(iv)}.${encode(new Uint8Array(cipher))}`;
}
export async function decryptMeetingCredential(value: string, input: MeetingKeyInput, scope: Scope): Promise<{ plaintext: string; needsRotation: boolean }> {
 const ring = ringOf(input);
 if (value.startsWith('v1.')) { if (ring.rejectLegacy) throw new MeetingKeyConfigurationError(); try { return { plaintext: await decryptCredential(value, ring.legacyKey), needsRotation: ring.writeV2 !== false }; } catch (error) { if (error instanceof CredentialEncryptionKeyError) throw new MeetingKeyConfigurationError(); throw error; } }
 const parts = value.split('.'); if (parts.length !== 4 || parts[0] !== 'v2' || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[1])) throw new Error('invalid_meeting_credential');
 const iv = decode(parts[2]); if (iv.length !== 12) throw new Error('invalid_meeting_credential');
 const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(iv), additionalData: aad(scope, parts[1]) }, await key(ring.keys[parts[1]]), buffer(decode(parts[3])));
 return { plaintext: new TextDecoder().decode(plain), needsRotation: ring.writeV2 !== false && parts[1] !== ring.activeId };
}
