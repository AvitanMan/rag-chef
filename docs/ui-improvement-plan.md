# UI review and improvement plan

**Implementation status:** F1–F9 are implemented, with a persistent dark mode toggle added. The original review is retained below; see the implementation record at the end for verification and screenshots.

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
