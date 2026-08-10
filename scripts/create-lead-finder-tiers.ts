import "dotenv/config";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const TIERS = [
  { name: "Starter", credits: 100, unitAmount: 2000 },
  { name: "Growth", credits: 500, unitAmount: 5000 },
  { name: "Scale", credits: 1000, unitAmount: 9000 },
] as const;

async function main() {
  for (const tier of TIERS) {
    const product = await stripe.products.create({
      name: `Lead Finder — ${tier.name}`,
      description: `${tier.credits} Lead Finder leads per month.`,
      tax_code: "txcd_10103001", // Software as a service (SaaS) - business use
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: tier.unitAmount,
      currency: "usd",
      recurring: { interval: "month" },
    });

    console.log(
      `${tier.name}: product=${product.id} price=${price.id} ($${(tier.unitAmount / 100).toFixed(2)}/mo, ${tier.credits} credits)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
