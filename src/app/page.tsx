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

  const handleForkIt = async () => {
    if (!weight || !goalWeight) {
        alert("Weight and Goal Weight are required. Don't waste my time.");
        return;
    }

    // --- LOGIC GATE 1: GUEST USER ---
    if (!user) {
      if (localStorage.getItem("plastic-fork-usage-count") === "1") {
        alert("GUEST LIMIT REACHED. Sign in to continue your audits.");
        handleLogin();
        return;
      }
    }

    // --- LOGIC GATE 2: SIGNED IN BUT NOT PRO ($9 PAYWALL) ---
    if (user && (!profile || !profile.is_pro)) {
      if (audits.length >= 1) {
        setIsAnalyzing(true);
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token;

          const res = await fetch("/api/checkout", { 
            method: "POST", 
            headers: { 'Authorization': `Bearer ${token}` }
          });
          
          const data = await res.json();
          if (data.url) {
            window.location.href = data.url; 
            return;
          } else {
            alert(data.error || "Payment system offline.");
          }
        } catch (err) {
          alert("Payment system offline.");
        } finally {
          setIsAnalyzing(false);
        }
        return;
      }
    }

    // --- LOGIC GATE 3: PRO USER LIMITS (2 in 24hrs) ---
    if (user && profile?.is_pro) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentAudits = audits.filter(a => new Date(a.created_at) > twentyFourHoursAgo);
        
        if (recentAudits.length >= 2) {
            alert("PRO LIMIT REACHED: 2 audits per 24 hours. Stick to the plan.");
            return;
        }
    }

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
          activityLevel 
        }),
      });

      const data = await response.json();
      setGeneratedPlan(data.plan);
      
      if (user) {
        await supabase.from('audits').insert([{
          user_id: user.id, 
          user_email: user.email, 
          weight, 
          goal_weight: goalWeight,
          body_fat: bodyFat || "20", 
          activity_level: activityLevel, 
          ingredients: fridgeInput || "None", 
          generated_plan: data.plan
        }]);
        fetchData(user.id); 
      } else {
        // Save guest data for later sync
        localStorage.setItem("plastic-fork-usage-count", "1");
        localStorage.setItem("last-guest-plan-content", data.plan);
        localStorage.setItem("last-guest-plan-meta", JSON.stringify({
          weight, goalWeight, bodyFat: bodyFat || "20", activityLevel, ingredients: fridgeInput || "None"
        }));
      }
    } catch (e) {
      alert("Generation failed.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  const formatPlan = (plan: string) => plan.split('\n').filter(line => line.trim().length > 0);

  const getButtonText = () => {
    if (isAnalyzing) return "Forking it...";
    if (user && (!profile || !profile.is_pro) && audits.length >= 1) {
        return "UNLIMITED LIFE TIME ACCESS - $9";
    }
    return "Fork it!";
  };

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-[#ededed]">
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
                <span className="hidden sm:inline text-xs font-mono text-zinc-500">{user.email}</span>
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

      <section className="relative py-8 px-4">
        <div className="max-w-2xl mx-auto space-y-12">
          <div className="bg-[#161616] rounded-2xl p-8 border border-zinc-800 shadow-2xl">
            {generatedPlan ? (
              <div className="space-y-6">
                <div className="bg-[#0a0a0a] rounded-lg p-6 border border-zinc-800 printable-plan shadow-inner">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-2xl font-bold text-white tracking-tight italic underline uppercase">Audit Report</h3>
                    <div className="text-right">
                      <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest">Forbidden Items</p>
                      <p className="text-xs text-red-500 font-mono">{fridgeInput || "None Reported"}</p>
                    </div>
                  </div>
                  
                  <div className="space-y-3 text-gray-300 border-t border-zinc-800 pt-4">
                    {formatPlan(generatedPlan).map((line, index) => (
                      <p key={index} className="text-sm leading-relaxed">{line}</p>
                    ))}
                  </div>
                  <button onClick={() => setGeneratedPlan(null)} className="mt-8 text-sm text-zinc-500 hover:text-white transition-colors">← Start New Audit</button>
                </div>
              </div>
            ) : (
              <div className="space-y-6 no-print">
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold text-white uppercase">Clinical Parameters</h2>
                  <p className="text-sm text-zinc-500">Input your biological data and food restrictions.</p>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="relative">
                    <input type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Current Weight" className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none" />
                    <span className="absolute right-4 top-3.5 text-zinc-600 font-bold text-[10px]">LBS</span>
                  </div>
                  <div className="relative">
                    <input type="number" value={goalWeight} onChange={(e) => setGoalWeight(e.target.value)} placeholder="Goal Weight" className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none" />
                    <span className="absolute right-4 top-3.5 text-zinc-600 font-bold text-[10px]">GOAL</span>
                  </div>
                  <div className="relative">
                    <input type="number" value={bodyFat} onChange={(e) => setBodyFat(e.target.value)} placeholder="Body Fat %" className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none" />
                    <span className="absolute right-4 top-3.5 text-zinc-600 font-bold text-[10px]">% FAT</span>
                  </div>
                  <select value={activityLevel} onChange={(e) => setActivityLevel(e.target.value)} className="w-full px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none appearance-none cursor-pointer">
                    <option value="1.2">Sedentary (Minimal Movement)</option>
                    <option value="1.375">Light (1-2 days/week)</option>
                    <option value="1.55">Moderate (3-5 days/week)</option>
                    <option value="1.725">Heavy (Daily Training)</option>
                    <option value="1.9">Elite (Twice Daily)</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">The Blacklist</label>
                  <textarea 
                    value={fridgeInput} 
                    onChange={(e) => setFridgeInput(e.target.value)} 
                    placeholder="List foods you refuse to eat (e.g. No eggplant, no dairy, no cilantro)..." 
                    className="w-full h-32 px-4 py-3 bg-[#0a0a0a] border border-zinc-800 rounded-lg text-[#ededed] outline-none resize-none focus:border-red-900/50 transition-colors" 
                  />
                </div>
              
                <button onClick={handleForkIt} disabled={isAnalyzing} className="w-full py-4 bg-[#22c55e] text-black font-black uppercase tracking-widest rounded-lg disabled:opacity-30 shadow-xl transition-all active:scale-95">
                  {getButtonText()}
                </button>
              </div>
            )}
          </div>

          {user && audits.length > 0 && !generatedPlan && (
            <div className="space-y-4 no-print animate-in fade-in slide-in-from-bottom-4 duration-700">
              <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Audit History</h3>
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
                      <p className="text-[10px] font-mono text-zinc-500 uppercase mb-1">{new Date(audit.created_at).toLocaleDateString()}</p>
                      <p className="text-sm font-bold text-white">{audit.weight} LBS → <span className="text-[#22c55e]">{audit.goal_weight} LBS</span></p>
                      <p className="text-[9px] text-zinc-600 uppercase mt-1 truncate max-w-[150px]">Excluded: {audit.ingredients}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-black uppercase tracking-tighter text-zinc-600 group-hover:text-[#22c55e]">Open Report →</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
      {/* FOOTER ADDED HERE INSIDE THE MAIN DIV */}
      <footer className="py-10 text-center opacity-30 hover:opacity-100 transition-opacity">
        <a href="/privacy" className="text-[10px] uppercase tracking-[0.2em] font-bold hover:text-[#22c55e]">
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