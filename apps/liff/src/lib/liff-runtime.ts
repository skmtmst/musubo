import sdk from '@line/liff';

/** 共用画面では、入口がすでに初期化した LIFF を使う。 */
export interface CustomerLiffRuntime {
  getProfile(): Promise<{ userId: string; displayName: string }>;
  getAccessToken(): string | null;
  closeWindow(): void;
  openWindow?(options:{url:string;external:boolean}): void;
}

let runtime: CustomerLiffRuntime | null = null;
export function setCustomerLiffRuntime(value: CustomerLiffRuntime | null): void {
  runtime = value;
}

export default {
  getProfile: () => (runtime ?? sdk).getProfile(),
  getAccessToken: () => (runtime ?? sdk).getAccessToken(),
  closeWindow: () => (runtime ?? sdk).closeWindow(),
  openWindow: (options:{url:string;external:boolean}) => runtime?.openWindow ? runtime.openWindow(options) : sdk.openWindow(options),
};
