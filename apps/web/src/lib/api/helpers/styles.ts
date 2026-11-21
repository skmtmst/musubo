import type { AccountStyle, HqOverdueAttention, StyleTemplateSample, StarterCatalogDefinition, StarterCatalogOption, StarterCatalogSelection, StarterCatalogDetails } from '@line-crm/shared';
import { fetchApi } from '../../api';

import {
  write,
  Result,
  StarterSetItem,
  StyleStarterSet,
  StyleStarterDefault,
  StyleStarterResetResult,
  StarterDistributionInput,
  StarterDistributionPreview,
} from './styles-common';
export type * from './styles-common';
import { methods1 } from './style-methods-1';
import { methods2 } from './style-methods-2';
export const styleApi = { ...methods1, ...methods2 };

export const hqStyleApi = {
  catalogDetails: (selection:StarterCatalogSelection)=>fetchApi<Result<StarterCatalogDetails>>(`/api/hq/style-starter-sets/catalog/${encodeURIComponent(selection.templateId)}/versions/${encodeURIComponent(selection.versionId)}?kind=${encodeURIComponent(selection.kind)}`),
  catalog: () => fetchApi<Result<StarterCatalogOption[]>>('/api/hq/style-starter-sets/catalog'),
  templateSamples: (style: AccountStyle) =>
    fetchApi<Result<{ style: AccountStyle; items: StyleTemplateSample[] }>>(
      '/api/hq/style-template-samples?' + new URLSearchParams({ style }),
    ),
  listStarterSets: () =>
    fetchApi<Result<StyleStarterSet[]>>('/api/hq/style-starter-sets'),
  saveStarterSet: (
    style: AccountStyle,
    body: {
      expectedVersion: number;
      name: string;
      autoInsert?: boolean;
      definition: { items: StarterSetItem[] } | StarterCatalogDefinition;
      confirmed?: boolean;
    },
  ) =>
    fetchApi<Result<{ id: string; version: number; autoInsert: boolean }>>(
      '/api/hq/style-starter-sets/' + encodeURIComponent(style),
      write('PUT', body),
    ),
  defaultStarterSet: (style: AccountStyle) =>
    fetchApi<Result<StyleStarterDefault>>(
      '/api/hq/style-starter-sets/' + encodeURIComponent(style) + '/default',
    ),
  resetStarterSet: (
    style: AccountStyle,
    body: { expectedVersion: number; confirmed: true },
  ) =>
    fetchApi<Result<StyleStarterResetResult>>(
      '/api/hq/style-starter-sets/' + encodeURIComponent(style) + '/reset',
      write('POST', body),
    ),
  preflight: (style: AccountStyle, body: StarterDistributionInput) =>
    fetchApi<Result<StarterDistributionPreview>>(
      '/api/hq/style-starter-sets/' + encodeURIComponent(style) + '/preflight',
      write('POST', body),
    ),
  distribute: (
    style: AccountStyle,
    body: StarterDistributionInput & {
      token: string;
      confirmed: true;
      editedAction?: 'notify' | 'new_copy';
    },
  ) =>
    fetchApi<
      Result<{
        accountCount: number;
        items: Array<{
          accountId: string;
          key: string;
          action: string;
          message?: string;
        }>;
      }>
    >(
      '/api/hq/style-starter-sets/' + encodeURIComponent(style) + '/distribute',
      write('POST', body),
    ),
  attention: (options?: { cache?: 'reload' }) =>
    fetchApi<
      Result<{
        asOf: string;
        items: Array<{
          accountId: string;
          style: AccountStyle;
          name: string;
          counts: Record<string, number>;
          overdue: HqOverdueAttention;
          details: Record<string, Array<{ id: string; href?: string }>>;
        }>;
      }>
    >('/api/hq/style-attention', options),
};
