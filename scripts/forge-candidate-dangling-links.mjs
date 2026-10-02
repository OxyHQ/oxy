/** Read-only candidate diagnostic. Reports broken links; grants no inventory exemption. */
import { readdirSync, realpathSync, readlinkSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
export function collectDanglingLinks(root) {
  root=realpathSync(resolve(root));
  const seen=new Set(), links=[];
  function visit(path) {
    const physical=realpathSync(path);
    if(seen.has(physical)) return;
    seen.add(physical);
    for(const entry of readdirSync(physical,{withFileTypes:true})) {
      if(entry.name==='.git') continue;
      const child=resolve(physical,entry.name);
      if(entry.isSymbolicLink()) {
        const target=readlinkSync(child);
        let destination;
        try { destination=realpathSync(child); }
        catch(error) {
          if(error.code!=='ENOENT') throw error;
          links.push({path:relative(root,child),target,absoluteResolution:resolve(physical,target),errorCode:error.code});
          continue;
        }
        try { readdirSync(destination); }
        catch(error) { if(error.code==='ENOTDIR') continue; throw error; }
        visit(destination);
      } else if(entry.isDirectory()) visit(child);
    }
  }
  visit(root);
  return {diagnosticOnly:true,approval:false,root,danglingLinks:links.sort((a,b)=>a.path.localeCompare(b.path))};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { if(process.argv.length!==3) throw new Error('Usage: node diagnostic ROOT'); console.log(JSON.stringify(collectDanglingLinks(process.argv[2]),null,2)); }
  catch(error) { console.error(error.message);process.exitCode=1; }
}
