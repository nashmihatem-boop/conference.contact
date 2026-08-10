import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const plan = await prisma.plan.create({
    data: {
      name: "Full Access",
      slug: "full-access",
      stripePriceId: "price_test_123",
      interval: "MONTH",
      amountCents: 20000,
      features: { unlimitedSearch: true, csvExport: true },
    },
  });
  console.log("Created plan:", plan.slug);

  const user = await prisma.user.create({
    data: {
      email: "smoke-test@example.com",
      fullName: "Smoke Test",
      passwordHash: "not-a-real-hash",
    },
  });
  console.log("Created user:", user.email);

  const subscription = await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_test_123",
      status: "ACTIVE",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  console.log("Created subscription:", subscription.status);

  // Verify the userId+status composite index path actually returns the row
  const active = await prisma.subscription.findFirst({
    where: { userId: user.id, status: "ACTIVE" },
    include: { plan: true, user: true },
  });
  console.log("Active subscription lookup found:", active?.plan.name, "for", active?.user.email);

  // Verify RESTRICT actually blocks deleting a user with billing history
  try {
    await prisma.user.delete({ where: { id: user.id } });
    console.error("FAIL: user delete should have been restricted by billing history");
    process.exitCode = 1;
  } catch {
    console.log("Confirmed: cannot hard-delete a user with subscription history (RESTRICT working)");
  }

  // Cleanup in FK-safe order
  await prisma.subscription.delete({ where: { id: subscription.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.plan.delete({ where: { id: plan.id } });
  console.log("Cleanup complete — smoke test passed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
