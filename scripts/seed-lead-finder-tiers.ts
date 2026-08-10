import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TIERS = [
  {
    name: "Free",
    slug: "free",
    credits: 100,
    stripePriceId: null,
    amountCents: 0,
    recurring: false,
  },
  {
    name: "Starter",
    slug: "starter",
    credits: 100,
    stripePriceId: "price_1U2X2yCdtcz0ii9wDEAn5yfZ",
    amountCents: 2000,
    recurring: true,
  },
  {
    name: "Growth",
    slug: "growth",
    credits: 500,
    stripePriceId: "price_1U2X2zCdtcz0ii9wtOtsHlpH",
    amountCents: 5000,
    recurring: true,
  },
  {
    name: "Scale",
    slug: "scale",
    credits: 1000,
    stripePriceId: "price_1U2X30Cdtcz0ii9wMo90J1eu",
    amountCents: 9000,
    recurring: true,
  },
] as const;

async function main() {
  for (const tier of TIERS) {
    const row = await prisma.leadFinderTier.upsert({
      where: { slug: tier.slug },
      create: { ...tier, currency: "usd", isActive: true },
      update: {
        credits: tier.credits,
        stripePriceId: tier.stripePriceId,
        amountCents: tier.amountCents,
        recurring: tier.recurring,
      },
    });
    console.log("Seeded tier:", row.slug, row.id);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
