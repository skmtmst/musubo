import { useEffect, useRef, useState } from 'react';
import { api, type PostalCodeCandidate } from '../lib/api.js';
import Button from './ui/button/index.js';
import { AddressControls } from './forms/controls';


/** 回答の住所の形。空欄は空文字に寄せる（未入力判定と一致させるため）。 */
type AddressDraft = {
  postalCode: string;
  prefecture: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
};


/**
 * 住所は郵便番号→自動補完＋手入力。候補が複数の番号は選んでもらう。
 * 選ばなければ手入力の住所はそのまま残す（上書きは選んだときだけ）。
 */
function AddressFields({
  name,
  draft,
  onChange,
  placeholder,
}: {
  name: string;
  draft: AddressDraft;
  onChange: (name: string, value: unknown) => void;
  placeholder?: string;
}) {
  const [candidates, setCandidates] = useState<PostalCodeCandidate[]>([]);
  const [looking, setLooking] = useState(false);
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  // 調べている間に書いた欄を、届いた応答で古い中身に戻さないため、
  // いちばん新しい住所を持っておく（応答のときはこれに足す）。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 調べた郵便番号の回。郵便番号を書き換えたら古い応答・候補は使わない。
  const lookupGenRef = useRef(0);
  useEffect(
    () => () => {
      lookupGenRef.current += 1;
    },
    [],
  );

  const patch = (next: AddressDraft) => onChange(name, next);

  const applyCandidate = (c: PostalCodeCandidate) => {
    const latest = draftRef.current;
    patch({
      ...latest,
      prefecture: c.prefecture,
      city: c.city,
      // 町名は番地欄が空のときだけ入れる。書いた番地は消さない。
      addressLine1: latest.addressLine1 || c.town,
    });
    setCandidates([]);
    setLookupMessage(null);
  };

  const lookup = async () => {
    const searched = draft.postalCode;
    const gen = ++lookupGenRef.current;
    setLooking(true);
    setLookupMessage(null);
    // 応答を使ってよいか（この回が最新で、郵便番号も調べた時のまま）。
    const stillCurrent = () =>
      gen === lookupGenRef.current && draftRef.current.postalCode === searched;
    try {
      const res = await api.postalCodeSearch(searched);
      if (!stillCurrent()) return;
      if (!res.success) throw new Error('postal_code_search_failed');
      const data = res.data;
      if (!data || !['invalid', 'none', 'matched', 'multiple'].includes(data.status) ||
          !Array.isArray(data.candidates) ||
          (data.status === 'matched' && data.candidates.length !== 1) ||
          (data.status === 'multiple' && data.candidates.length < 2) ||
          !data.candidates.every(c => c && typeof c.postalCode === 'string' &&
            typeof c.prefecture === 'string' && typeof c.city === 'string' && typeof c.town === 'string')) {
        throw new Error('postal_code_search_invalid_response');
      }
      if (data.status === 'matched' && data.candidates.length === 1) {
        applyCandidate(data.candidates[0]);
        return;
      }
      if (data.status === 'multiple') {
        setCandidates(data.candidates);
        return;
      }
      setCandidates([]);
      setLookupMessage(
        data.status === 'invalid'
          ? '郵便番号は 123-4567 のように入力してください'
          : 'その郵便番号の住所が見つかりません。下の欄へ直接入力してください',
      );
    } catch {
      if (!stillCurrent()) return;
      setCandidates([]);
      setLookupMessage('住所を調べられませんでした。下の欄へ直接入力してください');
    } finally {
      if (gen === lookupGenRef.current) setLooking(false);
    }
  };

  return (
    <AddressControls draft={draft} placeholder={placeholder} looking={looking} onLookup={() => void lookup()} onChange={(next) => {
      if (next.postalCode !== draft.postalCode) {
        lookupGenRef.current += 1;
        setLooking(false);
        setCandidates([]);
      }
      patch(next);
    }}>
      {candidates.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-ink-faint">候補が複数あります。選んでください</p>
          {candidates.map((c) => (
            <Button variant="option"
              key={`${c.postalCode}-${c.town}`}
              type="button"
              onClick={() => applyCandidate(c)}
            >
              {c.prefecture}
              {c.city}
              {c.town}
            </Button>
          ))}
        </div>
      )}
      {lookupMessage && <p className="text-xs text-ink-faint">{lookupMessage}</p>}
    </AddressControls>
  );
}
export { type AddressDraft, AddressFields }
