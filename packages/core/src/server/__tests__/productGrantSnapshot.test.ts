import {OxyServer} from '../OxyServer';
import {subjectProductAccessQuerySchema} from '@oxy.so/contracts';
it('forwards each user session independently, without cache or shared-token mutation',async()=>{
 const server=new OxyServer({baseURL:'https://synthetic.invalid'});
 const a=subjectProductAccessQuerySchema.parse({schemaVersion:1,subjectAccountId:'synthetic-a',productId:'synthetic-product'});
 const b={...a,subjectAccountId:subjectProductAccessQuerySchema.parse({...a,subjectAccountId:'synthetic-b'}).subjectAccountId};
 const request=jest.spyOn(server as unknown as {request:jest.Mock},'request').mockImplementation(async(_method,url)=>({schemaVersion:1,grants:[],access:{
  schemaVersion:1,subjectAccountId:String(url).includes('synthetic-b')?'synthetic-b':'synthetic-a',productId:'synthetic-product',
  evaluatedAt:new Date().toISOString(),capabilities:[],quotas:[],conflicts:[]}}));
 const set=jest.spyOn(server.http,'setTokens');
 await Promise.all([server.productGrantSnapshotForUser(a,'session-a'),server.productGrantSnapshotForUser(b,'session-b')]);
 expect(request.mock.calls[0][3]).toEqual({cache:false,retry:false,headers:{Authorization:'Bearer session-a'}});
 expect(request.mock.calls[1][3]).toEqual({cache:false,retry:false,headers:{Authorization:'Bearer session-b'}});
 expect(set).not.toHaveBeenCalled();
 await expect(server.productGrantSnapshotForUser(a,'')).rejects.toThrow('session');
 request.mockResolvedValue({schemaVersion:1,grants:[],access:{...a,subjectAccountId:'synthetic-b',evaluatedAt:new Date().toISOString(),capabilities:[],quotas:[],conflicts:[]}});
 await expect(server.productGrantSnapshotForUser(a,'session-a')).rejects.toThrow('attribution');
});
it('uses the service lane without impersonation and rejects a mismatched response',async()=>{
 const server=new OxyServer({baseURL:'https://synthetic.invalid'});
 const query=subjectProductAccessQuerySchema.parse({schemaVersion:1,subjectAccountId:'synthetic-a',productId:'synthetic-product'});
 const service=jest.spyOn(server,'serviceRequest').mockResolvedValue({schemaVersion:1,grants:[],access:{...query,
  evaluatedAt:new Date().toISOString(),capabilities:[],quotas:[],conflicts:[]}});
 await server.productGrantSnapshotForService(query);
 expect(service).toHaveBeenCalledWith('GET','/v1/products/synthetic-product/access/synthetic-a/service-grants',undefined,{cache:false,retry:false});
 service.mockResolvedValue({schemaVersion:1,grants:[],access:{...query,subjectAccountId:'synthetic-b',
  evaluatedAt:new Date().toISOString(),capabilities:[],quotas:[],conflicts:[]}});
 await expect(server.productGrantSnapshotForService(query)).rejects.toThrow('attribution');
});
