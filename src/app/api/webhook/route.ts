import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16" as any,
});

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const payload = await req.text();
  const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      payload,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("❌ Webhook Signature Verification Failed:", err.message);
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.supabase_user_id;

    console.log("🔔 Processing Checkout for User:", userId);

    if (userId) {
      const { error } = await supabaseAdmin
        .from("profiles")
        .upsert(
          { 
            id: userId, 
            is_pro: true 
          }, 
          { onConflict: 'id' }
        );

      if (error) {
        console.error("❌ Supabase Upsert Error:", error.message);
        // Returning a 500 here tells Stripe to retry later
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      
      console.log(`Success! User ${userId} is now PRO.`);
    } else {
      console.error("⚠️ No userId found in session metadata.");
    }
  }

  return NextResponse.json({ received: true });
}