import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADVISORY, FILES, SUITES, ARM_PRUNED_LINKS, ARM_PRUNING_RECEIPT, sha256, canonicalAudit, inventory, inventoryHash, evaluate } from './forge-remediation-proof-proposal.mjs';
let checks = 0;
function fixture() {
  const patchBytes = Buffer.from('synthetic patch');
  const files = Object.fromEntries(FILES.map(name => [name, sha256(name)]));
  const copies = [{ realpath: '/synthetic/node_modules/node-forge', version: '1.4.0', files }];
  const patchSha256 = sha256(patchBytes);
  const audit = { 'node-forge': [{ url: `https://github.com/advisories/${ADVISORY}`, severity: 'high' }] };
  const rawAuditSha256 = sha256(canonicalAudit(audit));
  const evidenceBytes = JSON.stringify({ rawAuditSha256, patchSha256, inventorySha256: inventoryHash(copies), suites: Object.fromEntries(SUITES.map(name => [name,'pass'])) });
  return { audit, manifest: { advisory: ADVISORY, package: 'node-forge', version: '1.4.0', rawAuditSha256, patchSha256, files, testEvidenceSha256: sha256(evidenceBytes), independentSecurityReview: { reviewer: 'synthetic-review-only', reviewedPatchSha256: patchSha256 } }, patchBytes, copies, evidenceBytes };
}
function reject(change) { const input = fixture(); change(input); assert.equal(evaluate(input).technicalEvidenceComplete, false); checks++; }
const nominal = evaluate(fixture());
assert.equal(nominal.technicalEvidenceComplete,true);
assert.equal(nominal.approved,false);
assert.equal(nominal.proposalOnly,true); checks++;
reject(x=>x.audit['node-forge'].push({url:'https://github.com/advisories/GHSA-new',severity:'high'}));
reject(x=>x.audit['node-forge'][0].url='https://github.com/advisories/GHSA-other');
reject(x=>x.audit['node-forge'][0].severity='critical');
reject(x=>x.audit={});
reject(x=>x.audit['new-package']=[{url:'https://github.com/advisories/GHSA-new',severity:'high'}]);
reject(x=>x.audit['node-forge'][0].vulnerable_versions='<=1.4.1');
reject(x=>delete x.manifest.rawAuditSha256);
reject(x=>{const e=JSON.parse(x.evidenceBytes); e.rawAuditSha256='a'.repeat(64);x.evidenceBytes=JSON.stringify(e);x.manifest.testEvidenceSha256=sha256(x.evidenceBytes);});
assert.equal(canonicalAudit({z:1,a:{b:2,a:3}}),canonicalAudit({a:{a:3,b:2},z:1}));checks++;
reject(x=>x.manifest.version='1.4.1');
reject(x=>x.copies[0].version='1.4.1');
reject(x=>x.patchBytes=Buffer.from('changed'));
reject(x=>x.manifest.patchSha256='PLACEHOLDER');
for (const name of FILES) reject(x=>delete x.copies[0].files[name]);
reject(x=>x.copies.push({realpath:'/nested/unpatched',version:'1.4.0',files:{}}));
reject(x=>x.copies=[]);
reject(x=>x.evidenceBytes='{}');
reject(x=>delete x.manifest.independentSecurityReview);
reject(x=>x.manifest.independentSecurityReview.reviewedPatchSha256='a'.repeat(64));
for (const suite of SUITES) reject(x=> {
  const evidence=JSON.parse(x.evidenceBytes); evidence.suites[suite]='fail';
  x.evidenceBytes=JSON.stringify(evidence); x.manifest.testEvidenceSha256=sha256(x.evidenceBytes);
});
function omissionFixture() {
  const input=fixture(); Object.defineProperty(input.copies,'intentionalDanglingSharpLinks',{value:structuredClone(ARM_PRUNED_LINKS)});
  input.manifest.pruningReceipt=structuredClone(ARM_PRUNING_RECEIPT);
  const e=JSON.parse(input.evidenceBytes);e.pruningReceipt=structuredClone(ARM_PRUNING_RECEIPT);e.inventorySha256=inventoryHash(input.copies);
  input.evidenceBytes=JSON.stringify(e);input.manifest.testEvidenceSha256=sha256(input.evidenceBytes);return input;
}
assert.equal(evaluate(omissionFixture()).technicalEvidenceComplete,true);checks++;
for(const field of ['sourceSha','imageDigest','receiptSha256']) {const input=omissionFixture();input.manifest.pruningReceipt[field]='changed';assert.equal(evaluate(input).technicalEvidenceComplete,false);checks++;}
{const input=omissionFixture();const e=JSON.parse(input.evidenceBytes);delete e.pruningReceipt;input.evidenceBytes=JSON.stringify(e);input.manifest.testEvidenceSha256=sha256(input.evidenceBytes);assert.equal(evaluate(input).technicalEvidenceComplete,false);checks++;}
const root=mkdtempSync(join(tmpdir(),'forge-proof-fixture-'));
try {
  function create(relative, version='1.4.0') {
    const dir=join(root,relative); mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'package.json'),JSON.stringify({name:'node-forge',version}));
    for(const name of FILES) { mkdirSync(join(dir,name,'..'),{recursive:true}); writeFileSync(join(dir,name),name); }
    return dir;
  }
  const first=create('node_modules/.bun/node-forge@1.4.0/node_modules/node-forge');
  create('packages/app/node_modules/node-forge');
  symlinkSync(first,join(root,'node_modules/node-forge'),'dir');
  assert.equal(inventory(root).length,2); checks++;
  for (const entry of ARM_PRUNED_LINKS) { mkdirSync(join(root,entry.path,'..'),{recursive:true}); symlinkSync(entry.target,join(root,entry.path)); }
  assert.throws(()=>inventory(root),/ENOENT/);checks++;
  const option={intentionalDanglingSharpLinks:structuredClone(ARM_PRUNED_LINKS)};
  const allowed=inventory(root,option);
  assert.equal(allowed.length,2);assert.deepEqual(allowed.intentionalDanglingSharpLinks,option.intentionalDanglingSharpLinks);checks++;
  assert.notEqual(inventoryHash(allowed),inventoryHash([...allowed]));checks++;
  const changed=structuredClone(option);changed.intentionalDanglingSharpLinks[0].target='wrong';assert.throws(()=>inventory(root,changed));checks++;
  assert.throws(()=>inventory(root,{intentionalDanglingSharpLinks:option.intentionalDanglingSharpLinks.slice(1)}));checks++;
  assert.throws(()=>inventory(root,{intentionalDanglingSharpLinks:[...option.intentionalDanglingSharpLinks,option.intentionalDanglingSharpLinks[0]]}));checks++;
  const forgeLink='packages/api/node_modules/node-forge-broken';symlinkSync('/missing/node-forge',join(root,forgeLink));
  assert.throws(()=>inventory(root,option));checks++;rmSync(join(root,forgeLink));
  const victim=ARM_PRUNED_LINKS[0];rmSync(join(root,victim.path));symlinkSync('../../node-forge@1.4.0/node_modules/node-forge',join(root,victim.path));
  assert.throws(()=>inventory(root,option));checks++;rmSync(join(root,victim.path));symlinkSync(victim.target,join(root,victim.path));
  rmSync(join(root,ARM_PRUNED_LINKS[7].path));assert.throws(()=>inventory(root,option));checks++;
  for(const entry of ARM_PRUNED_LINKS.slice(0,7)) rmSync(join(root,entry.path));
  writeFileSync(join(first,'dist/forge.min.js'),'modified');
  assert.notEqual(inventory(root)[0].files['dist/forge.min.js'],sha256('dist/forge.min.js')); checks++;
} finally { rmSync(root,{recursive:true,force:true}); }
console.log(`${checks} inert proof assertions passed; candidate approval remains false.`);
