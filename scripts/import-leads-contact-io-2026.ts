/**
 * Appends the Contact.io 2026 attendee list
 * (data/leads/Contact.io 2026.csv) to the leads table.
 *
 * Unlike import-leads.ts, this does NOT truncate — it only adds rows for
 * this one event, on top of whatever's already in the table. Guarded
 * against accidental double-runs: refuses to import if rows for this
 * event already exist.
 *
 * Source columns: Name, Title, Company, Type of Company, Likely to
 * Attend, Website, LinkedIn, Email, Phone — no App Link column. "Type of
 * Company" is either "AFFILIATE" (8 rows — the admin's own team, who
 * genuinely attended this event, confirmed with the user before import)
 * or "Unclassified" (the other 3,078 — imports as companyType: null,
 * same "real person, uncategorized" handling as every prior import).
 * Data quality checked before writing this script: 0 blank names/emails/
 * companies, 0 malformed emails, 0 duplicate emails within the file.
 *
 * Usage: npx tsx -r dotenv/config scripts/import-leads-contact-io-2026.ts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaPg } from '@prisma/adapter-pg';
import { CompanyType, PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const EVENT_NAME = 'Contact.io 2026';
const FILE_PATH = join(__dirname, '../data/leads/Contact.io 2026.csv');
const BATCH_SIZE = 1000;

const TYPE_MAP: Record<string, CompanyType> = {
  advertiser: 'ADVERTISER',
  'ad network': 'AD_NETWORK',
  affiliate: 'AFFILIATE',
  'affiliate network': 'AFFILIATE_NETWORK',
  agency: 'AGENCY',
  'solution provider': 'SOLUTION_PROVIDER',
};

interface CsvRow {
  Name: string;
  Title: string;
  Company: string;
  'Type of Company': string;
  'Likely to Attend': string;
  Website: string;
  LinkedIn: string;
  Email: string;
  Phone: string;
}

function orNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

async function main() {
  const existing = await prisma.lead.count({
    where: { likelyToAttend: EVENT_NAME },
  });
  if (existing > 0) {
    console.log(
      `Already have ${existing} leads for "${EVENT_NAME}" — refusing to import again. Delete them first if you want to re-run this.`,
    );
    return;
  }

  // Source file is cp1252 (Excel export) — latin1 decodes it correctly
  // outside the rare 0x80-0x9F smart-quote/em-dash range, same approach
  // as every prior CSV import in this project.
  const raw = readFileSync(FILE_PATH, 'latin1');
  const rows: CsvRow[] = parse(raw, { columns: true, skip_empty_lines: true });

  let unclassified = 0;
  const records = rows.map((row) => {
    const typeRaw = row['Type of Company'].trim().toLowerCase();
    const companyType = typeRaw ? (TYPE_MAP[typeRaw] ?? null) : null;
    if (!companyType) unclassified++;
    if (typeRaw && typeRaw !== 'unclassified' && !TYPE_MAP[typeRaw]) {
      console.warn(
        `Unrecognized Type of Company "${row['Type of Company']}" for "${row.Name}" — importing as unclassified.`,
      );
    }

    return {
      name: row.Name.trim(),
      title: orNull(row.Title),
      company: orNull(row.Company),
      website: orNull(row.Website),
      linkedin: orNull(row.LinkedIn),
      appLink: null,
      email: orNull(row.Email)?.toLowerCase() ?? null,
      phone: orNull(row.Phone),
      companyType,
      likelyToAttend: row['Likely to Attend'].trim(),
    };
  });

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    await prisma.lead.createMany({ data: records.slice(i, i + BATCH_SIZE) });
  }

  console.log(`Imported ${records.length} leads for "${EVENT_NAME}".`);
  console.log(
    `${unclassified} row(s) imported with no company type (companyType: null).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
