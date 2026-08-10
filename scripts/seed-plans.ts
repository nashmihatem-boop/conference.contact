import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Defaults to the test-mode price — set STRIPE_PRICE_FULL_ACCESS to the
// live-mode price ID (see .env.example) when seeding a production database.
const stripePriceId =
  process.env.STRIPE_PRICE_FULL_ACCESS ?? "price_1U2UpICdtcz0ii9wLh7NVEiP";

async function main() {
  const plan = await prisma.plan.upsert({
    where: { slug: "full-access" },
    create: {
      name: "Full Access",
      slug: "full-access",
      stripePriceId,
      interval: "SIX_MONTHS",
      amountCents: 5000,
      currency: "usd",
      features: {
        unlimitedSearch: true,
        fullContactRecords: true,
        csvExport: true,
        filterByCompanyType: true,
        rollingRecordUpdates: true,
        leadFinder: true,
      },
      isActive: true,
    },
    update: {
      stripePriceId,
      interval: "SIX_MONTHS",
      amountCents: 5000,
    },
  });
  console.log("Seeded plan:", plan);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
