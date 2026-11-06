import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { users } from './users';

/** Private delivery destinations. Profile places remain public and separate. */
export const postalAddresses = pgTable(
  'postal_addresses',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientName: text().notNull(),
    line1: text().notNull(),
    line2: text(),
    city: text().notNull(),
    region: text(),
    postalCode: text().notNull(),
    country: text().notNull(),
    phone: text(),
    label: text(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('postal_addresses_user_id_idx').on(t.userId),
    uniqueIndex('postal_addresses_user_default_key').on(t.userId).where(sql`${t.isDefault}`),
    check('postal_addresses_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
  ],
);
