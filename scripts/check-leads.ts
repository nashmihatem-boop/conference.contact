/**
 * Usage: npx tsx -r dotenv/config scripts/check-leads.ts [search]
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const search = process.argv[2];

  if (search) {
    const lead = await prisma.lead.findFirst({
      where: { name: { contains: search, mode: 'insensitive' } },
    });
    console.log(JSON.stringify(lead, null, 2));
  }

  const counts = await prisma.lead.groupBy({ by: ['companyType'], _count: true });
  console.log(counts);
  const emptyCompany = await prisma.lead.count({ where: { company: null } });
  console.log('rows with null company:', emptyCompany);
  const total = await prisma.lead.count();
  console.log('total leads:', total);
}
main().finally(() => prisma.$disconnect());
