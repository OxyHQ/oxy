import { getTableColumns,type GetColumnData } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '../../config/postgres';
import { users } from '../schema/users';
import { organizationProfiles } from '../schema/organizationProfiles';

type AccountInput=typeof users.$inferInsert;
type AccountRow=typeof users.$inferSelect;
type Selection=Record<string,AnyPgColumn>;
/** Explicitly seed already-managed identities for unrelated tests. Directory authorization tests use real create/claim services. */
export function insertAccountFixtures(input:AccountInput|AccountInput[]):Promise<AccountRow[]>;
export function insertAccountFixtures<T extends Selection>(input:AccountInput|AccountInput[],fields:T):Promise<{[K in keyof T]:GetColumnData<T[K]>}[]>;
export async function insertAccountFixtures(input:AccountInput|AccountInput[],fields?:Selection):Promise<Record<string,unknown>[]> {
  return getDb().transaction(async tx=>{
    const rows=await tx.insert(users).values(Array.isArray(input)?input:[input]).returning();
    const profiles=rows.filter(row=>row.kind==='organization').map(row=>({accountId:row.id,claimStatus:'claimed' as const}));
    if(profiles.length) await tx.insert(organizationProfiles).values(profiles);
    if(!fields) return rows;
    const columns=Object.entries(getTableColumns(users));
    return rows.map(row=>Object.fromEntries(Object.entries(fields).map(([key,column])=>{
      const entry=columns.find(([,value])=>value===column);
      if(!entry) throw new Error('Account fixture selection must use users columns');
      return [key,row[entry[0] as keyof AccountRow]];
    })));
  });
}
export async function insertAccountFixture(input:AccountInput):Promise<AccountRow> {
  const [account]=await insertAccountFixtures(input);
  if(!account) throw new Error('Account fixture was not inserted');
  return account;
}
