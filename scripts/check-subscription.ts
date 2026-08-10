/**
 * Usage: npx tsx -r dotenv/config scripts/check-subscription.ts user@example.com
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: check-subscription.ts <email>");
    process.exit(1);
  }

  const subscriptions = await prisma.subscription.findMany({
    where: { user: { email } },
    include: { plan: true, invoices: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(JSON.stringify(subscriptions, null, 2));
}
main().finally(() => prisma.$disconnect());
