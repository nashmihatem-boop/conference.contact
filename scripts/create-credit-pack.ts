import "dotenv/config";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

async function main() {
  const product = await stripe.products.create({
    name: "Lead Finder credit pack",
    description:
      "500 additional Lead Finder credits — never expire, used after your free balance runs out.",
    // Same tax code as the Full Access plan — required for Managed Payments
    // to calculate tax correctly. Business use, not consumer.
    tax_code: "txcd_10103001", // Software as a service (SaaS) - business use
  });
  console.log("Created product:", product.id);

  // No `recurring` — this is a one-time price, checked out with
  // mode: 'payment' rather than mode: 'subscription'.
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 3900, // $39.00
    currency: "usd",
  });
  console.log("Created price:", price.id);
  console.log("\nSTRIPE_CREDIT_PACK_PRICE_ID=" + price.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
