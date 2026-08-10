/**
 * Imports the real lead dataset (data/leads/*.csv) into the leads table.
 * Truncate-and-reload — this is a straightforward CSV -> table sync, not
 * a system with live edits to preserve yet.
 *
 * Usage: npx tsx -r dotenv/config scripts/import-leads.ts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaPg } from '@prisma/adapter-pg';
import { CompanyType, PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Filename -> CompanyType is a direct mapping, not inferred from the row
// data — the six source files are already split by category, and every
// row's own "Type of Company" column was confirmed to match its filename
// (0 mismatches out of 21,744 rows) before this script was written.
const FILES: Record<string, CompanyType> = {
  'Advertiser.csv': 'ADVERTISER',
  'Ad Network.csv': 'AD_NETWORK',
  'Affiliate.csv': 'AFFILIATE',
  'Affiliate Network.csv': 'AFFILIATE_NETWORK',
  'Agency.csv': 'AGENCY',
  'Solution Provider.csv': 'SOLUTION_PROVIDER',
};

const DATA_DIR = join(__dirname, '../data/leads');
const BATCH_SIZE = 1000;

interface CsvRow {
  Name: string;
  'Likely to Attend': string;
  Company: string;
  Website: string;
  Title: string;
  LinkedIn: string;
  'App Link': string;
  Email: string;
  Phone: string;
  'Type of Company': string;
}

function orNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

async function main() {
  let totalImported = 0;

  await prisma.lead.deleteMany();

  for (const [filename, companyType] of Object.entries(FILES)) {
    const raw = readFileSync(join(DATA_DIR, filename), 'utf-8');
    const rows: CsvRow[] = parse(raw, {
      columns: true,
      skip_empty_lines: true,
    });

    const records = rows.map((row) => ({
      name: row.Name.trim(),
      title: orNull(row.Title),
      company: orNull(row.Company),
      website: orNull(row.Website),
      linkedin: orNull(row.LinkedIn),
      appLink: orNull(row['App Link']),
      email: orNull(row.Email)?.toLowerCase() ?? null,
      phone: orNull(row.Phone),
      companyType,
      likelyToAttend: row['Likely to Attend'].trim(),
    }));

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      await prisma.lead.createMany({ data: records.slice(i, i + BATCH_SIZE) });
    }

    console.log(`${filename}: imported ${records.length} rows as ${companyType}`);
    totalImported += records.length;
  }

  console.log(`Total imported: ${totalImported}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
