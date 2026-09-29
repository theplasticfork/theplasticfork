# The Plastic Fork — Feedback & QA Findings

> **Companion to:** `/docs/ROADMAP.md`
> **Version:** 1.0
> **Last updated:** 2026-09-19
> **Scope:** Review of the paid dashboard, product strategy decisions, and a live Coach Forker transcript

---

## 0. Summary of findings

| # | Finding | Severity | Section |
|---|---|---|---|
| 1 | Goal weight physiologically incoherent; no body-composition validation | **Critical** | §1.1 |
| 2 | Coach Forker inverts blacklist meaning | **High** | §1.2 |
| 3 | Coach conflates "prescribed" with "consumed" | **High** | §1.3 |
| 4 | Coach voice drifts to generic assistant formatting | Medium | §1.4 |
| 5 | Character encoding corruption in chat output | Medium | §1.5 |
| 6 | Weight trend chart contradicts stated goal | Medium | §2.1 |
| 7 | Email local part rendered as display name | Medium | §2.2 |
| 8 | Duplicate audit records | Medium | §2.3 |
| 9 | Single-point "trend" chart | Low | §2.4 |
| 10 | Badges reward generation, not adherence | Strategic | §3.1 |
| 11 | Paid tier drawn around the clonable half | Strategic | §3.2 |

---

## 1. Coach Forker transcript review

**Prompt:** *"Can you tell me how I did on my last meal plan?"*

**Response received:**
> Your last audit shows you're at 175 lb, 12 % body-fat, and you flagged "Less veggies" as a missing piece. I don't have the actual meals logged, so I can't grade the plan itself. **What you need to do:** - Record every food you eat (portion sizes, macros if you can) for at least a week. - Note any categories you're consistently skipping (like vegetables, fruit, whole grains). - Compare the totals to your target calories/macros for a 160-lb, 12 % goal. Once you have that data, I'll tell you exactly where the plan succeeded and where it fell flat.

### What worked

**It refused to bluff.** Asked to grade a plan it couldn't see, it said so and named what was missing instead of generating plausible-sounding praise. This is the hardest behavior to get right and it is already working — protect it through prompt changes with a regression test.

---

### 1.1 — CRITICAL: Goal weight is physiologically incoherent, and nothing caught it

**The math:**

```
Current:  175 lb @ 12% body fat
          → 21.0 lb fat mass
          → 154.0 lb lean mass

Goal:     160 lb

If lean mass is fully preserved:
          160 − 154 = 6.0 lb fat
          6.0 / 160 = 3.75% body fat
```

Essential fat for men is roughly 3–5%. A 3.75% target sits at or below the survival floor — territory that stage-day bodybuilders occupy briefly and dangerously. Even assuming realistic lean loss during a cut, the target lands around 5–6%, which is not a maintainable body composition.

**Three separate failures here:**

1. **The intake form accepted it.** No validation compared goal weight against current weight *and* body fat to check whether the implied composition is achievable.
2. **The coach repeated it back as a planning target** — *"compare the totals to your target calories/macros for a 160-lb, 12 % goal"* — instructing the user to plan toward it. The two figures in that sentence are mutually exclusive.
3. **The roadmap's safety floors would not have caught it.** `ROADMAP.md` §6.1 specifies a BMI 18.5 floor and calorie floors. At most adult heights, 160 lb is a completely normal BMI. **This is a gap in the original spec and is corrected in ROADMAP §6.1.**

**Required fix — see `ROADMAP.md` §6.1 (body-composition floor).**

Failure response must explain the arithmetic rather than simply refusing. In voice:
*"160 lb doesn't work with your numbers. You're carrying 154 lb of lean mass — hitting 160 would put you near 4% body fat, which isn't a goal, it's a medical event. Your realistic floor is about 172 lb. Want to set that, or re-check your body fat number?"*

**Also required:** the same validated figures must be injected into the Coach Forker context block. The coach should never restate an unvalidated goal as a target.

---

### 1.2 — HIGH: Blacklist meaning inverted

The audit record reads `EXCLUDED: LESS VEGGIES`. That is a Blacklist entry — the user asking for **fewer** vegetables.

The coach interpreted it as a nutritional deficiency and advised the user to *"note any categories you're consistently skipping (like vegetables, fruit, whole grains)"* — recommending the exact thing the user asked to avoid.

**Cause:** the context block is likely passing blacklist entries as unlabeled free text, so the model infers meaning from the words rather than the field's semantics.

**Fix:**
- Label the field explicitly and unambiguously in context: `BLACKLIST (foods the user has REFUSED — never recommend these): less veggies, ...`
- Add a system prompt rule: *"Blacklist entries are user-imposed exclusions. Never suggest the user eat more of a blacklisted item. If an exclusion creates a genuine nutritional gap, name the gap and propose an alternative source — do not override the exclusion."*
- Consider migrating the free-text blacklist to structured tags. `ROADMAP.md` §3.1 already proposes deriving blacklist entries from swap behavior, which produces clean structured data and sidesteps free-text ambiguity entirely.

---

### 1.3 — HIGH: "Prescribed" and "consumed" conflated

The coach said it lacked *"the actual meals logged."* But the product **generated the plan** — it knows precisely what it prescribed. What it doesn't know is what was eaten.

Stating it has no meal data makes the product sound amnesiac about its own output, and it's the kind of thing a user notices immediately.

**Fix:** separate the two concepts in the context block.

```
PRESCRIBED (Audit #4, 2026-09-17): [meal list, macros, daily targets]
CONSUMED: no intake logs for this period
```

Correct response shape: *"I know what the plan told you to eat. I don't know what you actually ate — nothing's logged. Log a week and I'll tell you where the two diverged."*

That answer is more useful and it demonstrates the product remembers its own work.

---

### 1.4 — MEDIUM: Voice drift

The response reads as a generic AI assistant wearing the brand as a costume:

- `**What you need to do:**` followed by a bulleted action list — standard assistant formatting, not a blunt coach
- *"vegetables, fruit, whole grains"* — generic nutrition-guidelines language, and the exact wellness register the brand guidelines rule out
- *"where the plan succeeded and where it fell flat"* — soft, corporate-review phrasing

Per brand guidelines v1.0, Coach Forker uses short declarative sentences and plain verbs. No bulleted instruction lists in chat unless the user asks for a checklist.

**Rewritten in voice:**
> Can't grade it. I know what the plan prescribed — I don't know what you ate, because nothing's logged.
>
> Log everything for seven days, portions included. Then I can tell you where the plan and your actual intake parted ways. Right now I'd be guessing, and guessing is what every other app does.

**Fix:** add explicit formatting constraints to the system prompt (prose over bullets in chat; no bold section headers in short replies), and build a voice eval set from the guideline examples.

---

### 1.5 — MEDIUM: Character encoding corruption

The raw output contains soft hyphens or zero-width characters inside `veg­e­ta­bles`, and non-breaking spaces producing `12 %` and `175 lb` with inconsistent spacing.

This is a pipeline bug, not a model behavior. Check for: soft hyphen `U+00AD`, zero-width space `U+200B`, non-breaking space `U+00A0`.

**Fix:** sanitize model output before render — strip `U+00AD` and `U+200B`, normalize `U+00A0` to a regular space. Add a rendering test asserting the chat pane contains no zero-width or soft-hyphen characters. Also normalize unit formatting: `12%` not `12 %`.

---

## 2. Dashboard bugs

### 2.1 Weight trend contradicts the goal
The chart renders an ascending line (roughly 162 → 175) while the header states `175 LBS → 160 LBS` and the ring reads `0%` with the copy *"Keep grinding."*

Either the series sorts in reverse chronological order, or seed data contradicts the stated goal. If the user genuinely gained, the copy must say so honestly rather than pairing 0% with neutral encouragement — soft-pedaling a gain is the exact failure mode the brand exists to avoid.

### 2.2 Display name
The dashboard heading renders `ICREATE.COM` — the email local part used as a display name. Pull `given_name` from the Google OAuth profile; fall back to `Forker`. Never render an email fragment as an `<h1>`.

### 2.3 Duplicate audits
Three identical `2/10/2026` records with identical parameters. Likely double-submit or a missing idempotency key. Add an idempotency key (hash of `user_id + params + minute-bucket`) and disable the generate button while the request is in flight.

### 2.4 Single-point trend
One weigh-in produces a one-point "trend." Require ≥ 2 points to draw a line and ≥ 7 before displaying any trend-derived claim. Below that: *"Not enough data to audit yet. Log for a week."*

---

## 3. Strategic recommendations

### 3.1 Rekey the badges to adherence

Current badges (`FIRST BLOOD`, `REPEAT OFFENDER`, `ON A ROLL`, `LOCKED IN`, `GOAL SLAYER`) appear to fire on audit count, and the streak counter appears tied to visits.

Generating a plan is free and instant. Rewarding it trains users to click the button, not to eat the food — and `TOTAL AUDITS: 4` as a headline metric tells a user nothing about whether they're succeeding.

**Recommendation:** keep the names, change the triggers. Key them to **days logged** and **adherence to targets**. Streak means "days logged," not "days visited." This aligns the incentive with the outcome and generates exactly the data the Adaptive TDEE engine needs.

### 3.2 Move the paywall to the truth engine

**Recommended split:**

| Free | Paid |
|---|---|
| Plan generation | Adaptive TDEE |
| Blacklist | Plateau Auditor |
| Basic history | Coach Forker |
| | Photo audit, menu decoder, instant swap |

**Rationale:** plan generation is the commodity half — any competitor can ship it this quarter with an API key. Adaptive TDEE and the Plateau Auditor require accumulated per-user data, which compounds into a real moat. Free plan generation also drives the logging volume those paid features depend on to work at all.

### 3.3 Ground the chat before promoting it

The suggested prompts on the dashboard — *"Why am I not dropping weight?"*, *"Audit my last plan. Be honest."*, *"What's my biggest weakness?"* — all promise data access. The transcript reviewed here shows the coach handling that gap honestly, which is good, but the underlying issue stands: a blunt persona answering from general knowledge produces confident-sounding generic advice, which erodes trust faster than a hedged answer would.

`ROADMAP.md` §2.3 specifies the context block that fixes this. It's a small change and worth completing before promoting the chat feature further.

---

## 4. Suggested test cases

Add these to the regression suite:

```
[ ] Goal weight implying < 8% BF (male) / < 15% (female) is rejected at intake
[ ] Rejection message explains the arithmetic and offers both exits
[ ] Coach never restates an unvalidated goal weight as a target
[ ] Coach never recommends increasing a blacklisted item
[ ] Coach distinguishes prescribed meals from consumed meals
[ ] Coach declines to grade adherence when no intake logs exist
[ ] Chat output contains no U+00AD, U+200B, or stray U+00A0
[ ] Chat replies under ~80 words contain no bold headers or bullet lists
[ ] Weight chart sorts ascending by logged_at
[ ] Weight gain produces honest copy, not neutral encouragement
[ ] Repeated generate clicks produce exactly one audit record
[ ] No blame-the-person language in any generated output
```
