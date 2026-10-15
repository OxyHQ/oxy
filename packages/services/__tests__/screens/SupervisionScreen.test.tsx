import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {PurchaseApproval,SupervisionState} from '@oxy.so/contracts';
const child={childAccountId:'child',guardianAccountId:'guardian',status:'active' as const,policyVersion:'2' as const,consentVersion:'1',createdAt:'2026-10-15T00:00:00.000Z'};
const purchase:PurchaseApproval={id:'approval',childAccountId:'child',applicationId:'mercaria',operationId:'order',resourceId:'checkout',cartFingerprint:'a'.repeat(64),paymentFingerprint:'b'.repeat(64),summary:'Two items',merchantAccountIds:['seller-a','seller-b'],lineItems:[{itemReference:'line-a',title:'Coat',optionsText:'Blue / Medium',merchantAccountId:'seller-a',quantity:1,unitAmountMinor:1000,lineAmountMinor:1000},{itemReference:'line-b',title:'Shoes',optionsText:'Size 42',merchantAccountId:'seller-b',quantity:1,unitAmountMinor:2000,lineAmountMinor:2000}],shippingMinor:200,taxMinor:100,discountMinor:0,roundingAdjustmentMinor:1,amountMinor:3301,currency:'EUR',expiresAt:'2027-01-01T00:00:00.000Z',createdAt:'2026-10-15T00:00:00.000Z',status:'pending',receiptReference:null};
let account='guardian',session='session-a';
let state:SupervisionState;
const safety={supervisionState:jest.fn(async()=>state),contacts:jest.fn(async()=>({items:[]})),purchaseApprovals:jest.fn(async()=>({items:[],nextCursor:null})),purchaseApproval:jest.fn(async()=>purchase),people:jest.fn(async({accountIds}:{accountIds?:string[]})=>({items:(accountIds??[]).map(id=>({accountId:id,displayName:id==='seller-a'?'Personal seller':'Merchant '+id,username:id}))})),reviewPurchaseApproval:jest.fn(async()=>purchase),cancelGuardianInvitation:jest.fn(async()=>undefined)};
jest.mock('../../src/ui/context/OxyContext',()=>({useOxy:()=>({user:{id:account,kind:'personal'},activeSessionId:session,isAuthenticated:true,oxyServices:{safety}})}));
jest.mock('../../src/ui/stores/authStore',()=>({useAuthStore:{getState:()=>({user:{id:account}})}}));
jest.mock('../../src/ui/hooks/useSurfaceHeader',()=>({useSurfaceHeader:jest.fn()}));
jest.mock('../../src/ui/hooks/useI18n',()=>({useI18n:()=>({t:(key:string)=>key,locale:'en-US'})}));
jest.mock('../../src/ui/hooks/queries/useAuthMethods',()=>({useSignInMethods:()=>({data:{hasPassword:true,hasEmail:false,totpEnabled:false}})}));
jest.mock('../../src/ui/components/signIn/ReauthStep',()=>({ReauthStep:({children,onSubmit}:{children:React.ReactNode;onSubmit:(proof:unknown)=>Promise<void>})=><div>{children}<button onClick={()=>void onSubmit({method:'password',password:'fresh-proof'})}>Fresh confirmation</button></div>}));
import SupervisionScreen from '../../src/ui/screens/SupervisionScreen';
import {formatApprovalAmount} from '../../src/ui/components/supervision/presentation';
const clients:QueryClient[]=[];
function mount(approvalId?:string){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);const tree=()=> <QueryClientProvider client={client}><SupervisionScreen approvalId={approvalId}/></QueryClientProvider>;return {...render(tree()),tree,client};}
beforeEach(()=>{jest.clearAllMocks();account='guardian';session='session-a';state={self:null,children:[child],invitations:[]};safety.supervisionState.mockImplementation(async()=>state);safety.people.mockImplementation(async({accountIds})=>({items:(accountIds??[]).map(id=>({accountId:id,displayName:id==='seller-a'?'Personal seller':'Merchant '+id,username:id}))}));safety.purchaseApproval.mockResolvedValue(purchase);});
afterEach(()=>{clients.splice(0).forEach(client=>client.clear());});
it('opens the exact approval and shows every option, merchant and amount before fresh guardian approval',async()=>{
 mount('approval');
 expect(await screen.findByText('Blue / Medium')).toBeTruthy();expect(screen.getByText('Size 42')).toBeTruthy();
 expect(await screen.findByText('Personal seller')).toBeTruthy();expect(screen.getByText('supervision.rounding: 0.01 EUR')).toBeTruthy();
 await waitFor(()=>expect((screen.getByText('supervision.approvePurchase') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByText('supervision.approvePurchase'));
 expect(safety.reviewPurchaseApproval).not.toHaveBeenCalled();
 expect(screen.getByText('Blue / Medium')).toBeTruthy();
 fireEvent.click(screen.getByText('Fresh confirmation'));
 await waitFor(()=>expect(safety.reviewPurchaseApproval).toHaveBeenCalledWith('approval',{decision:'approved',reauth:{method:'password',password:'fresh-proof'}}));
});
it('allows the child to read its own pending approval without guardian controls',async()=>{
 account='child';state={self:child,children:[],invitations:[]};mount('approval');
 expect(await screen.findByText('Blue / Medium')).toBeTruthy();expect(screen.queryByText('supervision.approvePurchase')).toBeNull();
});
it('does not describe a pending invitation as active supervision',async()=>{
 account='child';state={self:null,children:[],invitations:[{id:'invite',childAccountId:'child',guardianAccountId:'guardian',status:'pending',consentVersion:'1',createdAt:'2026-10-15T00:00:00.000Z',expiresAt:'2027-01-01T00:00:00.000Z'}]};mount();
 expect(await screen.findByText('supervision.notActive')).toBeTruthy();expect(screen.getByText('supervision.pendingDescription')).toBeTruthy();expect(screen.queryByText('supervision.active')).toBeNull();expect(screen.queryByText('supervision.accept')).toBeNull();
});
it('hides retained purchase evidence after access is revoked',async()=>{
 const {client}=mount('approval');await screen.findByText('Blue / Medium');
 safety.purchaseApproval.mockRejectedValue(new Error('forbidden'));
 await act(async()=>{await client.invalidateQueries({queryKey:['oxy','safety','purchase']});});
 await waitFor(()=>expect(screen.queryByText('Blue / Medium')).toBeNull());expect(screen.queryByText('supervision.approvePurchase')).toBeNull();
});
it('does not approve a purchase when a personal merchant identity is unavailable',async()=>{
 safety.people.mockResolvedValue({items:[]});mount('approval');await screen.findByText('Blue / Medium');
 expect((screen.getByText('supervision.approvePurchase') as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText('supervision.merchantUnavailable (seller-a)')).toBeTruthy();expect(screen.getByText('supervision.merchantUnavailable (seller-b)')).toBeTruthy();
});
it('drops old state when the same account enters a different session',async()=>{
 const {rerender,tree}=mount();await screen.findByText('supervision.children');
 session='session-b';safety.supervisionState.mockImplementation(()=>new Promise(()=>{}));rerender(tree());
 expect(screen.queryByText('supervision.children')).toBeNull();
});
it('formats safe-integer authorization money without floating-point rounding',()=>{
 expect(formatApprovalAmount(Number.MAX_SAFE_INTEGER,'USD','en-US')).toBe('90,071,992,547,409.91 USD');
 expect(formatApprovalAmount(-1,'EUR','es-ES')).toBe('-0,01 EUR');
 expect(formatApprovalAmount(123,'JPY','en-US')).toBe('123 JPY');
 expect(formatApprovalAmount(123,'KWD','en-US')).toBe('0.123 KWD');
});
