import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Initialize the Admin client to bypass RLS for rate limiting
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const { ingredients, userWeight, activityLevel, goalWeight, bodyFat, isPro } = await request.json();

    // --- START RATE LIMITING (THE BOUNCER) ---
    // If they are Pro, we skip IP rate limiting entirely
    if (!isPro) {
      const ip = request.headers.get("x-forwarded-for") || "unknown";
      
      const { data: limitData } = await supabaseAdmin
        .from('rate_limits')
        .select('*')
        .eq('ip_address', ip)
        .single();

      if (limitData) {
        const hoursSinceLast = (Date.now() - new Date(limitData.last_request).getTime()) / 3600000;
        
        if (hoursSinceLast > 24) {
          // It's been over 24 hours, reset their counter
          await supabaseAdmin.from('rate_limits').update({ 
            request_count: 1, 
            last_request: new Date().toISOString() 
          }).eq('ip_address', ip);
        } else if (limitData.request_count >= 3) {
          // They've hit the 3-plan limit in 24 hours
          return NextResponse.json({ 
            error: "IP LIMIT REACHED. Sign in for more audits or wait 24 hours." 
          }, { status: 429 });
        } else {
          // Increment their usage
          await supabaseAdmin.from('rate_limits').update({ 
            request_count: limitData.request_count + 1 
          }).eq('ip_address', ip);
        }
      } else {
        // First time this IP has visited, create their record
        await supabaseAdmin.from('rate_limits').insert([{ 
          ip_address: ip, 
          request_count: 1 
        }]);
      }
    }
    // --- END RATE LIMITING ---

    if (!ingredients || typeof ingredients !== "string" || ingredients.trim() === "") {
      return NextResponse.json({ error: "Ingredients are required" }, { status: 400 });
    }

    const weightNum = userWeight ? parseInt(userWeight) : 180;
    const goalNum = goalWeight ? parseInt(goalWeight) : weightNum - 10;
    const fatPercent = bodyFat ? parseFloat(bodyFat) / 100 : 0.20;
    
    const leanMass = weightNum * (1 - fatPercent);
    const multiplier = parseFloat(activityLevel) || 1.55;
    const maintenance = Math.round(weightNum * (multiplier * 10)); 
    const targetCalories = maintenance - 500;

    const weightToLose = weightNum - goalNum;
    const weeksToGoal = weightToLose > 0 ? Math.ceil(weightToLose / 1) : 0;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "API key not configured" }, { status: 500 });
    }

    const prompt = `You are 'The Plastic Fork'—a blunt nutrition auditor. 

CRITICAL CONSTRAINT: 
Do NOT include any of these foods in the plan: ${ingredients}. 

AUDIT PARAMETERS:
- Stats: ${weightNum} lbs, ${bodyFat}% Body Fat.
- Target: Exactly ${targetCalories} calories and ${Math.round(leanMass)}g protein.
- Goal: Reach ${goalNum} lbs in ${weeksToGoal} weeks.

REQUIRED OUTPUT:
- 3 Bullet Points (Morning, Mid-day, Evening). Provide specific oz/gram weights.
- Section: 'PRO MACRO AUDIT'
- Section: 'BODY ARCHITECT FORECAST' (Mention the ${weeksToGoal}-week timeline).

TONE: Clinical, aggressive, no-nonsense.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || "Failed to fetch from Google AI");
    }

    const text = data.candidates[0].content.parts[0].text;
    return NextResponse.json({ plan: text });

  } catch (error: any) {
    console.error("Error generating plan:", error);
    return NextResponse.json(
      { error: "Failed to generate plan", details: error?.message || "Unknown error" },
      { status: 500 }
    );
  }
}