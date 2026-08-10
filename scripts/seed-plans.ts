import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const plan = await prisma.plan.upsert({
    where: { slug: "full-access" },
    create: {
      name: "Full Access",
      slug: "full-access",
      stripePriceId: "price_1U2UpICdtcz0ii9wLh7NVEiP",
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
      stripePriceId: "price_1U2UpICdtcz0ii9wLh7NVEiP",
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
