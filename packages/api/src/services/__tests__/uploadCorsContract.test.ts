import fs from 'node:fs';
import path from 'node:path';
describe('review-only presigned upload CORS contract',()=>{
 it('allows every SDK required upload header without a wildcard origin or credentials header',()=>{
  const template=JSON.parse(fs.readFileSync(path.join(__dirname,'../../../config/drafts/oxy-one-upload-cors.template.json'),'utf8'));
  const rule=template.CORSRules[0];expect(rule.AllowedMethods).toEqual(['PUT']);
  expect(rule.AllowedHeaders).toEqual(expect.arrayContaining(['content-type','if-none-match','x-amz-checksum-sha256','cache-control']));
  expect(rule.AllowedHeaders).not.toContain('authorization');expect(rule.AllowedOrigins).not.toContain('*');
  expect(rule.AllowedOrigins[0]).toContain('REPLACE_APPROVED');
 });
});
