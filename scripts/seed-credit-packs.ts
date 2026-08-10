import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const pack = await prisma.creditPack.upsert({
    where: { slug: "credits-500" },
    create: {
      name: "500 Lead Finder credits",
      slug: "credits-500",
      credits: 500,
      // $50 per 500 credits — deliberately the same per-credit rate as the
      // Growth tier ($50/mo for 500), so buying a one-time top-up never
      // costs more or less per credit than subscribing.
      stripePriceId: "price_1U2aO4Cdtcz0ii9wNjuCngVN",
      amountCents: 5000,
      currency: "usd",
      isActive: true,
    },
    update: {
      stripePriceId: "price_1U2aO4Cdtcz0ii9wNjuCngVN",
      amountCents: 5000,
      credits: 500,
    },
  });
  console.log("Seeded credit pack:", pack);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
