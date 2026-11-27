// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { VisitStampSettings } from '@line-crm/shared';
import StampConditions from './stamp-conditions.js';

afterEach(cleanup);
const valid: VisitStampSettings = {
  mode: 'visit', amountUnit: 1000, firstVisitBonus: 1, receiptBonus: 0,
  maxPerVisit: 10, expiryMonths: null, timezone: 'Asia/Tokyo',
  stackingOrder: 'multipliers_then_bonus',
  multipliers: [{ name: '曜日の倍率', multiplier: 2, weekdays: [1] }],
  rankMultipliers: [], rewards: [],
};
function Conditions({ initial }: { initial: VisitStampSettings }) {
  const [settings, setSettings] = useState(initial);
  return <><StampConditions settings={settings} /><button onClick={() => setSettings(valid)}>更新</button></>;
}
it('未知の曜日をそのまま表示せず、更新後は正しい曜日を示す', () => {
  render(<Conditions initial={{ ...valid, multipliers: [{ name: '曜日の倍率', multiplier: 2, weekdays: [9] }] }} />);
  expect(screen.getByText(/対象の曜日を確認できません/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('曜日の倍率：2倍（月曜日）')).toBeTruthy();
});
it('未知の適用順を決めつけず、更新後は正しい順序を示す', () => {
  render(<Conditions initial={{ ...valid, stackingOrder: 'unknown' as VisitStampSettings['stackingOrder'] }} />);
  expect(screen.getByText('倍率と初回ボーナスの適用順を確認できません')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('倍率をかけてから初回ボーナスを足します')).toBeTruthy();
});
