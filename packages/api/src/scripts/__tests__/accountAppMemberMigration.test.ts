import fs from 'node:fs';
import path from 'node:path';

describe('legacy application-member migration authorization boundary', () => {
  test('never converts an application-scoped grant into an account-wide membership', () => {
    const migrationSource = fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/migrate-accounts-40-app-members.ts'),
      'utf8'
    );

    expect(migrationSource).not.toMatch(/\bensureMember\s*\(/);
    expect(migrationSource).not.toMatch(/AccountMember\.(?:create|updateOne|findOneAndUpdate)\s*\(/);
    expect(migrationSource).toContain('OXY_ACCOUNTS_UNSCOPED_APP_MEMBERS=');
  });
});
