/**
 * Appends 8 more per-event attendee lists to the leads table:
 * Affiliate Summit West 2026, Affiliate takeover Miami 2026,
 * Affiliate World Bangkok 2026, Leadscon 2026, MAU Vegas 2026,
 * Mass Torts Made Perfect 2026, Medicarians 2026, Affiliate Summit East 2026.
 *
 * Same non-destructive, append-only, per-event double-run-guard pattern as
 * import-leads-barcelona-2026.ts. Unlike that file, these share the
 * original CsvRow schema (Name/Company/Website/Title/LinkedIn/App
 * Link/Email/Phone/Type of Company) — same as import-leads.ts.
 *
 * The vast majority of rows here (~98%) have no "Type of Company" value at
 * all; those import with companyType: null, same as the Barcelona list.
 *
 * The source file for Bangkok is named/labeled "2025" internally, but is
 * actually the 2026 edition — confirmed directly by the user, so the event
 * name is hardcoded per-file below rather than trusted from the CSV.
 *
 * Usage: npx tsx -r dotenv/config scripts/import-leads-2026-events.ts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaPg } from '@prisma/adapter-pg';
import { CompanyType, PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const DATA_DIR = join(__dirname, '../data/leads');
const BATCH_SIZE = 1000;

const FILES: { file: string; eventName: string }[] = [
  { file: 'Affiliate Summit West 2026.csv', eventName: 'Affiliate Summit West 2026' },
  { file: 'Affiliate takeover Miami 2026.csv', eventName: 'Affiliate takeover Miami 2026' },
  {
    file: 'Affiliate World Bangkok 2026 (source file misnamed 2025).csv',
    eventName: 'Affiliate World Bangkok 2026',
  },
  { file: 'Leadscon 2026.csv', eventName: 'Leadscon 2026' },
  { file: 'MAU Vegas 2026.csv', eventName: 'MAU Vegas 2026' },
  { file: 'Mass Torts Made Perfect 2026.csv', eventName: 'Mass Torts Made Perfect 2026' },
  { file: 'Medicarians 2026.csv', eventName: 'Medicarians 2026' },
  { file: 'Affiliate Summit East 2026.csv', eventName: 'Affiliate Summit East 2026' },
];

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

async function importFile(file: string, eventName: string): Promise<void> {
  const raw = readFileSync(join(DATA_DIR, file), 'utf-8');
  const rows: CsvRow[] = parse(raw, { columns: true, skip_empty_lines: true });

  // Some of these event names already have rows from the original
  // 21,744-row bulk import (a different, unrelated source) — that's not a
  // double-run of THIS script, so a plain "any rows exist for this event"
  // check would wrongly skip a legitimate new import. Instead, check
  // whether this file's own first real row is already present.
  const firstRow = rows.find((row) => row.Name.trim());
  if (firstRow) {
    const alreadyImported = await prisma.lead.findFirst({
      where: {
        name: firstRow.Name.trim(),
        likelyToAttend: eventName,
        email: orNull(firstRow.Email)?.toLowerCase() ?? null,
      },
      select: { id: true },
    });
    if (alreadyImported) {
      console.log(`"${eventName}": this file's first row is already present — skipping (already imported).`);
      return;
    }
  }

  let skippedBlank = 0;
  let unclassified = 0;
  const records = rows
    .filter((row) => {
      // A handful of fully-blank trailing rows in the Bangkok export —
      // no name, no data, not a real person.
      if (!row.Name.trim()) {
        skippedBlank++;
        return false;
      }
      return true;
    })
    .map((row) => {
      const typeRaw = row['Type of Company'].trim().toLowerCase();
      const companyType =
        typeRaw && typeRaw !== '--' ? (TYPE_MAP[typeRaw] ?? null) : null;
      if (!companyType) unclassified++;

      return {
        name: row.Name.trim(),
        title: orNull(row.Title),
        company: orNull(row.Company),
        website: orNull(row.Website),
        linkedin: orNull(row.LinkedIn),
        appLink: orNull(row['App Link']),
        email: orNull(row.Email)?.toLowerCase() ?? null,
        phone: orNull(row.Phone),
        companyType,
        likelyToAttend: eventName,
      };
    });

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    await prisma.lead.createMany({ data: records.slice(i, i + BATCH_SIZE) });
  }

  console.log(
    `"${eventName}": imported ${records.length} leads (skipped ${skippedBlank} blank row(s), ${unclassified} unclassified).`,
  );
}

async function main() {
  for (const { file, eventName } of FILES) {
    await importFile(file, eventName);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
