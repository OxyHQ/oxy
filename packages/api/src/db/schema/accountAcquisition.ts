import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from '@oxy.so/db';
import { users } from './users';

/** Private signup metadata: one insert per account, erased with that account. */
export const accountAcquisition = pgTable(
  'account_acquisition',
  {
    userId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    utmSource: text(),
    utmMedium: text(),
    utmCampaign: text(),
    utmContent: text(),
    utmTerm: text(),
    fbclid: text(),
    createdAt: createdAt(),
  },
  (table) => [
    index('account_acquisition_campaign_idx').on(
      table.createdAt,
      table.utmSource,
      table.utmCampaign,
    ),
    check(
      'account_acquisition_labels_bounded',
      sql`
      char_length(${table.utmSource}) <= 256 and char_length(${table.utmMedium}) <= 256
      and char_length(${table.utmCampaign}) <= 256 and char_length(${table.utmContent}) <= 256
      and char_length(${table.utmTerm}) <= 256 and char_length(${table.fbclid}) <= 1024
    `,
    ),
  ],
);
