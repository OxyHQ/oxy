import {AssetsApi} from '../assets';
import type {OxyContext} from '../../client/context';
describe('presigned upload header propagation',()=>{
 const original=global.fetch;afterEach(()=>{global.fetch=original});
 const api=new AssetsApi({} as OxyContext);
 it('sends conditional header and exact Blob, with no bearer or cookies',async()=>{
  const fetcher=jest.fn().mockResolvedValue({ok:true});global.fetch=fetcher;
  const body=new Blob(['synthetic'],{type:'text/plain'});
  await api.putPresignedUpload({uploadUrl:'https://synthetic.s3.amazonaws.com/object',fileId:'synthetic',sha256:'synthetic',requiredHeaders:{'If-None-Match':'*'}},body);
  const request=fetcher.mock.calls[0][1];expect(request.body).toBe(body);expect(request.headers.get('If-None-Match')).toBe('*');
  expect(request.headers.has('Authorization')).toBe(false);expect(request.credentials).toBe('omit');expect(request.redirect).toBe('error');
 });
 it('rejects an overwrite/race response instead of completing it',async()=>{
  global.fetch=jest.fn().mockResolvedValue({ok:false,status:412});
  await expect(api.putPresignedUpload({uploadUrl:'https://synthetic.s3.amazonaws.com/object',fileId:'synthetic',sha256:'synthetic',requiredHeaders:{'If-None-Match':'*'}},new Blob(['x']))).rejects.toThrow('412');
 });
 it('never forwards authentication headers or insecure upload URLs',async()=>{
  global.fetch=jest.fn();
  await expect(api.putPresignedUpload({uploadUrl:'https://synthetic.example/object',fileId:'synthetic',sha256:'synthetic',requiredHeaders:{Authorization:'synthetic'}},new Blob(['x']))).rejects.toThrow('Unsupported');
  await expect(api.putPresignedUpload({uploadUrl:'http://synthetic.example/object',fileId:'synthetic',sha256:'synthetic'},new Blob(['x']))).rejects.toThrow('HTTPS');
  expect(global.fetch).not.toHaveBeenCalled();
 });
});
