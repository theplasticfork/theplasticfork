"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient"; 

function MealGenerator() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null); 
  const [audits, setAudits] = useState<any[]>([]);
  
  const [fridgeInput, setFridgeInput] = useState("");
  const [weight, setWeight] = useState(""); 
  const [goalWeight, setGoalWeight] = useState(""); 
  const [bodyFat, setBodyFat] = useState(""); 
  const [activityLevel, setActivityLevel] = useState("1.55"); 
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [generatedPlan, setGeneratedPlan] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Mode toggle: build a meal plan, or roast what you actually ate.
  const [mode, setMode] = useState<"plan" | "roast">("plan");
  const [foodLog, setFoodLog] = useState("");

  // How many free audits a signed-in user gets before the paywall.
  const FREE_AUDIT_LIMIT = 2;

  // A signed-in, non-Pro user who has used up their free audits.
  const needsUpgrade =
    !!user && !profile?.is_pro && audits.length >= FREE_AUDIT_LIMIT;

  const fetchData = async (userId: string) => {
    const { data: auditData } = await supabase
      .from('audits')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    setAudits(auditData || []);

    const { data: profileData } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    
    setProfile(profileData);
  };

  // Helper to sync the guest plan to the database once signed in
  const syncGuestPlan = async (currentUser: any) => {
    const guestPlan = localStorage.getItem("last-guest-plan-content");
    const guestMeta = localStorage.getItem("last-guest-plan-meta");

    if (guestPlan && guestMeta) {
      const meta = JSON.parse(guestMeta);
      
      const { error } = await supabase.from('audits').insert([{
        user_id: currentUser.id, 
        user_email: currentUser.email, 
        weight: meta.weight, 
        goal_weight: meta.goalWeight,
        body_fat: meta.bodyFat, 
        activity_level: meta.activityLevel, 
        ingredients: meta.ingredients, 
        generated_plan: guestPlan
      }]);

      if (!error) {
        // Clean up so we don't sync it twice
        localStorage.removeItem("last-guest-plan-content");
        localStorage.removeItem("last-guest-plan-meta");
        fetchData(currentUser.id);
      }
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      if (currentUser) {
        fetchData(currentUser.id);
        syncGuestPlan(currentUser); // Sync guest data on initial load
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      if (currentUser) {
        fetchData(currentUser.id);
        syncGuestPlan(currentUser); // Sync guest data on auth state change
      } else {
        setAudits([]);
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setGeneratedPlan(null);
  };

  // Sends a signed-in user to Stripe for the one-time $9 lifetime unlock.
  const handleUpgrade = async () => {
    setErrorMessage(null);
    setIsUpgrading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setErrorMessage(data.error || "Payment system offline. Try again shortly.");
    } catch {
      setErrorMessage("Payment system offline. Try again shortly.");
    } finally {
      setIsUpgrading(false);
    }
  };

  const handleForkIt = async () => {
    setErrorMessage(null);

    if (!weight || !goalWeight) {
        setErrorMessage("Weight and Goal Weight are required. Don't waste my time.");
        return;
    }

    // --- LOGIC GATE 1: GUEST USER ---
    if (!user) {
      if (localStorage.getItem("plastic-fork-usage-count") === "1") {
        setErrorMessage("GUEST LIMIT REACHED. Sign in to continue your audits.");
        handleLogin();
        return;
      }
    }

    // --- LOGIC GATE 2: SIGNED IN, FREE AUDITS USED UP ($9 PAYWALL) ---
    // We don't jump straight to Stripe here. We show a clear upgrade card
    // (rendered below) that explains the offer before charging anyone.
    if (needsUpgrade) {
      return;
    }

    // --- PRO USERS: unlimited. No cap. That's what "lifetime access" means. ---

    setIsAnalyzing(true);
    try {
      const response = await fetch("/api/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          ingredients: fridgeInput || "None",
          userWeight: weight, 
          goalWeight, 
          bodyFat: bodyFat || "20", 
          activityLevel,
          isPro: !!profile?.is_pro
        }),
      });

      // Non-streaming failure (e.g. rate limit) still returns JSON
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setErrorMessage(data.error || "Generation failed. Try again.");
        return;
      }

      // Stream the plan in as it generates so text appears immediately.
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullPlan = "";

      if (reader) {
        setGeneratedPlan(""); // show the report view right away
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullPlan += decoder.decode(value, { stream: true });
          setGeneratedPlan(fullPlan);
        }
      } else {
        // Fallback if streaming isn't available
        fullPlan = await response.text();
        setGeneratedPlan(fullPlan);
      }

      if (!fullPlan.trim()) {
        setErrorMessage("Generation failed. Try again.");
        setGeneratedPlan(null);
        return;
      }
      
      if (user) {
        await supabase.from('audits').insert([{
          user_id: user.id, 
          user_email: user.email, 
          weight, 
          goal_weight: goalWeight,
          body_fat: bodyFat || "20", 
          activity_level: activityLevel, 
          ingredients: fridgeInput || "None", 
          generated_plan: fullPlan
        }]);
        fetchData(user.id); 
      } else {
        // Save guest data for later sync
        localStorage.setItem("plastic-fork-usage-count", "1");
        localStorage.setItem("last-guest-plan-content", fullPlan);
        localStorage.setItem("last-guest-plan-meta", JSON.stringify({
          weight, goalWeight, bodyFat: bodyFat || "20", activityLevel, ingredients: fridgeInput || "None"
        }));
      }
    } catch (e) {
      setErrorMessage("Generation failed. Check your connection and try again.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  // Roast My Day: audit what the user actually ate. Shares the same free/guest/
  // Pro gating as plan generation so it can't be used to bypass the paywall.
  const handleRoast = async () => {
    setErrorMessage(null);

    if (!foodLog.trim()) {
      setErrorMessage("Tell me what you ate first. Don't be shy.");
      return;
    }

    // Guest limit
    if (!user) {
      if (localStorage.getItem("plastic-fork-usage-count") === "1") {
        setErrorMessage("GUEST LIMIT REACHED. Sign in to continue.");
        handleLogin();
        return;
      }
    }

    // Signed-in free users who've used their allowance hit the paywall.
    if (needsUpgrade) {
      return;
    }

    setIsAnalyzing(true);
    try {
      const response = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foodLog, isPro: !!profile?.is_pro }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setErrorMessage(data.error || "Roast failed. Try again.");
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let full = "";

      if (reader) {
        setGeneratedPlan("");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });
          setGeneratedPlan(full);
        }
      } else {
        full = await response.text();
        setGeneratedPlan(full);
      }

      if (!full.trim()) {
        setErrorMessage("Roast failed. Try again.");
        setGeneratedPlan(null);
        return;
      }

      // Persist the roast to history (reusing the audits table).
      if (user) {
        await supabase.from("audits").insert([{
          user_id: user.id,
          user_email: user.email,
          weight: weight || "0",
          goal_weight: goalWeight || "0",
          body_fat: bodyFat || "0",
          activity_level: activityLevel,
          ingredients: `ROAST: ${foodLog.slice(0, 60)}`,
          generated_plan: full,
        }]);
        fetchData(user.id);
      } else {
        localStorage.setItem("plastic-fork-usage-count", "1");
      }
    } catch {
      setErrorMessage("Roast failed. Check your connection and try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Copy the current plan to the clipboard (stripped of markdown noise).
  const handleCopyPlan = async () => {
    if (!generatedPlan) return;
    try {
      await navigator.clipboard.writeText(cleanPlanText(generatedPlan));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErrorMessage("Couldn't copy. Try selecting the text manually.");
    }
  };

  // Download the plan as a .txt file.
  const handleDownloadPlan = () => {
    if (!generatedPlan) return;
    const blob = new Blob([cleanPlanText(generatedPlan)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `plastic-fork-audit-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Strip markdown symbols for clean plain-text copy/download.
  const cleanPlanText = (plan: string) =>
    plan
      .replace(/\*\*/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/^\s*[-*]\s+/gm, "• ")
      .replace(/^\s*\|.*\|\s*$/gm, (m) => m.replace(/\|/g, " ").trim())
      .trim();

  // Structured rendering of the AI plan. The model returns markdown-ish text;
  // we turn headers, bullets, and table rows into branded components instead
  // of dumping a raw text blob.
  const renderPlan = (plan: string) => {
    const lines = plan.split("\n").filter((l) => l.trim().length > 0);
    return (
      <div className="space-y-2">
        {lines.map((raw, i) => {
          const line = raw.trim();

          // Section headers: markdown # or **BOLD-ONLY** lines
          const isMdHeader = /^#+\s+/.test(line);
          const isBoldHeader = /^\*\*[^*]+\*\*:?\s*$/.test(line);
          if (isMdHeader || isBoldHeader) {
            const text = line.replace(/^#+\s+/, "").replace(/\*\*/g, "").replace(/:$/, "");
            return (
              <h4 key={i} className="font-display text-sm uppercase tracking-wide text-fork-green pt-4 first:pt-0">
                {text}
              </h4>
            );
          }

          // Table rows (markdown pipes) -> mono line, skip separator rows
          if (line.startsWith("|")) {
            if (/^\|[\s:|-]+\|?$/.test(line)) return null; // separator row
            const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
            return (
              <p key={i} className="font-mono-data text-xs text-chalk flex flex-wrap gap-x-3 border-b border-carbon-line/50 py-1">
                {cells.map((c, ci) => (
                  <span key={ci} className={ci === 0 ? "text-steel min-w-[70px]" : ""}>{stripInline(c)}</span>
                ))}
              </p>
            );
          }

          // Bullet points
          if (/^[-*]\s+/.test(line)) {
            return (
              <p key={i} className="text-sm text-chalk leading-relaxed flex gap-2">
                <span className="text-fork-green" aria-hidden="true">•</span>
                <span>{stripInline(line.replace(/^[-*]\s+/, ""))}</span>
              </p>
            );
          }

          // Horizontal rule
          if (/^---+$/.test(line)) {
            return <hr key={i} className="border-carbon-line" />;
          }

          // Plain paragraph
          return (
            <p key={i} className="text-sm text-steel leading-relaxed">{stripInline(line)}</p>
          );
        })}
      </div>
    );
  };

  // Turn inline **bold** into a styled span; leave the rest as text.
  const stripInline = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) =>
      /^\*\*[^*]+\*\*$/.test(p)
        ? <strong key={i} className="text-chalk font-bold">{p.replace(/\*\*/g, "")}</strong>
        : <span key={i}>{p}</span>
    );
  };

  const getButtonText = () => {
    if (isAnalyzing) return "Forking it...";
    return "Fork it!";
  };

  return (
    <div className="min-h-screen bg-carbon text-chalk">
      <a href="#main-content" className="skip-link no-print">Skip to main content</a>
      {/* ... Navigation and Hero Sections ... */}
      <nav className="border-b border-carbon-line bg-carbon/90 backdrop-blur-md sticky top-0 z-50 no-print">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-display text-lg tracking-tight text-chalk uppercase">The Plastic <span className="text-fork-green">Fork</span></span>
            {profile?.is_pro && <span className="font-mono-data text-[10px] bg-fork-green text-carbon px-2 py-0.5 font-bold">PRO</span>}
          </div>
          <div>
            {user ? (
              <div className="flex items-center gap-4">
                <span className="hidden sm:inline text-xs font-mono-data text-steel">{user.email}</span>
                <button onClick={handleLogout} className="text-xs font-bold uppercase tracking-widest text-steel hover:text-chalk transition-colors">Sign Out</button>
              </div>
            ) : (
              <button onClick={handleLogin} className="text-xs font-bold uppercase tracking-widest bg-chalk text-carbon px-4 py-2 hover:bg-white transition-colors">Sign In</button>
            )}
          </div>
        </div>
      </nav>

      <section className="relative flex items-center justify-center px-4 py-20 text-center no-print border-b border-carbon-line">
        <div className="max-w-4xl mx-auto space-y-6">
          <span className="font-mono-data text-xs uppercase tracking-[0.2em] text-fork-green">Precision, not positivity</span>
          <h1 className="font-display text-5xl sm:text-7xl leading-[0.95] tracking-tight uppercase">
            You can&apos;t out-train<br />a <span className="text-fork-green">bad fork.</span>
          </h1>
          <p className="text-lg text-steel max-w-2xl mx-auto">Precision auditing. Blacklist the fluff. Get results. Keeping you in a deficit.</p>
        </div>
      </section>

      <section className="max-w-2xl mx-auto px-6 py-16 text-center border-b border-carbon-line no-print">
        <h2 className="font-display text-2xl uppercase mb-4">What the fork we do</h2>
        <p className="text-steel leading-relaxed">
          The Plastic Fork is an intelligent meal management tool designed to help you organize your culinary life.
          By signing in with Google, we securely sync your preferences and saved meal plans across devices.
          We prioritize your privacy and only use your basic profile information to provide a personalized,
          seamless experience.
        </p>
      </section>

      <section id="main-content" className="relative py-12 px-4">
        <div className="max-w-2xl mx-auto space-y-12">
          <div className="bg-carbon-raised p-8 border border-carbon-line shadow-2xl">
            {generatedPlan ? (
              <div className="space-y-6">
                <div className="bg-carbon p-6 border border-carbon-line printable-plan">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="font-display text-2xl text-chalk uppercase">Audit Report</h3>
                    <div className="text-right">
                      <p className="text-[10px] text-steel uppercase font-bold tracking-widest">Forbidden Items</p>
                      <p className="text-xs text-blacklist-red font-mono-data">{fridgeInput || "None Reported"}</p>
                    </div>
                  </div>

                  <div className="border-t border-carbon-line pt-4">
                    {renderPlan(generatedPlan)}
                  </div>

                  <div className="mt-8 flex flex-wrap items-center gap-4 no-print">
                    <button onClick={() => { setGeneratedPlan(null); setErrorMessage(null); }} className="text-sm text-steel hover:text-chalk transition-colors"><span aria-hidden="true">←</span> Start New Audit</button>
                    <div className="flex gap-3 ml-auto">
                      <button onClick={handleCopyPlan} className="text-xs font-bold uppercase tracking-widest border border-carbon-line text-steel hover:text-chalk hover:border-steel px-4 py-2 transition-colors">
                        {copied ? "Copied ✓" : "Copy"}
                      </button>
                      <button onClick={handleDownloadPlan} className="text-xs font-bold uppercase tracking-widest border border-carbon-line text-steel hover:text-chalk hover:border-steel px-4 py-2 transition-colors">
                        Download
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : needsUpgrade ? (
              <div className="space-y-6 no-print text-center">
                <div className="space-y-2">
                  <h2 className="font-display text-2xl text-chalk uppercase">You&apos;ve used your free audits</h2>
                  <p className="text-sm text-steel">Unlock unlimited audits for life. One payment, no subscription.</p>
                </div>

                <div className="bg-carbon p-8 border border-carbon-line">
                  <div className="flex items-baseline justify-center gap-1 mb-6">
                    <span className="font-mono-data text-5xl font-bold text-fork-green">$9</span>
                    <span className="text-sm text-steel font-bold uppercase tracking-widest">/ lifetime</span>
                  </div>
                  <ul className="text-sm text-chalk space-y-2 mb-8 text-left max-w-xs mx-auto">
                    <li className="flex gap-2"><span className="text-fork-green" aria-hidden="true">✓</span> Unlimited meal plan audits, forever</li>
                    <li className="flex gap-2"><span className="text-fork-green" aria-hidden="true">✓</span> All your plans saved &amp; synced</li>
                    <li className="flex gap-2"><span className="text-fork-green" aria-hidden="true">✓</span> One-time payment. No subscription.</li>
                  </ul>

                  {errorMessage && (
                    <div role="alert" className="mb-4 border border-blacklist-red/60 bg-blacklist-red/10 px-4 py-3 text-sm text-blacklist-red">
                      {errorMessage}
                    </div>
                  )}

                  <button
                    onClick={handleUpgrade}
                    disabled={isUpgrading}
                    aria-busy={isUpgrading}
                    className="w-full py-4 bg-fork-green text-carbon font-black uppercase tracking-widest disabled:opacity-30 shadow-xl transition-all active:scale-95"
                  >
                    {isUpgrading ? "Redirecting to checkout..." : "Unlock Lifetime Access — $9"}
                  </button>
                </div>
                <p className="font-mono-data text-[10px] text-steel-dim uppercase tracking-widest">Secure checkout via Stripe</p>
              </div>
            ) : (
              <div className="space-y-6 no-print">
                {/* Mode toggle: Build a plan vs Roast my day */}
                <div className="grid grid-cols-2 gap-0 border border-carbon-line" role="tablist" aria-label="Choose mode">
                  <button
                    role="tab"
                    aria-selected={mode === "plan"}
                    onClick={() => { setMode("plan"); setErrorMessage(null); }}
                    className={`py-3 text-xs font-black uppercase tracking-widest transition-colors ${mode === "plan" ? "bg-fork-green text-carbon" : "bg-transparent text-steel hover:text-chalk"}`}
                  >
                    Build My Plan
                  </button>
                  <button
                    role="tab"
                    aria-selected={mode === "roast"}
                    onClick={() => { setMode("roast"); setErrorMessage(null); }}
                    className={`py-3 text-xs font-black uppercase tracking-widest transition-colors ${mode === "roast" ? "bg-fork-green text-carbon" : "bg-transparent text-steel hover:text-chalk"}`}
                  >
                    Roast My Day
                  </button>
                </div>

                {mode === "roast" ? (
                  <>
                    <div className="space-y-2">
                      <h2 className="font-display text-2xl text-chalk uppercase">Roast My Day</h2>
                      <p className="text-sm text-steel">Confess what you actually ate. The Fork will audit the damage.</p>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="food-log" className="block text-[10px] font-bold text-steel uppercase tracking-widest ml-1">Today&apos;s Intake</label>
                      <textarea
                        id="food-log"
                        value={foodLog}
                        onChange={(e) => setFoodLog(e.target.value)}
                        placeholder="e.g. Breakfast: 3 donuts and a large latte. Lunch: skipped. Dinner: whole pizza and a few beers..."
                        className="w-full h-40 px-4 py-3 bg-carbon border border-carbon-line text-chalk outline-none resize-none focus:border-fork-green transition-colors"
                      />
                    </div>

                    {errorMessage && (
                      <div role="alert" className="border border-blacklist-red/60 bg-blacklist-red/10 px-4 py-3 text-sm text-blacklist-red">
                        {errorMessage}
                      </div>
                    )}

                    <button onClick={handleRoast} disabled={isAnalyzing} aria-busy={isAnalyzing} className="w-full py-4 bg-fork-green text-carbon font-black uppercase tracking-widest disabled:opacity-30 shadow-xl transition-all active:scale-95">
                      {isAnalyzing ? "Roasting..." : "Roast it!"}
                    </button>

                    <p aria-live="polite" className="sr-only">
                      {isAnalyzing ? "Roasting your day, please wait." : ""}
                    </p>
                  </>
                ) : (
                <>
                <div className="space-y-2">
                  <h2 className="font-display text-2xl text-chalk uppercase">Clinical Parameters</h2>
                  <p className="text-sm text-steel">Input your biological data and food restrictions.</p>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="relative">
                    <label htmlFor="weight" className="sr-only">Current weight in pounds</label>
                    <input id="weight" type="number" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Current Weight" aria-describedby="weight-unit" className="w-full px-4 py-3 bg-carbon border border-carbon-line text-chalk font-mono-data outline-none focus:border-fork-green transition-colors" />
                    <span id="weight-unit" className="absolute right-4 top-3.5 text-steel font-mono-data font-bold text-[10px]">LBS</span>
                  </div>
                  <div className="relative">
                    <label htmlFor="goal-weight" className="sr-only">Goal weight in pounds</label>
                    <input id="goal-weight" type="number" inputMode="numeric" value={goalWeight} onChange={(e) => setGoalWeight(e.target.value)} placeholder="Goal Weight" aria-describedby="goal-unit" className="w-full px-4 py-3 bg-carbon border border-carbon-line text-chalk font-mono-data outline-none focus:border-fork-green transition-colors" />
                    <span id="goal-unit" className="absolute right-4 top-3.5 text-steel font-mono-data font-bold text-[10px]">GOAL</span>
                  </div>
                  <div className="relative">
                    <label htmlFor="body-fat" className="sr-only">Body fat percentage</label>
                    <input id="body-fat" type="number" inputMode="decimal" value={bodyFat} onChange={(e) => setBodyFat(e.target.value)} placeholder="Body Fat %" aria-describedby="fat-unit" className="w-full px-4 py-3 bg-carbon border border-carbon-line text-chalk font-mono-data outline-none focus:border-fork-green transition-colors" />
                    <span id="fat-unit" className="absolute right-4 top-3.5 text-steel font-mono-data font-bold text-[10px]">% FAT</span>
                  </div>
                  <div>
                    <label htmlFor="activity-level" className="sr-only">Activity level</label>
                    <select id="activity-level" value={activityLevel} onChange={(e) => setActivityLevel(e.target.value)} className="w-full px-4 py-3 bg-carbon border border-carbon-line text-chalk outline-none appearance-none cursor-pointer focus:border-fork-green transition-colors">
                      <option value="1.2">Sedentary (Minimal Movement)</option>
                      <option value="1.375">Light (1-2 days/week)</option>
                      <option value="1.55">Moderate (3-5 days/week)</option>
                      <option value="1.725">Heavy (Daily Training)</option>
                      <option value="1.9">Elite (Twice Daily)</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="blacklist" className="block text-[10px] font-bold text-steel uppercase tracking-widest ml-1">The Blacklist</label>
                  <textarea 
                    id="blacklist"
                    value={fridgeInput} 
                    onChange={(e) => setFridgeInput(e.target.value)} 
                    placeholder="List foods you refuse to eat (e.g. No eggplant, no dairy, no cilantro)..." 
                    className="w-full h-32 px-4 py-3 bg-carbon border border-carbon-line text-chalk outline-none resize-none focus:border-blacklist-red transition-colors" 
                  />
                </div>

                {errorMessage && (
                  <div role="alert" className="border border-blacklist-red/60 bg-blacklist-red/10 px-4 py-3 text-sm text-blacklist-red">
                    {errorMessage}
                  </div>
                )}
              
                <button onClick={handleForkIt} disabled={isAnalyzing} aria-busy={isAnalyzing} className="w-full py-4 bg-fork-green text-carbon font-black uppercase tracking-widest disabled:opacity-30 shadow-xl transition-all active:scale-95">
                  {getButtonText()}
                </button>

                {/* Screen-reader announcement for the loading state */}
                <p aria-live="polite" className="sr-only">
                  {isAnalyzing ? "Generating your audit report, please wait." : ""}
                </p>
                </>
                )}
              </div>
            )}
          </div>

          {user && audits.length > 0 && !generatedPlan && (
            <div className="space-y-4 no-print animate-in fade-in slide-in-from-bottom-4 duration-700">
              <h3 className="text-xs font-bold uppercase tracking-widest text-steel">Audit History</h3>
              <div className="grid grid-cols-1 gap-3">
                {audits.map((audit) => (
                  <button 
                    key={audit.id}
                    onClick={() => {
                        setWeight(audit.weight);
                        setGoalWeight(audit.goal_weight);
                        setBodyFat(audit.body_fat);
                        setActivityLevel(audit.activity_level);
                        setFridgeInput(audit.ingredients);
                        setGeneratedPlan(audit.generated_plan);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="flex items-center justify-between p-5 bg-carbon-raised border border-carbon-line hover:border-fork-green/50 transition-all group"
                  >
                    <div className="text-left">
                      <p className="text-[10px] font-mono-data text-steel uppercase mb-1">{new Date(audit.created_at).toLocaleDateString()}</p>
                      <p className="text-sm font-bold text-chalk font-mono-data">{audit.weight} LBS <span aria-hidden="true">→</span> <span className="text-fork-green">{audit.goal_weight} LBS</span></p>
                      <p className="text-[9px] text-steel-dim uppercase mt-1 truncate max-w-[150px]">Excluded: {audit.ingredients}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-black uppercase tracking-tighter text-steel group-hover:text-fork-green">Open Report <span aria-hidden="true">→</span></span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
      {/* FOOTER ADDED HERE INSIDE THE MAIN DIV */}
      <footer className="py-10 text-center border-t border-carbon-line">
        <a href="/privacy" className="font-mono-data text-[10px] uppercase tracking-[0.2em] font-bold text-steel hover:text-fork-green transition-colors">
          Privacy Policy
        </a>
      </footer>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-carbon flex items-center justify-center text-chalk font-mono-data uppercase tracking-widest">Initialising Audit...</div>}>
      <MealGenerator />
    </Suspense>
  );
}