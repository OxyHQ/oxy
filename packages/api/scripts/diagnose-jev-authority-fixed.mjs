// Fixed operator diagnostic. No arguments, HTTP, credentials, financial writes or token mint.
const OWNER = "01a0369b-1222-712f-8df6-f8ffeb78ccc2";
export function classifyFixedTree(chain, closure) {
  const canonicalAncestors = chain.filter(row => row.distance > 0 && !row.cycle);
  const bounded = chain.some(row => row.cycle || row.parent_missing || (row.distance===15 && row.parent_account_id!==null));
  const expected = canonicalAncestors.slice().reverse().map(row => row.account_id);
  const observed = closure.map(row => row.ancestor_id);
  const closureMatches = !bounded && JSON.stringify(expected)===JSON.stringify(observed) && closure.every((row,index)=>row.depth===index);
  const classification = chain.length===0 ? "owner_missing" : bounded ? "parent_chain_invalid_or_over_limit" :
    !closureMatches ? "materialized_ancestor_path_mismatch" :
    chain.some(row=>row.profile_status==="active") ? "active_profile_present" :
    chain.some(row=>row.profile_status!==null) ? "profiles_present_but_none_active" : "no_profile_on_owner_or_ancestors";
  return {classification, closureMatches};
}

async function run() {
  const { connectPostgres, getDb, closePostgres } = await import("/app/packages/api/src/config/postgres.ts");
  const { sql } = await import("/app/packages/api/node_modules/drizzle-orm/index.js");
  await connectPostgres();
  try {
    const proof = await getDb().transaction(async tx => {
      await tx.execute(sql.raw("set transaction isolation level repeatable read, read only"));
      const ro = await tx.execute(sql.raw("show transaction_read_only"));
      const iso = await tx.execute(sql.raw("show transaction_isolation"));
      if (ro[0]?.transaction_read_only !== "on" || iso[0]?.transaction_isolation !== "repeatable read") throw Error("snapshot_refused");
      const chain = await tx.execute(sql.raw(`
        with recursive chain as (
          select id, parent_account_id, account_status, 0 as distance, array[id]::text[] as path, false as cycle
          from users where id = '${OWNER}'
          union all
          select p.id, p.parent_account_id, p.account_status, c.distance + 1,
                 c.path || p.id, p.id = any(c.path)
          from chain c join users p on p.id = c.parent_account_id
          where c.distance < 15 and not c.cycle
        )
        select c.id as account_id, c.parent_account_id, c.account_status, c.distance, c.cycle,
               (c.parent_account_id is not null and not exists(select 1 from users p where p.id=c.parent_account_id)) as parent_missing,
               bp.status as profile_status, bp.currency, bp.billing_mode,
               (select count(*)::int from account_balances b where b.account_id=c.id) as balance_rows
        from chain c left join billing_profiles bp on bp.account_id=c.id order by c.distance
      `));
      const closure = await tx.execute(sql.raw(`
        select ancestor_id, depth from user_ancestors where user_id='${OWNER}' order by depth
      `));
      const authority = await tx.execute(sql.raw(`
        select t.app_id as application_id, a.status as application_status,
               ('inference:invoke'=any(a.scopes)) as app_invoke,
               w.id as binding_id, w.application_id=a.id as binding_app_matches,
               w.expires_at is null or w.expires_at>now() as binding_unexpired,
               case when cardinality(w.scopes)=0 then 'inference:invoke'=any(a.scopes)
                    else 'inference:invoke'=any(w.scopes) and 'inference:invoke'=any(a.scopes) end as scope_intersection_invoke
        from (values
          ('6a2f851751b784a86fd0e934','arn:aws:iam::237343248947:role/oxy-alia-task'),
          ('6a2f851751b784a86fd0e916','arn:aws:iam::237343248947:role/oxy-mention-task')
        ) t(app_id,subject)
        left join applications a on a.id=t.app_id
        left join application_workload_identities w on w.provider='aws-iam' and w.subject=t.subject
        order by t.app_id
      `));
      const {classification, closureMatches} = classifyFixedTree(chain,closure);
      const own = chain.find(row => row.distance===0);
      return {schemaVersion:1, observedAt:new Date().toISOString(), database:{transactionReadOnly:true,transactionIsolation:"repeatable read",writes:0},
        ownerAccountId:OWNER, ownerPresent:Boolean(own), classification, closureMatches, chain, closure, authority,
        note:"Metadata only. No authorization, profile provisioning, credit issuance, scope change or inference."};
    });
    console.log("JEV_AUTHORITY_DIAGNOSTIC_RESULT="+JSON.stringify(proof));
  } finally { await closePostgres(); }
}
if (process.argv.includes("--fixed-self-test")) {
  const assert = (actual, expected) => { if(actual!==expected) throw Error("fixture_failed"); };
  const own={account_id:OWNER,parent_account_id:null,distance:0,cycle:false,parent_missing:false,profile_status:null};
  assert(classifyFixedTree([],[]).classification,"owner_missing");
  assert(classifyFixedTree([own],[]).classification,"no_profile_on_owner_or_ancestors");
  assert(classifyFixedTree([{...own,profile_status:"suspended"}],[]).classification,"profiles_present_but_none_active");
  assert(classifyFixedTree([{...own,profile_status:"active"}],[]).classification,"active_profile_present");
  const child={...own,parent_account_id:"parent"}; const parent={...own,account_id:"parent",distance:1};
  assert(classifyFixedTree([child,parent],[]).classification,"materialized_ancestor_path_mismatch");
  assert(classifyFixedTree([child,parent],[{ancestor_id:"parent",depth:0}]).classification,"no_profile_on_owner_or_ancestors");
  assert(classifyFixedTree([{...own,cycle:true}],[]).classification,"parent_chain_invalid_or_over_limit");
  assert(classifyFixedTree([{...own,parent_missing:true}],[]).classification,"parent_chain_invalid_or_over_limit");
  assert(classifyFixedTree([{...own,distance:15,parent_account_id:"next"}],[]).classification,"parent_chain_invalid_or_over_limit");
  console.log("FIXED_DIAGNOSTIC_FIXTURES_PASS=9");
} else {
  run().catch(()=>{console.error("Jev fixed diagnostic failed");process.exitCode=1;});
}
