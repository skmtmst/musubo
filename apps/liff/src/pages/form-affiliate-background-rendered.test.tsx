import { cleanup, fireEvent, render } from '@testing-library/react';
import { Window } from 'happy-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { emptyLayout } from '@line-crm/shared';
import Affiliate from './affiliate.js';
import Form from './form.js';
import { api } from '../lib/api.js';
import * as profile from '../lib/affiliate-profile-api.js';
import { STYLE_BROWSER_HOOK_TIMEOUT, styleBrowser } from '../test-utils/style-browser.js';

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn(), getAccessToken: () => 'identity' } }));
vi.mock('../lib/api.js', () => ({ api: { getForm: vi.fn(), submitForm: vi.fn(), liffConfig: vi.fn().mockResolvedValue({ data: {} }) } }));
vi.mock('../lib/affiliate-profile-api.js', () => ({ fetchMe: vi.fn(), fetchMileage: vi.fn(), fetchOffers: vi.fn(), postRegister: vi.fn(), postEnrollOffer: vi.fn(), postAddLink: vi.fn() }));
vi.mock('../components/member-card.js', () => ({ default: () => null }));
vi.mock('../components/mileage-rewards.js', () => ({ default: () => null }));
vi.mock('../components/affiliate-payments.js', () => ({ default: () => null }));

let view: Awaited<ReturnType<typeof styleBrowser>>;
beforeAll(async () => { view = await styleBrowser(); }, STYLE_BROWSER_HOOK_TIMEOUT);
beforeEach(() => {
  const browser = new Window({ url: 'https://example.test/' });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', browser.document);
  vi.stubGlobal('HTMLElement', browser.HTMLElement);
  vi.stubGlobal('navigator', browser.navigator);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await view?.browser.close(); });

async function expectWhitePage(html: string) {
  await view.show(html);
  expect(await view.page.locator('body > div').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
}

it('紹介画面で登録を始められ、画面の背景は白い', async () => {
  vi.mocked(profile.fetchMe).mockResolvedValue({ registered: false });
  vi.mocked(profile.fetchMileage).mockResolvedValue({ mileage: { programId: 'program', programName: 'マイル', available: 0, balanceSource: 'musubo', pending: 0, lifetimeEarned: 0, spent: 0 }, insights: { accountCount: 0, rewardedActions: 0, referralMiles: 0, qualityReferralCount: 0, lastEarnedAt: null }, history: [], opportunities: [] });
  vi.mocked(profile.fetchOffers).mockResolvedValue([]);
  vi.mocked(profile.postRegister).mockResolvedValue({ affiliate: { id: 'affiliate', name: '会員', code: 'code', commissionRate: 0, isActive: true, friendId: 'friend' }, links: [] });
  const rendered = render(<Affiliate />);
  const button = await rendered.findByRole('button', { name: '紹介者になる' });
  await expectWhitePage(rendered.container.innerHTML);
  fireEvent.click(button);
  expect(profile.postRegister).toHaveBeenCalledOnce();
});

it('フォームに入力でき、入力中の背景は白い', async () => {
  const layout = emptyLayout();
  layout.sections[0].blocks = [{ id: 'name', kind: 'input', type: 'text', name: 'name', label: 'お名前', required: true }];
  vi.mocked(api.getForm).mockResolvedValue({ id: 'form', name: '受付', description: '', isActive: true, layout });
  const rendered = render(<MemoryRouter initialEntries={['/forms/form']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);
  const input = await rendered.findByRole('textbox', { name: /お名前/ });
  fireEvent.change(input, { target: { value: '利用者' } });
  expect((input as HTMLInputElement).value).toBe('利用者');
  await expectWhitePage(rendered.container.innerHTML);
});
