/**
 * Usage: npx tsx -r dotenv/config scripts/check-audit.ts [action-prefix]
 * Examples: check-audit.ts auth.   check-audit.ts billing.   check-audit.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const prefix = process.argv[2] ?? "";
  const logs = await prisma.auditLog.findMany({
    where: { action: { contains: prefix } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { action: true, metadata: true, createdAt: true },
  });
  console.log(JSON.stringify(logs, null, 2));
}
main().finally(() => prisma.$disconnect());
