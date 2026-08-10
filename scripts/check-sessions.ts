/**
 * Usage: npx tsx -r dotenv/config scripts/check-sessions.ts user@example.com
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: check-sessions.ts <email>");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error("No user with that email");
    process.exit(1);
  }

  const sessions = await prisma.session.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  console.log(
    JSON.stringify(
      sessions.map((s) => ({
        ip: s.ipAddress,
        country: s.country,
        city: s.city,
        timezone: s.timezone,
        riskScore: s.riskScore,
        riskSignals: s.riskSignals,
        createdAt: s.createdAt,
      })),
      null,
      2,
    ),
  );
}
main().finally(() => prisma.$disconnect());
