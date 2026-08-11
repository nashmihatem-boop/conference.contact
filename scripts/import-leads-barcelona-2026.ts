/**
 * Appends the Affiliate Takeover Barcelona 2026 attendee list
 * (data/leads/Affiliate Takeover Barcelona 2026.csv) to the leads table.
 *
 * Unlike import-leads.ts, this does NOT truncate — it only adds rows for
 * this one event, on top of whatever's already in the table. Guarded
 * against accidental double-runs: refuses to import if rows for this
 * event already exist.
 *
 * The source file has a different column layout than the original six
 * (no "App Link" column, "Full name"/"Type" instead of "Name"/"Type of
 * Company", lowercase "company"/"website"), and ~38% of rows have no
 * "Type" value at all — those import with companyType: null ("real
 * person, uncategorized") rather than being dropped or guessed at.
 *
 * Usage: npx tsx -r dotenv/config scripts/import-leads-barcelona-2026.ts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaPg } from '@prisma/adapter-pg';
import { CompanyType, PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const EVENT_NAME = 'Affiliate Takeover Barcelona 2026';
const FILE_PATH = join(
  __dirname,
  '../data/leads/Affiliate Takeover Barcelona 2026.csv',
);
const BATCH_SIZE = 1000;

// Source values are lowercase and already match the six real categories —
// same enum, same six labels confirmed against the original 21,744-row
// import, just cased differently here.
const TYPE_MAP: Record<string, CompanyType> = {
  advertiser: 'ADVERTISER',
  'ad network': 'AD_NETWORK',
  affiliate: 'AFFILIATE',
  'affiliate network': 'AFFILIATE_NETWORK',
  agency: 'AGENCY',
  'solution provider': 'SOLUTION_PROVIDER',
};

interface CsvRow {
  'Full name': string;
  'Likely to Attend': string;
  company: string;
  website: string;
  Title: string;
  LinkedIn: string;
  Email: string;
  Phone: string;
  Type: string;
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

  // The source file uses cp1252; Node has no built-in cp1252 decoder, but
  // it's identical to latin1 outside the rare 0x80-0x9F range (smart
  // quotes, em-dashes) — good enough for name/company/title fields.
  const raw = readFileSync(FILE_PATH, 'latin1');
  const rows: CsvRow[] = parse(raw, { columns: true, skip_empty_lines: true });

  let skippedStrayHeader = 0;
  let unclassified = 0;
  const records = rows
    .filter((row) => {
      // One row mid-file is a literal duplicate of the header, not a
      // real person — drop it rather than importing "name" as a name.
      if (row['Full name'].trim().toLowerCase() === 'name') {
        skippedStrayHeader++;
        return false;
      }
      return true;
    })
    .map((row) => {
      const typeRaw = row.Type.trim().toLowerCase();
      const companyType = typeRaw ? (TYPE_MAP[typeRaw] ?? null) : null;
      if (!companyType) unclassified++;
      if (typeRaw && !TYPE_MAP[typeRaw]) {
        console.warn(`Unrecognized Type "${row.Type}" for "${row['Full name']}" — importing as unclassified.`);
      }

      return {
        name: row['Full name'].trim(),
        title: orNull(row.Title),
        company: orNull(row.company),
        website: orNull(row.website),
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
  console.log(`Skipped ${skippedStrayHeader} stray header row(s).`);
  console.log(`${unclassified} row(s) imported with no company type (companyType: null).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
