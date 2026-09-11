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

  const formatPlan = (plan: string) => plan.split('\n').filter(line => line.trim().length > 0);

  const getButtonText = () => {
    if (isAnalyzing) return "Forking it...";
    return "Fork it!";
  };

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-[#ededed]">
      <a href="#main-content" className="skip-link no-print">Skip to main content</a>
      {/* ... Navigation and Hero Sections ... */}
      <nav className="border-b border-zinc-800 bg-[#0f0f0f]/80 backdrop-blur-md sticky top-0 z-50 no-print">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-black tracking-tighter text-xl text-white uppercase">The Plastic Fork</span>
            {profile?.is_pro && <span className="text-[10px] bg-[#22c55e] text-black px-2 py-0.5 rounded-full font-bold">PRO</span>}
          </div>
          <div>
            {user ? (
              <div className="flex items-center gap-4">
                <span className="hidden sm:inline text-xs font-mono text-zinc-400">{user.email}</span>
                <button onClick={handleLogout} className="text-xs font-bold uppercase tracking-widest text-zinc-400 hover:text-white transition-colors">Sign Out</button>
              </div>
            ) : (
              <button onClick={handleLogin} className="text-xs font-bold uppercase tracking-widest bg-white text-black px-4 py-2 rounded-full hover:bg-zinc-200 transition-colors">Sign In</button>
            )}
          </div>
        </div>
      </nav>

      <section className="relative flex items-center justify-center px-4 py-16 text-center no-print">
        <div className="max-w-4xl mx-auto space-y-6">
          <h1 className="text-5xl sm:text-7xl font-bold tracking-tight">
            You can&apos;t out-train a <span className="text-[#22c55e]"><br></br>bad fork.</span>
          </h1>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto italic">Precision auditing. Blacklist the fluff. Get results. Keeping you in a deficit.</p>
          
        </div>
      </section>

      <section style={{ padding: '40px 20px', textAlign: 'center', maxWidth: '800px', margin: '0 auto' }}>
  <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem'}}><b>What the fork we do!</b></h2>
  <p style={{ opacity: 0.8, lineHeight: '1.6' }}>
    The Plastic Fork is an intelligent meal management tool designed to help you organize your culinary life. 
    By signing in with Google, we securely sync your preferences and saved meal plans across devices. 
    We prioritize your privacy and only use your basic profile information to provide a personalized, 
    seamless experience.
  </p>
</section>

      <section id="main-content" className="relative py-8 px-4">
        <div className="max-w-2xl mx-auto space-y-12">
          <div className="bg-[#161616] rounded-2xl p-8 border border-zinc-800 shadow-2xl">
            {generatedPlan ? (
              <div className="space-y-6">
                <div className="bg-[#0a0a0a] rounded-lg p-6 border border-zinc-800 printable-plan shadow-inner">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-2xl font-bold text-white tracking-tight italic underline uppercase">Audit Report</h3>
                    <div className="text-right">
                      <p className="text-[10px] text-zinc-400 uppercase font-bold tracking-widest">Forbidden Items</p>
                      <p className="text-xs text-red-400 font-mono">{fridgeInput || "None Reported"}</p>
                    </div>
                  </div>
                  
                  <div className="space-y-3 text-gray-300 border-t border-zinc-800 pt-4">
                    {formatPlan(generatedPlan).map((line, index) => (
                      <p key={index} className="text-sm leading-relaxed">{line}</p>
                    ))}
                  </div>
                  <button onClick={() => { setGeneratedPlan(null); setErrorMessage(null); }} className="mt-8 text-sm text-zinc-400 hover:text-white transition-colors"><span aria-hidden="true">←</span> Start New Audit</button>
                </div>
              </div>
            ) : needsUpgrade ? (
              <div className="space-y-6 no-print text-center">
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold text-white uppercase">You&apos;ve used your free audits</h2>
                  <p className="text-sm text-zinc-400">Unlock unlimited audits for life. One payment, no subscription.</p>
                </div>

                <div className="bg-[#0a0a0a] rounded-lg p-8 border border-zinc-800">
                  <div className="flex items-baseline justify-center gap-1 mb-6">
                    <span className="text-5xl font-black text-[#22c55e]">$9</span>
                    <span className="text-sm text-zinc-400 font-bold uppercase tracking-widest">/ lifetime</span>
                  </div>
                  <ul className="text-sm text-zinc-300 space-y-2 mb-8 text-left max-w-xs mx-auto">
                    <li className="flex gap-2"><span className="text-[#22c55e]" aria-hidden="true">✓</span> Unlimited meal plan audits, forever</li>
                    <li className="flex gap-2"><span className="text-[#22c55e]" aria-hidden="true">✓</span> All your plans saved &amp; synced</li>
                    <li className="flex gap-2"><span className="text-[#22c55e]" aria-hidden="true">✓</span> One-time payment. No subscription.</li>
                  </ul>

                  {errorMessage && (
                    <div role="alert" className="mb-4 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                      {errorMessage}
                    </div>
                  )}

                  <button
                    onClick={handleUpgrade}
                    disabled={isUpgrading}
                    aria-busy={isUpgrading}
                    className="w-full py-4 bg-[#22c55e] text-black font-black uppercase tracking-widest rounded-lg disabled:opacity-30 shadow-xl transition-all active:scale-95"
                  >
                    {isUpgrading ? "Redirecting to checkout..." : "Unlock Lifetime Access — $9"}
                  </button>
                </div>
                <p className="text-[10px] text-zinc-500 uppercase tracking-widest">Secure checkout via Stripe</p>
              </div>
            ) : (
              <div className="space-y-6 no-print">
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold text-white uppercase">Clinical Parameters</h2>
                  <p className="text-sm text-zinc-500">Input your biological data and food restrictions.</p>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="relative">
                    <label htmlFor="weight" className="sr-only">Current weight in pounds</label>
                    <input id="weight" type="number" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Current Weight" aria-describedby="weight-unit" className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none" />
                    <span id="weight-unit" className="absolute right-4 top-3.5 text-zinc-400 font-bold text-[10px]">LBS</span>
                  </div>
                  <div className="relative">
                    <label htmlFor="goal-weight" className="sr-only">Goal weight in pounds</label>
                    <input id="goal-weight" type="number" inputMode="numeric" value={goalWeight} onChange={(e) => setGoalWeight(e.target.value)} placeholder="Goal Weight" aria-describedby="goal-unit" className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none" />
                    <span id="goal-unit" className="absolute right-4 top-3.5 text-zinc-400 font-bold text-[10px]">GOAL</span>
                  </div>
                  <div className="relative">
                    <label htmlFor="body-fat" className="sr-only">Body fat percentage</label>
                    <input id="body-fat" type="number" inputMode="decimal" value={bodyFat} onChange={(e) => setBodyFat(e.target.value)} placeholder="Body Fat %" aria-describedby="fat-unit" className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none" />
                    <span id="fat-unit" className="absolute right-4 top-3.5 text-zinc-400 font-bold text-[10px]">% FAT</span>
                  </div>
                  <div>
                    <label htmlFor="activity-level" className="sr-only">Activity level</label>
                    <select id="activity-level" value={activityLevel} onChange={(e) => setActivityLevel(e.target.value)} className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none appearance-none cursor-pointer">
                      <option value="1.2">Sedentary (Minimal Movement)</option>
                      <option value="1.375">Light (1-2 days/week)</option>
                      <option value="1.55">Moderate (3-5 days/week)</option>
                      <option value="1.725">Heavy (Daily Training)</option>
                      <option value="1.9">Elite (Twice Daily)</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="blacklist" className="block text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1">The Blacklist</label>
                  <textarea 
                    id="blacklist"
                    value={fridgeInput} 
                    onChange={(e) => setFridgeInput(e.target.value)} 
                    placeholder="List foods you refuse to eat (e.g. No eggplant, no dairy, no cilantro)..." 
                    className="w-full h-32 px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none resize-none focus:border-red-900/50 transition-colors" 
                  />
                </div>

                {errorMessage && (
                  <div role="alert" className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                    {errorMessage}
                  </div>
                )}
              
                <button onClick={handleForkIt} disabled={isAnalyzing} aria-busy={isAnalyzing} className="w-full py-4 bg-[#22c55e] text-black font-black uppercase tracking-widest rounded-lg disabled:opacity-30 shadow-xl transition-all active:scale-95">
                  {getButtonText()}
                </button>

                {/* Screen-reader announcement for the loading state */}
                <p aria-live="polite" className="sr-only">
                  {isAnalyzing ? "Generating your audit report, please wait." : ""}
                </p>
              </div>
            )}
          </div>

          {user && audits.length > 0 && !generatedPlan && (
            <div className="space-y-4 no-print animate-in fade-in slide-in-from-bottom-4 duration-700">
              <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Audit History</h3>
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
                    className="flex items-center justify-between p-5 bg-[#161616] border border-zinc-800 rounded-xl hover:border-[#22c55e]/50 transition-all group"
                  >
                    <div className="text-left">
                      <p className="text-[10px] font-mono text-zinc-400 uppercase mb-1">{new Date(audit.created_at).toLocaleDateString()}</p>
                      <p className="text-sm font-bold text-white">{audit.weight} LBS <span aria-hidden="true">→</span> <span className="text-[#22c55e]">{audit.goal_weight} LBS</span></p>
                      <p className="text-[9px] text-zinc-500 uppercase mt-1 truncate max-w-[150px]">Excluded: {audit.ingredients}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-black uppercase tracking-tighter text-zinc-400 group-hover:text-[#22c55e]">Open Report <span aria-hidden="true">→</span></span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
      {/* FOOTER ADDED HERE INSIDE THE MAIN DIV */}
      <footer className="py-10 text-center">
        <a href="/privacy" className="text-[10px] uppercase tracking-[0.2em] font-bold text-zinc-400 hover:text-[#22c55e] transition-colors">
          Privacy Policy
        </a>
      </footer>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center text-white font-mono uppercase tracking-widest">Initialising Audit...</div>}>
      <MealGenerator />
    </Suspense>
  );
}