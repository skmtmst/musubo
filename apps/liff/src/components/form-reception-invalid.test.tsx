// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FormAvailability } from '@line-crm/shared';
import FormReception from './form-reception.js';

afterEach(cleanup);

const valid: FormAvailability = {
  accepting: true, reason: null, deadlineAt: '2099-10-20T01:00:00Z',
  oncePerFriend: false, totalRemaining: 2, choices: {},
};

function Reception({ initial }: { initial: FormAvailability }) {
  const [availability, setAvailability] = useState(initial);
  return <><FormReception availability={availability} /><button onClick={() => setAvailability(valid)}>更新</button></>;
}

describe('受付条件の不正な値', () => {
  it('不正な締め切りを確認できないと伝え、更新後は日時を表示する', () => {
    render(<Reception initial={{ ...valid, deadlineAt: 'invalid' }} />);
    expect(screen.getByText('締め切りを確認できません')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(screen.queryByText('締め切りを確認できません')).toBeNull();
    expect(screen.getByText(/締め切り：/)).toBeTruthy();
  });

  it('不正な残り件数を確認できないと伝え、更新後は件数を表示する', () => {
    render(<Reception initial={{ ...valid, totalRemaining: -1 }} />);
    expect(screen.getByText('受付の残り件数を確認できません')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(screen.getByText('受付上限まで残り2件（送信時に確定します）')).toBeTruthy();
  });
});
