# UI review and improvement plan

## November 18, 2026 · implemented UI improvements

A cook can now compare measured shortages before choosing dinner, open a shopping list focused on that meal, and see which weekly quantities are shared. The checks below used disposable kitchens with synthetic recipes.

| Workflow | Before | After |
| --- | --- | --- |
| Keyboard access | The dinner request field had no visible focus ring. Its label was 9 px. White action text on the light paprika fill measured 3.81 to 1. | The field has a visible boundary, a 14 px sentence-case label and a keyboard focus ring. White on the new light fill measures 5.39 to 1. The dark action measures 8.13 to 1. The visible navigation announces the current page and counts such as “Shopping, 2 items to buy.” [Keyboard and contrast checks](../tests/e2e/navigation-accessibility.spec.ts) |
| Pantry → dinner | At 390 × 844, the first choose button started at y=1,139. Eggplant Stew’s 60 g shortage appeared only after expanding its details. | The first choose button spans y=549–593, above the navigation at y=775. At 1440 × 900 it spans y=454–498, previously starting at y=1,102. Eggplant Stew shows “Needs 60 g more eggplant” before the choice. [Mobile comparison](../output/playwright/hallmark-after-2026-11-18/390x844-light-pantry-results.png) |
| Saved dinner → Shopping | A click could settle 414 px down the page at 320 px width. | “Shop for this dinner” focuses the meal title and opens at the top. The dinner and whole-week controls fit above the navigation for click, tap and keyboard entry on both tested phone sizes. Cooked meals retain “Weekly shopping.” [Shopping checks](../tests/e2e/dinner-shopping.spec.ts) |

Pantry groups location, add and search beside the inventory. Both Pantry dinner results and the Everyday collection show measured coverage, uncertainty and relevant preparation notes before selection. Other collection cards describe ingredient-name matches. The recipe collection and search lead the Recipes screen, and each filter explains what it includes. [Dinner comparison checks](../tests/e2e/dinner-candidates.spec.ts) · [Recipe collection checks](../tests/e2e/everyday-collection.spec.ts)

Plan puts today’s dinner first and groups the week range, navigation and dinner count above weekly actions. Cooking opens with the recipe and selected method above its current instruction, timers and persistent step controls. Settings leads with cooking preferences, groups the source inventory in a disclosure and discards connection results when the user changes provider or model. [Plan, theme and provider checks](../tests/e2e/usability.spec.ts) · [Hosted household checks](../tests/e2e/hosted.spec.ts)

### Verification

The viewport review covered Chef, Pantry, pantry dinner results, Recipes, Plan, saved dinner, Shopping, Cooking and Settings at 320 × 568, 390 × 844 and 1440 × 900 in light and dark themes. The 54 Chromium captures, geometry and accessibility snapshots are stored locally under `output/playwright`. All nine views fit the viewport width in every capture. At 320 px the first pantry choice requires a scroll. Both the source cooking instruction and **Next step** fit at all three sizes. Physical-device and assistive-technology checks remain open. [Geometry](../output/playwright/hallmark-after-2026-11-18/screens.json) · [Phone overview](../output/playwright/hallmark-after-2026-11-18/contact-390x844-light.jpg) · [Desktop overview](../output/playwright/hallmark-after-2026-11-18/contact-1440x900-dark.jpg)

All 602 distinct desktop and mobile browser cases passed in isolated runs. An earlier combined run reached its deadline during host sleep. Separate runs covered all 301 cases per device profile. [Desktop](../output/playwright/e2e-2026-11-18T21-03-42-002Z-54943/results.json) · [Mobile](../output/playwright/e2e-2026-11-18T21-03-42-002Z-54944/results.json) · [Mobile Pantry](../output/playwright/e2e-2026-11-18T21-04-11-140Z-55215/results.json)

The final focus and navigation changes also passed 70 targeted cases, including older scrolled views, browser Back and Forward, stale meals, pantry picks, dinner portions and shared purchases. All 836 source tests, built-worker integration checks, TypeScript and lint passed. The hosted suite passed all 12 cases, and first-run setup passed on both device profiles using separate empty kitchens. [Targeted results](../output/playwright/e2e-2026-11-18T20-08-15-478Z-53124/results.json) · [Hosted results](../output/playwright/hosted-2026-11-18T20-10-52-579Z-54226/results.json)

Hallmark 2.0.0 scanned the same 31 UI files and rendered the Chef entry at five sizes. Findings changed from 91 to 83 failures, 310 to 310 design-pattern flags and 36 to 32 warnings. The focus and contrast rules (26a and 40) cleared. Of the remaining failures, 42 concern literal design values, and the small-type rule still identifies 8–10 px secondary text. The full report lists each rule and location. [Before](../output/playwright/hallmark-audit-2026-11-18/findings.json) · [After](../output/playwright/hallmark-after-2026-11-18/findings.json)

<details>
<summary>November 18 baseline, original measurements and acceptance criteria</summary>


Fix keyboard focus and light-theme contrast first. Then make it easier for a household cook to answer two questions in order: “What do I still need for this dinner?” and “Which list am I shopping from?” The current app already calculates both answers. The work is to put them where the decision happens.

Keep the cream and green surfaces, serif recipe titles, labeled destinations, and the cooking screen’s large source instruction with persistent step controls. On the three tested viewport sizes, both the first instruction and **Next step** were visible. Keep the existing dinner-specific and weekly amounts, shared purchase checkboxes, and explicit pantry purchase review. [Cooking capture](../output/playwright/e2e-2026-11-18T11-24-54-968Z-44739/390x844-light-cooking.png) · [Shopping behavior](guide.md)

### 1. Make keyboard focus and primary actions readable

**Observed.** On the Chef discovery screen, Tab lands in the dinner request field without a visible focus indicator. The textarea suppresses its outline, and the enclosing composer shows no focus change. Its label is 9 px. On the saved dinner screen, the light-theme **Cook dinner** label is 11 px bold, white on paprika, with 3.81:1 contrast. The dark-theme pair measures 8.13:1. Hallmark flags focus, contrast, and small functional type in gates 26a, 40, and 75. [Composer styles](../app/globals.css#L368) · [Action colors](../app/globals.css#L419) · [Rendered Chef screen](../output/playwright/hallmark-audit-2026-11-18/.hallmark/before/127.0.0.1-52637-1440x900.png)

**Change.** Give the textarea an immediate focus ring and a visible field boundary. Set its label in sentence case at a readable size. Use the existing darker paprika for light-theme primary fills and accent text where it meets contrast. White on that darker fill measures 5.39:1. Give the active main navigation button a programmatic current state and hide its decorative glyph from the accessible name. Preserve destination labels and meaningful counts. [Theme tokens](../app/globals.css#L1) · [Navigation buttons](../app/components/RagChefApp.tsx#L1627)

**Done when** the cook can Tab and Shift+Tab through the request field, its submit button, and navigation in both themes and see focus at every stop. Normal-sized action text must reach 4.5:1 and the field boundary and focus ring must reach 3:1 against adjacent surfaces. The accessibility tree should identify the current destination once in the visible navigation. [Current navigation snapshot](../output/playwright/e2e-2026-11-18T11-24-54-968Z-44739/390x844-light-shopping.aria.txt) · [W3C text contrast criterion](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

### 2. Open dinner shopping with the meal and list scope in view

**Observed.** From the saved Tomato Rice dinner at 320 × 568, clicking **Weekly shopping** opened the correct items but left the page scrolled 414 px. The dinner title, **Back to dinner**, and scope controls were above the viewport after 1.5 seconds. A fresh run using a touchscreen tap settled at the top. At 390 × 844, both inputs left a 90 px offset. Desktop opened at the top. The distinction matters because a shared rice row shows 300 g for the week even when the selected dinner needs less. [320 px click](../output/playwright/e2e-2026-11-18T11-26-37-475Z-45364/320-click.json) · [320 px tap](../output/playwright/e2e-2026-11-18T11-26-37-475Z-45364/320-tap.json) · [390 px click](../output/playwright/e2e-2026-11-18T11-26-37-475Z-45364/390-click.json)

**Change.** Treat opening Shopping from a dinner as a fresh arrival. Establish the destination scroll position before recording new scroll events and move focus to the meal heading. On the dinner panel, place the shopping action beside the shortage summary and label it **Shop for this dinner** for an uncooked meal. Keep the weekly label on cooked dinners. Keep **For this dinner**, **Whole week**, and the weekly-quantity explanation together above the checklist. [View scroll restoration](../app/components/RagChefApp.tsx#L305) · [Dinner actions](../app/components/ChosenDinner.tsx#L30) · [Shopping scope controls](../app/components/WeeklyKitchenViews.tsx#L184)

**Done when** a click, tap, or keyboard activation from a scrolled dinner lands with the meal title and selected scope visible at 320 and 390 px after layout settles. Verify before any test helper scrolls the page. Switching scope must preserve the shared checkbox. Browser Back and Forward must restore the correct dinner and week, including when that meal was replaced or cooked. [Existing dinner-shopping scenarios](../tests/e2e/dinner-shopping.spec.ts)

### 3. Put measured shortages where people compare dinners

**Observed.** With rice and tomato selected from 12 pantry ingredients, the first result began at y=633 on a 390 × 844 screen. Its **Choose for tonight** action began at y=1,139, below the fixed navigation at y=775. On desktop the first choice began at y=1,102 in a 900 px viewport. The mobile screen spends much of its first view on two results headings, the date and portions, selected picks, and ranking instructions. Eggplant Stew led with “No other food ingredients missing by name.” Opening **Shopping needs** revealed the decision-relevant fact: 60 g more eggplant was needed. [Mobile results](../output/playwright/discovery-audit-2026-11-18/mobile-results.png) · [Desktop results](../output/playwright/discovery-audit-2026-11-18/desktop-results.png) · [Expanded shortage](../output/playwright/discovery-audit-2026-11-18/mobile-comparison.png)

**Change.** Use one results heading. Put the current day, portions, and editable picks together in a compact header. Lead each recipe with its name, the selected ingredient it uses, and the measured outcome. For the audited example, show **Needs 60 g more eggplant** beside the choice. Put the full ingredient breakdown and reservation explanation in the existing disclosure. Keep unknown amounts, frozen stock that needs preparation, and applicable dietary warnings visible before selection. Reuse the existing estimate and ranking. [Results header](../app/components/PantryDinnerResults.tsx#L28) · [Card content](../app/components/RagChefApp.tsx#L1933) · [Measured estimate](../app/components/DinnerEstimate.tsx#L5)

**Done when** the first result’s name, measured outcome, and choose action fit above the mobile navigation at 390 × 844 and inside the desktop viewport at 1440 × 900 with the same fixture. Check fully covered, partial, unknown, and frozen cases. Changing portions must update the summary and its detail together. Comparing results must leave kitchen state untouched, and Back must restore the selected ingredients.

### Audit baseline and verification

Reviewed the working tree at `9e07bc8` including the local dinner-focused Shopping changes. Hallmark 2.0.0 ran in app audit mode on 31 UI source files and rendered the seeded Chef entry screen. It recorded 91 failures, 310 design-pattern flags, and 36 warnings. These are rule matches, often repeated: 295 flags concerned spacing increments. The actionable focus and contrast findings above were independently checked. The tool also mistook the pantry ingredient browser for imitation browser chrome. Use the confirmed findings to order work. [Pinned Hallmark skill](https://github.com/Nutlope/hallmark/tree/04977e15f3dfd6ee4b74c887dac3eb52665d6c92/skills/hallmark) · [Raw findings](../output/playwright/hallmark-audit-2026-11-18/findings.json)

Use a disposable kitchen with synthetic recipes to repeat each change. Recheck the affected flow with keyboard and touch emulation, capture its settled screen at the same width, and run the existing dinner-choice, dinner-shopping, and hosted navigation regressions. The saved dinner, Shopping, and cooking captures cover 320 × 568, 390 × 844, and 1440 × 900 in both themes. Pantry comparison was inspected at 390 × 844 and 1440 × 900. The screenshots and geometry are local ignored artifacts. Physical-device and screen-reader checks remain release verification tasks. [Interaction captures and measurements](../output/playwright/e2e-2026-11-18T11-24-54-968Z-44739/) · [Pantry comparison evidence](../output/playwright/discovery-audit-2026-11-18/)

</details>

## Completed October review

F1–F9 and the dark-mode toggle were delivered in October. The dated findings and test counts below document that release.

<details>
<summary>October 25 findings, acceptance criteria, and implementation record</summary>


Reviewed October 25, 2026, against the current working tree, including the recent usability changes. This is a browser-tested review. No application code was changed during this review.

Start with save reliability, the dinner picker’s default date, and visible removal recovery. The main journey works, but these three issues can undermine confidence even while the existing regression suite passes.

## What was tested

| Coverage | Result |
| --- | --- |
| Existing desktop/mobile Playwright suite, freshly executed | **94 passed**, zero failed, skipped, or flaky; about 84 seconds |
| Manual review with realistic data | Disposable copy of the local **166-recipe catalog**, reset to an empty test kitchen |
| Desktop | Chromium, 1440 × 900; Plan, Pantry, Recipes, Settings, Shopping, recipe drawer |
| Mobile layouts | Chromium, 390 × 844 and 320 × 740; responsive layout testing, not physical-device testing |
| Main journey | Preferences → paste 18 pantry ingredients → choose dinner → shopping → eight cooking steps → completion with stock deduction → undo cooked |
| Interaction and recovery | Character-by-character chip entry, editing/removal, duplicate import validation, preview cancellation, Shift+Tab containment, Escape, focus restoration, timer presets/pause/custom validation/completion, Chef cancellation and API error/retry |
| Horizontal layout | No page overflow or right-clipped form controls found in Plan, Recipes, Shopping, Pantry, or Settings at 320 px; no page overflow in the four desktop navigation views; cooking also had no horizontal overflow at 320 px |

The original local database’s SHA-256 was checked before and after testing and was unchanged. The manual copy used a deterministic local model stub; this review does **not** assess real Ollama/OpenAI answer quality. The automated suite used its separate synthetic fixtures. Safari, physical touch behavior, screen-reader output, browser zoom, and a formal accessibility audit were not tested.

Local screenshots are in [the evidence folder](../output/playwright/ui-review-2026-10-25/). The fresh regression result is [results.json](../output/playwright/e2e-2026-10-25T11-38-35-646Z/results.json). These generated artifacts are intentionally ignored by Git.

## Priorities

P1 means fix before further feature work. P2 means address in the next usability pass. The layout and ranking items are recommendations based on observed friction, rather than broken functionality.

| ID | Priority | Finding | Proposed improvement |
| --- | --- | --- | --- |
| F1 | P1 | Invalid pantry amounts fail the entire kitchen save; quantity editing is inconsistent | Separate editable drafts from validated kitchen state and show errors beside the field |
| F2 | P1 | Adding a recipe defaults to a past Monday | Default to an available date on or after today within the viewed week |
| F3 | P1 | Undo is far below the removed item in a populated pantry | Show persistent, visible recovery above the mobile navigation |
| F4 | P2 | Removing a chip during editing commits the edit without removing it | Make edit/blur/remove behavior deterministic with stable chip identity |
| F5 | P2 | Today’s dinner is buried below past days and onboarding | Compact onboarding, expose today immediately, and reveal the newly saved dinner |
| F6 | P2 | Allergies are buried in Settings; several controls are small | Put cooking preferences first and enlarge frequent touch controls |
| F7 | P2 | Large pantry previews hide Confirm and Cancel below many rows | Keep preview actions visible while rows scroll |
| F8 | P2 | Instant dinner suggestions favor sides over eligible reviewed mains | Prefer reviewed core dinners for broad dinner suggestions |
| F9 | P2 | A Chef API error clears otherwise available recipe suggestions | Keep safe local picks visible with an explicit error and retry action |

## Reproduction and acceptance criteria

### F1 — Validate edits before they enter saved kitchen state

**Observed:** In Pantry, changing rice to `-2 g` produced “Save failed” and the alert `state.pantry[17].measure contains an invalid quantity`. The row simultaneously said the value was kept as a note. This invalid row prevented the whole kitchen document from saving. Replacing it with `300 g` restored saving.

Separately, clearing the planned dinner’s servings field immediately restored `4`, preventing ordinary empty-then-type editing. Typing `101` was accepted despite the input advertising a maximum of 100; it did not produce an error in this test. These are separate symptoms of inconsistent draft/range handling.

**Implementation:** Keep field drafts locally, validate before committing, and mark invalid drafts as unsaved beside the field. Allow ordinary intermediate input states. Use a shared amount validator and consistent product limits. Preserve valid free-text amounts such as “to taste”; do not silently turn an invalid number into stock.

**Acceptance:** Negative amounts and invalid fractions show a readable row error without placing invalid data in kitchen state. Other valid edits still save. Correction clears the error. Servings can be cleared and replaced using the keyboard, with chosen bounds enforced consistently. No internal state paths appear in user-facing errors.

**Scope:** [Pantry fields](../app/components/RagChefApp.tsx#L1144), [servings fields](../app/components/WeeklyKitchenViews.tsx#L91), amount validation and kitchen persistence. [Screenshot](../output/playwright/ui-review-2026-10-25/07-invalid-pantry-mobile.png).

### F2 — Default the dinner picker to a useful date

**Observed:** On Sunday, October 25, browsing Recipes and choosing “Add to plan: Zucchini Pasta Bake” opened the picker with **Monday, October 19** selected. All dates were empty. Today had to be selected manually.

**Implementation:** For the current week, prefer today if available, then the next eligible empty day. For a future week, prefer its first eligible empty day. When no upcoming slot is available, explain that and request an explicit date. Historical weeks should remain manually editable. Keep locked/cooked protection and replacement confirmation.

**Acceptance:** A fixed-clock Sunday test never silently defaults to the previous Monday. Cover today occupied, future weeks, historical weeks, and a full week. A user-selected date always wins.

**Scope:** [PlanPicker](../app/components/WeeklyKitchenViews.tsx#L127). [Screenshot](../output/playwright/ui-review-2026-10-25/10-default-past-day-mobile.png).

### F3 — Put Undo where the action happened

**Observed:** With 18 pantry rows at 390 × 844, removing rice left the page at scroll position zero while Undo was approximately **2,301 px below the viewport top**. The removal was reversible, but the recovery control was invisible. Undo restored all 18 rows when reached.

**Implementation:** Show a persistent recovery bar above the bottom navigation, with the removed item and Undo. Provide access to earlier removals when several accumulate. Avoid moving keyboard focus merely to announce a removal.

**Acceptance:** Undo is visible immediately after removal from anywhere in a long pantry or plan. It does not overlap navigation or the focused field. Preserve the current safeguards: later edits survive, occupied dinner dates are not overwritten, and bulk removal retains locked/cooked dinners. Recovery remains available until dismissed or reload, unless durable recovery is added explicitly.

**Scope:** [Removal notifications](../app/components/RagChefApp.tsx#L780), shared notification styling. [Screenshot of the viewport after removal](../output/playwright/ui-review-2026-10-25/06-removed-pantry-mobile.png).

### F4 — Make chip removal independent of blur

**Observed twice:** Save `milk,peanut`; edit milk to soy without pressing Enter; click the edited chip’s ×. The click completed, but soy and peanut remained. Repeating with soy edited to milk also left both chips. Ordinary Enter-to-save followed by removal works.

**Implementation:** Use stable chip identity and handle removal so blur cannot replace/unmount the action’s target before removal runs. Define how a pending edit behaves when selecting another chip. Escape should cancel editing while retaining the saved exclusion.

**Acceptance:** One click removes the intended chip during editing. Test unchanged edits, changed edits, removing a different chip, Enter, Escape, and keyboard activation. Recheck that typing `milk,peanut` still creates two saved exclusions and that saved exclusions remain enforced.

**Scope:** [IngredientChips](../app/components/IngredientChips.tsx#L24). [Resulting chips after the failed removal](../output/playwright/ui-review-2026-10-25/15-chip-remove-after-edit.png).

### F5 — Make today visible on mobile

**Observed:** On the empty Sunday plan at 390 × 844, the first day began at approximately **807 px** and today’s card at **1,623 px**. After adding today’s dinner, its card still began at approximately **1,223 px**. The user sees several past days before reaching the dinner just saved. The new onboarding is useful but occupies most of the initial mobile screen.

**Implementation:** Make onboarding compact and expandable. Add an immediately available Today action or summary while preserving the chronological weekly grid. Reveal and announce the selected dinner after saving. Do not rely on “This week,” which is disabled when already viewing the current week.

**Acceptance:** At 390 × 844, the initial current-week screen exposes a direct action for today in both empty and populated states. Saving a dinner reveals its card. Older dates remain accessible; future-week actions continue to use the viewed week.

**Scope:** [Onboarding](../app/components/RagChefApp.tsx#L717), week navigation and selected-card scrolling. [Empty plan](../output/playwright/ui-review-2026-10-25/04-empty-plan-mobile.png).

### F6 — Put preferences ahead of maintenance controls

**Observed:** Settings opens with backup export/restore. At 390 × 844 the allergy label began approximately **1,160 px down**, after backup, diet, skill, budget, and equipment. Chip remove controls measured approximately **28 × 38 px** and Settings approximately **41 × 38 px**. These are measured usability observations, not a formal standards-compliance finding.

**Implementation:** Start Settings with allergies, diet, and equipment; move skill/budget and backup maintenance into secondary sections. Make the onboarding preferences link land at the relevant fields. Use a 44 × 44 px design target for frequent touch actions and preserve readable labels and visible focus.

**Acceptance:** The initial preferences screen exposes allergy entry without passing the backup section. Primary touch controls meet the chosen design target at 320 and 390 px without clipping. Keyboard order matches the visual order.

**Scope:** [Settings section order](../app/components/RagChefApp.tsx#L1209), chip and button styles. [Screenshot](../output/playwright/ui-review-2026-10-25/03-settings-mobile.png).

### F7 — Keep import actions visible in a long preview

**Observed:** An 18-row import produced a **758 px** tall panel with approximately **2,280 px** of scrollable content. Confirm began around **2,261 px** from the viewport top. Neither Confirm nor Cancel was visible while reviewing the initial rows.

**Implementation:** Keep a compact heading/count and action footer visible, with only the editable rows scrolling. Display validation near the affected row and a concise summary beside Confirm. Ensure the footer cannot cover the last row or focused input.

**Acceptance:** Confirm and Cancel stay visible for 1, 18, and 50 rows at both mobile widths. Invalid/duplicate entries disable confirmation with an understandable reason. Escape cancels, preserves the original draft, and returns focus to Add to pantry. These cancellation and keyboard behaviors already passed for the current short preview and must be retained.

**Scope:** [Pantry preview](../app/components/RagChefApp.tsx#L792), modal layout. [Screenshot](../output/playwright/ui-review-2026-10-25/05-pantry-preview-mobile.png).

### F8 — Lead broad dinner suggestions with reviewed mains

**Observed:** With 18 pantry ingredients, soy/peanut exclusions, no diet restriction, and default equipment, the three instant Pantry picks were **Boiled Potatoes, Baked Potato Halves, and Salad Shirazi**. An eligible reviewed core dinner, Zucchini Pasta Bake, was available in Recipes. The suggestions optimize ingredient coverage but are weak as a complete-dinner shortlist.

**Implementation:** For broad dinner suggestions, prioritize eligible reviewed core dinners, then dislikes and pantry usefulness. Preserve explicit searches for sides and exact recipe titles. Keep unknown amounts and dietary suitability visible; do not imply that matching ingredient names proves sufficient stock.

**Acceptance:** When suitable reviewed mains exist, the default dinner shortlist favors them. Explicit requests for potatoes or a salad still return relevant side dishes. Re-run allergy, equipment, named-recipe, and dislike-ordering checks.

**Scope:** [Instant-pick ranking](../app/components/RagChefApp.tsx#L368), existing reviewed dinner metadata. [Observed list in Recipes](../output/playwright/ui-review-2026-10-25/08-recipes-mobile.png); the same three titles appeared as Chef’s instant picks.

### F9 — Preserve useful local picks during a Chef API failure

**Observed:** A simulated `/api/chef` 503 showed the supplied error and cleared the recipe cards, despite a previously loaded catalog. The user could retry using Find my dinner; a subsequent eligible Boiled Potatoes request recovered one card. Cancellation also worked without showing the late result.

**Implementation:** Keep eligible local picks visible under a clearly labeled service error. Add a nearby Retry action retaining the request. Do not label these picks as generated answers or reuse stale results from a different profile/pantry context.

**Acceptance:** With the catalog loaded and Chef unavailable, browsing suggestions remain actionable. Retry recovers, cancellation stays responsive, late results stay suppressed, and changes to allergies/pantry invalidate incompatible suggestions.

**Scope:** Chef error handling and answer/list presentation. [Screenshot](../output/playwright/ui-review-2026-10-25/16-chef-api-error-desktop.png).

## Proposed implementation batches

| Batch | Scope | Verification before proceeding |
| --- | --- | --- |
| 1. Save reliability and editing | F1 and F4; separate reviewable changes for quantity drafts and chip identity/events | Real typing/click sequences, invalid-row isolation, correction/reload, exclusion enforcement |
| 2. Planning and recovery | F2 and F3 | Fixed-clock date scenarios; visible mobile Undo; repeated removal, occupied dates, bulk clear |
| 3. Mobile hierarchy | F5, F6, F7 | Screenshots and keyboard checks at 1440, 390, and 320 px; long previews; no overlap or horizontal clipping |
| 4. Dinner usefulness and failure recovery | F8 and F9 | Reviewed-main ordering; exact-title and safety regressions; API failure/retry/cancel |

Use the existing regression suite as the release gate and add focused behavioral cases for the confirmed defects when implementing. Visual sizing changes need screenshot review rather than tests that merely repeat CSS values.

Keep the existing cream/green visual direction, source attribution, typed pantry input, explicit substitutions, and deterministic exclusion rules. A later polish pass can simplify repeated card metadata, enlarge small secondary text, and add pantry search/sorting. Those are lower-priority design opportunities; no measured task-time benefit is claimed.

## Implementation record — October 25, 2026

| Item | Delivered |
| --- | --- |
| F1 | Shared amount validation and editable local drafts for pantry stock, servings, batches, original yields, and ingredient overrides. Invalid drafts show field errors; other valid edits continue saving. Escape restores the saved value. |
| F2 | Current/future weeks default to an upcoming empty day. Historical weeks and weeks without an upcoming empty day prompt for an explicit date. Existing replacement protections remain. |
| F3 | Persistent recovery bar above mobile navigation, with earlier removals available in a disclosure. Existing restore/occupied-date safeguards remain. |
| F4 | Stable chip identities and explicit edit/remove handling across pointer, blur, and keyboard actions. Empty commits retain the saved exclusion. |
| F5 | Compact expandable onboarding, an immediately actionable Today section, and focus/scroll to newly saved dinners. |
| F6 | Allergies lead Settings; backup and secondary preferences follow. Frequent touch controls have a 44 px minimum design target. |
| F7 | Fixed preview heading and action footer with scrolling ingredient rows, row validation, and preserved cancellation behavior. |
| F8 | Reviewed core dinners lead instant picks. With the same 18-item pantry, the real catalog shortlist began with Zucchini Pasta Bake, Chanterelle Goulash, and Basic Scrambled Eggs. |
| F9 | Chef API errors retain local picks and offer Retry Chef. Request parsing is shared by client and server so fallback picks retain saved and request-specific restrictions. |
| Dark mode | System preference by default; browser-persisted manual toggle in the app and cooking headers. Includes native controls, recipe drawers, previews, and recovery messages. Changing theme preserves cooking progress and timers. |

Verification: **165 source tests and 120 desktop/mobile browser tests passed**, plus TypeScript, ESLint, and isolated built-worker checks. The browser suite includes 26 new desktop/mobile cases covering the plan and theme preference. A focused 44-check cooking/usability run also passed during implementation.

Manual review used a disposable copy of the 166-recipe catalog. All five main views were captured in both themes at 320 × 740 and 1440 × 900, with no horizontal page overflow. Additional checks covered 390 × 844, an 18-row preview, visible Undo, and theme changes during a paused cooking timer. Physical devices, Safari, screen-reader output, and real model answer quality remain outside this verification.

Selected local evidence:

- [Light mobile plan](../output/playwright/ui-implementation/plan-mobile-light.png) and [dark mobile plan](../output/playwright/ui-implementation/plan-mobile-dark.png).
- [Long import preview](../output/playwright/ui-implementation/import-mobile-dark.png) and [visible Undo](../output/playwright/ui-implementation/undo-mobile-dark.png).
- [Dark desktop recipes](../output/playwright/ui-implementation/recipes-1440-dark.png) and [mobile preferences](../output/playwright/ui-implementation/settings-320-dark.png).
- [Cooking at 320 px](../output/playwright/ui-implementation/cooking-320-dark.png).
- [Final browser results](../output/playwright/e2e-2026-10-25T12-14-26-725Z/results.json).

</details>
