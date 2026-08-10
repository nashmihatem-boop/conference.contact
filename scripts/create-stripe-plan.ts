import "dotenv/config";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

async function main() {
  const product = await stripe.products.create({
    name: "Full Access",
    description:
      "Unlimited directory searches, full verified contact records, unlimited CSV export.",
    // Required for Managed Payments to calculate tax correctly. business use,
    // since this is a B2B tool for sales/marketing teams, not consumers.
    tax_code: "txcd_10103001", // Software as a service (SaaS) - business use
  });
  console.log("Created product:", product.id);

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 20000, // $200.00
    currency: "usd",
    recurring: { interval: "month" },
  });
  console.log("Created price:", price.id);
  console.log("\nSTRIPE_PRICE_ID=" + price.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
