import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabaseServer";

export async function POST(request: NextRequest) {
  try {
    // 1. Initialize Supabase Server Client
    const supabase = await createClient();
    
    // --- UPDATED AUTH GUARD: CHECK FOR BEARER TOKEN ---
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.split(' ')[1];

    let user;
    if (token) {
      // Verify user using the token passed from frontend
      const { data: { user: foundUser }, error: tokenError } = await supabase.auth.getUser(token);
      user = foundUser;
    } else {
      // Fallback to cookie-based auth
      const { data: { user: foundUser } } = await supabase.auth.getUser();
      user = foundUser;
    }

    if (!user) {
      return NextResponse.json(
        { error: "Session expired or unauthorized. Please sign in again." },
        { status: 401 }
      );
    }

    // 3. Check for the Secret Key
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error("STRIPE_SECRET_KEY is missing from .env");
      return NextResponse.json(
        { error: "Payment gateway not configured" },
        { status: 500 }
      );
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16" as any,
    });

    // 4. Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: "price_1SsuTNRSNPEfkNwT7bYNb8jk", // Your $9 Price ID
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        supabase_user_id: user.id, 
      },
      // We hardcode the production URL here to be 100% sure, 
      // or you can set NEXT_PUBLIC_SITE_URL in your Vercel/Hosting provider settings.
      success_url: `https://theplasticfork.com/?payment_success=true`,
      cancel_url: `https://theplasticfork.com/`,
    });

    return NextResponse.json({ url: session.url });

  } catch (error: any) {
    console.error("Stripe Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 }
    );
  }
}