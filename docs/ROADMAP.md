# The Plastic Fork — Product Roadmap & Build Spec

> **For:** builder IDE / AI coding agent
> **Repo location:** `/docs/ROADMAP.md`
> **Version:** 1.0
> **Last updated:** 2026-09-19

---

## 0. How to use this document

This is a build spec, not a pitch deck. Each feature below has: the problem it solves, the data it needs, the schema changes, the API surface, the UI surface, and the acceptance criteria. Build them in phase order — later phases depend on the data pipeline established in Phase 1.

**Do not skip Section 1 (Current State Fixes).** Several roadmap features read from tables that currently have integrity problems.

**Terminology used throughout (match existing product vocabulary):**

| Term | Meaning |
|---|---|
| Audit | A generated meal plan |
| The Blacklist | User's excluded foods |
| Clinical Parameters | The intake form (weight, goal, body fat, activity) |
| Coach Forker | The AI chat persona |
| The Gadget | The dashboard stats/chart module |
| Roast My Day | Existing feature — AI critique of the day |

---

## 1. Current State — fixes before new work

These are blockers or credibility bugs visible in the current paid dashboard.

### 1.1 Weight trend chart direction
The trend chart renders an ascending line (162 → 175) against a stated goal of 175 → 160, with the goal ring at 0% and copy reading "Keep grinding." Either the series is plotting in reverse chronological order, or seed/demo data contradicts the goal. **Fix:** verify sort order is ascending by `logged_at`; if a user genuinely gained, the ring copy must reflect that honestly rather than showing 0% with neutral encouragement (see §2.2 for the honest-state copy).

### 1.2 Display name
Dashboard heading renders `ICREATE.COM` — the email local part is being used as a display name. **Fix:** pull `given_name` from the Google OAuth profile; fall back to "Forker" if absent. Never render an email fragment as a heading.

### 1.3 Duplicate audit records
Audit history shows three identical `2/10/2026` entries with identical parameters. Likely a double-submit or missing idempotency key on the generate endpoint. **Fix:** add an idempotency key on audit creation (hash of `user_id + params + minute-bucket`), and disable the generate button during the in-flight request.

### 1.4 Empty-state for the chart
A user with one weigh-in gets a one-point "trend." Require ≥ 2 points to render a line, and ≥ 7 points before showing any trend-derived claim. Below that, show: *"Not enough data to audit yet. Log for a week."*

---

## 2. Phase 1 — The Truth Engine

**Strategic rationale:** AI meal plan generation is commoditized. Retention comes from adherence and honest feedback. This phase turns the product from a plan generator into a measurement instrument, and it is the data foundation every later phase reads from.

### 2.1 Adaptive TDEE

**Problem:** Mifflin-St Jeor + an activity multiplier is a population average presented as a personal number. Individual error is routinely ±200–400 kcal. The app currently asks users to self-select "Moderate (3-5 days/week)" — a field where nearly everyone overestimates.

**Solution:** Back-calculate actual maintenance from observed intake and observed weight change, and recalibrate weekly.

**Method:**
1. Compute an exponentially weighted moving average (EWMA) of scale weight, α = 0.25, over a trailing 14-day window. Never use raw daily weight for any derived calculation — daily variance from water, glycogen, and gut content routinely exceeds real fat change.
2. Require ≥ 14 days of data with ≥ 10 weigh-ins and ≥ 10 days of logged intake before producing an estimate.
3. `observed_tdee = avg_daily_intake − (Δ_ewma_lbs × 3500 / days_in_window)`
4. Blend toward the formula estimate when confidence is low:
   `final_tdee = (w × observed_tdee) + ((1 − w) × formula_tdee)` where `w` scales 0 → 1 as logging completeness goes from 40% to 90%.
5. Recalculate weekly. Clamp week-over-week movement to ±150 kcal to prevent oscillation from a bad logging week.

**Schema:**
```
tdee_estimates
  id                uuid pk
  user_id           uuid fk
  computed_at       timestamptz
  formula_tdee      int
  observed_tdee     int          nullable
  final_tdee        int
  confidence        numeric(3,2) -- 0.00 to 1.00
  window_days       int
  intake_days_logged int
  weighin_days_logged int

weight_logs
  id          uuid pk
  user_id     uuid fk
  logged_at   date            -- unique per (user_id, logged_at)
  weight_lbs  numeric(5,2)
  ewma_lbs    numeric(5,2)    -- computed on write
```

**API:**
```
GET  /api/tdee/current   → { final_tdee, confidence, method, window }
POST /api/tdee/recompute → triggers recalculation (idempotent per day)
```

**UI:** New card in The Gadget. Show the number, the confidence, and the source. Example: `2,140 KCAL — measured, not guessed. Based on 18 days of your data.` At low confidence: `2,310 KCAL — estimated from your stats. Log 6 more days and we'll measure it properly.`

**Acceptance criteria:**
- [ ] With < 14 days data, endpoint returns formula estimate with `method: "formula"` and confidence ≤ 0.3
- [ ] With ≥ 14 days and ≥ 90% logging, `method: "measured"` and confidence ≥ 0.8
- [ ] A single 4 lb overnight water spike does not move `final_tdee` by more than 150 kcal
- [ ] Recompute is idempotent — calling twice in a day produces one row

---

### 2.2 The Plateau Auditor

**Problem:** When the scale stalls, every competitor app says "stay consistent!" That is useless and it is where users quit. This is the single most on-brand feature the product can ship — it delivers the homepage promise ("precision auditing") literally.

**Solution:** A weekly report showing expected vs. actual change, the implied gap, and ranked probable causes with evidence.

**Trigger:** Weekly, and on-demand from the dashboard. Surface proactively when EWMA change is < 25% of predicted for 10+ consecutive days.

**Computation (do this in code, not in the LLM):**
```
predicted_loss_lbs = (tdee − avg_intake) × days / 3500
actual_loss_lbs    = ewma_start − ewma_end
gap_lbs            = predicted_loss_lbs − actual_loss_lbs
implied_daily_gap_kcal = gap_lbs × 3500 / days
```

**Ranked cause analysis.** Compute evidence scores for each candidate, then pass the structured findings to the LLM for phrasing only. Never let the model invent the numbers.

| Cause | Evidence signals |
|---|---|
| Underreporting / portion drift | Large `implied_daily_gap_kcal`; weekend-vs-weekday intake variance; drop in logging completeness; rise in untracked meals |
| Metabolic adaptation | Sustained deficit > 8 weeks; gradual, consistent gap rather than sudden |
| Water / glycogen retention | Sudden step change; recent sodium-heavy logged meals; new or intensified training; (if cycle tracking enabled) luteal phase |
| Logging gaps | Days with zero entries; meals logged without portions |
| Genuine plateau | All above ruled out; deficit confirmed small |

**Output shape:**
```json
{
  "period": { "start": "2026-09-01", "end": "2026-09-14" },
  "predicted_loss_lbs": 2.4,
  "actual_loss_lbs": 0.3,
  "gap_lbs": 2.1,
  "implied_daily_gap_kcal": 525,
  "causes": [
    { "cause": "portion_drift", "confidence": 0.62, "evidence": ["Weekend intake averages 780 kcal above weekday", "3 days logged without portion sizes"] }
  ],
  "verdict": "string — LLM-phrased, derived only from fields above"
}
```

**UI:** New dashboard section, reachable from a `WHAT THE FORK HAPPENED` button. Lead with the two numbers side by side (expected vs. actual), then the gap, then ranked causes with their evidence visible.

**Voice note:** The verdict is blunt about the *data*, never about the *person*. "Your logged intake doesn't match your weight change — the gap is about 525 kcal a day" is correct. "You're lying to yourself" is not.

**Acceptance criteria:**
- [ ] All numeric fields computed server-side; LLM receives them as input and cannot alter them
- [ ] Report refuses to generate with < 10 days of data, with an explicit message
- [ ] At least one cause is always returned; "insufficient data" is a valid cause
- [ ] Verdict never attributes moral failure to the user (add this to the eval set)

---

### 2.3 Coach Forker — grounding upgrade

**Problem:** The chat currently offers prompts like "Why am I not dropping weight?" and "Audit my last plan. Be honest." If the model answers those from general knowledge rather than the user's actual data, it produces generic advice under a blunt persona — the worst combination, because the confident tone implies data access it doesn't have.

**Solution:** Inject a structured context block into every Coach Forker request.

**Context block (assembled server-side, prepended to each conversation):**
```
USER CONTEXT (authoritative — do not contradict)
  Current weight (EWMA): 174.2 lbs
  Goal weight: 160 lbs
  Trend, 14d: -0.4 lbs
  TDEE: 2,140 kcal (measured, confidence 0.84)
  Avg intake, 14d: 1,980 kcal
  Logging completeness, 14d: 71%
  Blacklist: cilantro, eggplant, dairy
  Active plan: Audit #4, generated 2026-09-17
  Last plateau audit: gap of 525 kcal/day, primary cause portion_drift
  Streak: 1 day
```

**Persona system prompt:**
```
You are Coach Forker. You have seen this user's actual numbers — they are in
the USER CONTEXT block and they are authoritative.

Voice: clinical, blunt, dry. Short sentences. Active verbs. You are the coach
who has read the food log and will not pretend it is fine.

Rules:
- Cite the user's real numbers. Never invent a figure not present in context.
- If the data can't answer the question, say exactly that and say what to log.
- Criticize the data, the plan, or the habit. Never the person's worth.
- Profanity is replaced with "fork" — at most once per response, and never
  aimed at the user.
- No wellness language: no "journey," "self-care," "listen to your body."
- If the user describes restriction, purging, or a goal below a healthy BMI,
  drop the persona entirely and respond per the SAFETY block.
```

**Acceptance criteria:**
- [ ] Every Coach Forker response that cites a number cites one present in context
- [ ] With sparse data, the coach names the gap rather than guessing
- [ ] Persona drops cleanly on safety triggers (see §6)
- [ ] Conversation history is passed on every turn (the endpoint is stateless)

---

## 3. Phase 2 — Adherence Tools

These attack the actual failure mode: plans die in restaurants, on bad nights, and when the user doesn't want tonight's dinner.

### 3.1 Instant Swap

One tap on any meal returns a macro-equivalent alternative that respects the blacklist.

**Why it matters beyond convenience:** swap data is an implicit blacklist. If a user swaps out salmon four times, that's a stronger signal than anything they typed into the free-text field. Feed swap history back into generation.

```
meal_swaps
  id, user_id, audit_id, original_meal_id,
  replacement_meal_id, reason enum(disliked|unavailable|time|craving|other),
  created_at
```

Constraint: replacement must be within ±8% kcal and ±10g protein of the original. Show the delta to the user rather than hiding it.

- [ ] Swap respects blacklist and all prior swap-outs
- [ ] Macro delta displayed on the swap card
- [ ] After 3 swap-outs of the same ingredient, prompt: `Add [ingredient] to the blacklist?`

### 3.2 Restaurant / Menu Decoder

Paste a menu URL or photo → ranked orders that fit the day's remaining budget, with explicit modifications.

```
POST /api/decode-menu
  body: { image_base64 | url, remaining_kcal, remaining_protein, blacklist }
  → { options: [{ name, est_kcal, est_protein, modifications[], confidence }] }
```

Estimates must show ranges, not false precision: `620–780 kcal`. Rank by fit, not by calories alone — the highest-protein option that fits is usually the right call.

- [ ] Returns ≤ 4 options, ranked
- [ ] Every option includes at least one concrete modification
- [ ] Blacklisted items never appear
- [ ] Ranges, never single-point estimates

### 3.3 Photo Meal Audit

Snap the plate → estimate + verdict against the day's remaining budget.

Honesty requirement: multimodal portion estimation is imperfect. Show a range and a confidence, and make correction one tap. Corrections are the training signal for that user's portion baseline — store them.

```
meal_photos
  id, user_id, image_url, est_kcal_low, est_kcal_high,
  est_protein_g, confidence, user_corrected_kcal nullable, created_at
```

- [ ] Never displays a single-point calorie number
- [ ] Correction flow is one tap from the result
- [ ] Corrections adjust that user's future portion estimates
- [ ] Low-confidence results say so plainly rather than guessing confidently

### 3.4 Event Banking

`I have a wedding Saturday` → redistribute the week's calories around it.

Works with real life instead of pretending it doesn't exist. Cap the redistribution so no single day drops below the safety floor in §6.

- [ ] No day falls below the minimum floor after redistribution
- [ ] Weekly total deficit is preserved, not increased
- [ ] User sees the before/after day-by-day targets before confirming

---

## 4. Phase 3 — Practical Constraints

### 4.1 Prep Consolidation
Build the week around shared components so 5 meals come from 2 cook sessions. Time is the binding constraint for most users, not knowledge. Add a `prep_sessions` concept to audit generation and show a consolidated shopping + prep order.

### 4.2 Budget Cap
Cost per serving and a weekly grocery ceiling. Genuinely rare in this category and a strong differentiator. Requires a price reference table; regional averages are acceptable at v1 with a clear disclaimer.

### 4.3 Household Mode
One cook session, different targets across household members. Solves the "I can't eat separately from my family" objection. Scale portions per member from a shared recipe base.

### 4.4 Wearable Sync
Apple Health / Garmin / Whoop for activity and weight. Replaces the self-reported activity dropdown, which is the least reliable input in the product. Feeds directly into §2.1 — with wearable data, TDEE confidence rises faster.

---

## 5. Phase 4 — Monetization & Growth

### 5.1 Grocery handoff
Shopping list → Instacart / Amazon Fresh affiliate. Real convenience, not a bolt-on ad. This is the natural revenue line beyond subscription.

### 5.2 Gamification tightening
Existing badges (`FIRST BLOOD`, `REPEAT OFFENDER`, `ON A ROLL`, `LOCKED IN`, `GOAL SLAYER`) currently key off audit count. Rekey them to **adherence and logging**, not plan generation — generating plans is cheap and rewarding it trains the wrong behavior. Streak should mean "days logged," not "days visited."

### 5.3 Paid tier boundary
Recommended split, for reference:
- **Free:** plan generation, blacklist, basic history
- **Paid:** Adaptive TDEE, Plateau Auditor, Coach Forker, photo audit, menu decoder, swaps

The truth-engine features are the ones worth paying for — they're the ones competitors can't trivially clone.

---

## 6. Safety Requirements — non-negotiable, implement in Phase 1

A blunt, deficit-focused tool sits adjacent to genuinely risky territory, and the "precision auditing" framing amplifies that for a small subset of users. These are not optional, and they are also what keeps the product through app store review.

### 6.1 Hard numeric floors
- **Goal weight:** reject any goal below BMI 18.5 for the user's height. Do not generate a plan. Explain why.
- **Body-composition floor.** When body fat % is supplied, validate the goal weight against implied composition before generating:
  ```
  lean_mass      = current_weight × (1 − bodyfat_pct)
  implied_bf_pct = (goal_weight − lean_mass) / goal_weight
  ```
  Reject the goal if `implied_bf_pct` falls below **8% (male)** or **15% (female)**. These are conservative floors set above the essential-fat minimum, because the estimate carries error from both the input body fat figure and the lean-preservation assumption. The failure response must explain the arithmetic rather than simply refusing, and offer both exits: adjust the goal, or correct the body fat input. The same validated figures must be injected into the Coach Forker context; the coach should never restate an unvalidated goal as a target.
- **Calorie floor:** never generate a plan below 1,500 kcal/day (male) or 1,200 kcal/day (female), regardless of what the deficit math produces.
- **Deficit cap:** maximum 25% below measured TDEE. Cap it silently in the math, but tell the user it was capped and why.
- **Rate-of-loss cap:** if requested timeline implies > 1% bodyweight per week, reject the timeline and propose the nearest safe one.

These are enforced server-side at generation time, not in client validation.

### 6.2 Language triggers
If chat, the blacklist field, or Roast My Day contains signals of restriction, purging, compensatory exercise, or self-harm: **drop the Coach Forker persona entirely.** No roast, no blunt verdict, no joke. Respond plainly, express concern directly, and surface support resources (National Alliance for Eating Disorders helpline). Do not continue with numeric diet guidance in that session.

### 6.3 Feature-level suppression
Once a safety trigger fires for a user, suppress Roast My Day, the plateau auditor's blunt verdict, and streak pressure notifications for that session. A user in that state should not receive an automated critique of their eating.

### 6.4 Tone boundary — applies everywhere
The brand criticizes **food, habits, and plans**. It never criticizes the person. `That snack is forked` is in voice. `You forked up` is not. Add this to the LLM eval set and test it on every prompt change.

- [ ] Floors enforced server-side, covered by tests
- [ ] Safety triggers tested against an adversarial prompt set
- [ ] Persona-drop verified for chat, roast, and plateau verdict paths
- [ ] Tone boundary in the automated eval suite

---

## 7. Build Order (recommended)

| Order | Item | Why here |
|---|---|---|
| 1 | §1 Current state fixes | Data integrity blocks everything downstream |
| 2 | §6 Safety floors | Cheap now, expensive to retrofit |
| 3 | §2.1 Adaptive TDEE | Foundation for all later intelligence |
| 4 | §2.2 Plateau Auditor | Same pipeline as 2.1; highest brand payoff |
| 5 | §2.3 Coach grounding | Makes the existing chat feature actually credible |
| 6 | §3.1 Instant Swap | Cheapest adherence win |
| 7 | §3.2 Menu Decoder | Highest real-world adherence value |
| 8 | §3.3 Photo Audit | Heavier lift, needs correction loop |
| 9 | §5.2 Gamification rekey | Quick, once logging data exists |
| 10 | Phase 3 & 4 | Prioritize by observed churn reasons |

**If only two things get built:** Adaptive TDEE and the Plateau Auditor. They share one data pipeline, they make the tagline literally true, and together they convert the product from a plan generator into something with a weekly reason to open.

---

## 8. Design constraints (from brand guidelines v1.0)

- Square corners throughout — no rounded cards
- Green `#46D17A` = on-plan / measured. Red `#EF5B50` = restriction / error. Gold `#E8B84B` = earned milestones only, never decorative
- All numeric readouts in JetBrains Mono. Numbers are the product
- Headlines in Archivo Black; body and UI in Inter
- One "fork" wordplay per screen maximum. Clinical Parameters, macros, and data fields never get the joke
- Empty states are invitations to act, not apologies

---

## 9. Near-term picks (from tonight's session)

Not-yet-built items the owner explicitly wants folded in, mapped to the spec above:

- **BMI calculator** → not a standalone gadget; it's the mechanism behind the §6.1 goal-weight safety floor. Build BMI + body-composition validation together.
- **Meal swap** → §3.1 Instant Swap.
- **Blacklist inversion fix (FEEDBACK §1.2)** → highest-value quick credibility fix; do alongside §2.3 Coach grounding.

Suggested first pickup when credits return: **blacklist fix + Coach grounding (§2.3), then §6.1 safety floors incl. BMI.**
