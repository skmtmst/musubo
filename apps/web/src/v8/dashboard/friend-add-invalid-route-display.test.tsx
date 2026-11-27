// @vitest-environment happy-dom
import type {ReactNode,ComponentProps} from 'react';
import {render,screen,waitFor,cleanup,fireEvent} from '@testing-library/react';
import {test,expect,vi,afterEach} from 'vitest';
const net=vi.hoisted(()=>({list:vi.fn()}));
vi.mock('@/lib/api',()=>({api:{entryRoutes:{list:net.list}}}));
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:'synthetic-account',selectedAccount:{channelId:'synthetic',displayName:'Synthetic'}})}));
vi.mock('@/lib/use-same-page-url',()=>({useSamePageUrl:()=>({replace:vi.fn()})}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams()}));
vi.mock('@/components/dashboard/qr-dialog',()=>({default:()=>null}));
vi.mock('@/components/shared/copy-text-button',()=>({default:()=> <span>Copy boundary</span>}));
vi.mock('@/components/shared/entity-select',()=>({entityOptionMetadata:()=>({}),default:({options}:{options:{value:string;label:ReactNode}[]})=><select aria-label="routes">{options.map((o:{value:string;label:ReactNode})=><option key={o.value} value={o.value}>{o.label}</option>)}</select>}));
vi.mock('@/components/shared/save-form-errors',()=>({SaveErrorField:({children}:{children:ReactNode})=>children}));
vi.mock('@/components/shared/button',()=>({default:({children,...p}:ComponentProps<'button'>)=><button {...p}>{children}</button>}));
vi.mock('@/v8/dashboard/head',()=>({default:()=> <h2>Friend link</h2>}));
import {FriendAddLink} from '@/v8/dashboard/friend-add';
afterEach(()=>{cleanup();vi.clearAllMocks()});
test('状態の不正な経路を有効と扱わず、読み直せる',async()=>{
 net.list.mockResolvedValueOnce({success:true,data:[{id:'route1',name:'不正な経路',refCode:'ref1',isActive:'false'}]}).mockResolvedValue({success:true,data:[]});
 render(<FriendAddLink officialProfileUrl={null} canManage={false}/>);
 expect(await screen.findByText('経路を読み込めませんでした')).toBeTruthy();
 expect(screen.queryByRole('option',{name:'不正な経路'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/もう一度/}));
 await waitFor(()=>expect(screen.queryByText('経路を読み込めませんでした')).toBeNull());
 expect(screen.getAllByRole('option')).toHaveLength(1);
});
