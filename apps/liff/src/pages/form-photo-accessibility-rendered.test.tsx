// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { emptyLayout } from '@line-crm/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Form from './form.js';

const requests = vi.hoisted(() => ({ getForm: vi.fn(), submitForm: vi.fn(), uploadFormFile: vi.fn() }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: { ...requests, liffConfig: vi.fn().mockResolvedValue({ data: {} }) } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('複数の添付写真を読み上げで確認し、１枚だけ外しても入力と他の写真を保つ', async () => {
  const layout = emptyLayout();
  layout.sections[0].blocks = [
    { id: 'name', kind: 'input', type: 'text', name: 'name', label: 'お名前', required: true },
    { id: 'photo', kind: 'input', type: 'file', name: 'photo', label: '添付画像', fileKinds: ['image', 'pdf'], fileMaxCount: 2 },
  ];
  requests.getForm.mockResolvedValue({ id: 'form', name: '受付', description: '', isActive: true, layout });
  requests.uploadFormFile.mockResolvedValueOnce({ success: true, data: { file: { fileId: 'first', filename: 'first.png', mimeType: 'image/png', state: 'ready', side: 'single' } } })
    .mockResolvedValueOnce({ success: true, data: { file: { fileId: 'second', filename: 'second.png', mimeType: 'image/png', state: 'ready', side: 'single' } } });
  vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  render(<MemoryRouter initialEntries={['/forms/form']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);

  const name = await screen.findByRole('textbox', { name: /お名前/ });
  fireEvent.change(name, { target: { value: '利用者' } });
  const input = screen.getByLabelText('添付画像', { selector: 'input' });
  fireEvent.change(input, { target: { files: [new File(['first'], 'first.png', { type: 'image/png' })] } });
  await screen.findByRole('button', { name: 'first.pngを外す' });
  expect(screen.getByRole('img', { name: '送った写真' }).getAttribute('src')).toBe('blob:first');
  fireEvent.change(input, { target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] } });
  await screen.findByRole('button', { name: 'second.pngを外す' });
  expect(screen.getAllByRole('img', { name: '送った写真' })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'first.pngを外す' }));
  expect(screen.getByRole('img', { name: '送った写真' }).getAttribute('src')).toBe('blob:second');
  expect((name as HTMLInputElement).value).toBe('利用者');
  expect(revoke).toHaveBeenCalledWith('blob:first');
  expect(requests.submitForm).not.toHaveBeenCalled();
});
