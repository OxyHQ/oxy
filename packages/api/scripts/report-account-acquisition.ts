import { closePostgres, connectPostgres } from '../src/config/postgres';
import {
  reportAccountAcquisition,
  validateAcquisitionReportRange,
} from '../src/services/accountAcquisitionReport.service';

async function main() {
  const [from, to, ...extra] = process.argv.slice(2);
  if (!from || !to || extra.length)
    throw new Error('Usage: report-account-acquisition.ts YYYY-MM-DD YYYY-MM-DD (exclusive end)');
  validateAcquisitionReportRange(from, to);
  await connectPostgres();
  try {
    console.log(JSON.stringify(await reportAccountAcquisition(from, to)));
  } finally {
    await closePostgres();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Acquisition report failed');
  process.exitCode = 1;
});
