# Pantry semantics — implemented stages 1–3

[Operating guide](guide.md) · [Evaluation](evaluation.md)

## Scope and status

This documents the implemented pantry plan stages 1–3 in the `main` working tree
inspected on November 8, 2026: shared amount/eligibility rules, batch-preserving
entry and editing, the new `PantryView`, and their shopping, Chef, and recovery
integrations. At inspection, `main`/`origin/main` pointed to `f409739`; the pantry
implementation was present as uncommitted changes, not in that committed HEAD.
This is a behavioral contract, not a release or test-completion report.

Stage 4 remains deferred. PR7 is a separate open branch, not merged into `main`;
its overlapping work is called out below rather than documented as available here.

## Stored batches and canonical identity

The kitchen remains `schemaVersion: 2`. A `PantryStock` still stores only `id`,
`name`, `measure`, and optional `useBy`. Existing `shoppingCycles`,
`shoppingPurchases`, and meal completion deductions retain their current shapes.
No new database migration, ingredient-alias change, or persisted grouping field
is introduced by these stages.

`groupPantryBatches` groups rows visually using the existing
`canonicalIngredient` key. It does not combine or replace stored rows: every
batch retains its ID, name, amount text, and date. For example, `rice`, `raw rice`,
and `uncooked rice` can share a group, while `cooked rice`, `rice noodles`, and
`rice vinegar` remain distinct. Correcting a name can move a batch to another
group without merging it into another batch or converting its amount.

Recipe pantry-name coverage now uses that same exact canonical identity. It no
longer strips accents as an extra inventory-matching step. The alias table and
reviewed preparation rules themselves are unchanged. Recipe and pantry **search**
remain case-, accent-, and punctuation-insensitive for discovery only:
`creme fraiche` can find `crème fraîche`, but those two spellings do not establish
a stock match. Equivalent Unicode spellings of the accented name still normalize.
A name match is not evidence of enough quantity.

## Amount certainty, units, and entered dates

`pantryAmountDetails` derives three states; none is a new stored field.

| State | Examples | Meaning |
| --- | --- | --- |
| Known positive amount | `500 g`, `1 l`, `2 cans` | Can cover a quantified requirement only with the same canonical ingredient and compatible units. |
| Unknown amount | Blank, `some`, `to taste`, `one bag` | May establish date-eligible name presence, but supplies no confirmed quantity, reservation, or deduction. It is neither zero nor unlimited. |
| Known zero / empty | `0`, `0 g`, `0 cans` | Excluded from available names and quantity coverage, but the batch remains stored and visible in All items. |

Compatible mass and volume units normalize within their own dimensions: `1 kg`
and `1000 g` agree, as do `1 cup` and `240 ml`. Cups use 240 ml, tablespoons
15 ml, and teaspoons 5 ml. Mass is not converted to volume. Typed counts remain
separate: cans, jars, packets, bottles, and generic pieces are not interchangeable.
A known can count does not imply the weight or volume inside a can. There is no
package-content or cooked-to-raw conversion.

Unknown dinner requirements do not consume stock, including unknown stock.
When a quantified requirement remains uncovered, matching unknown or
incompatible stock produces review explanations instead of invented coverage.
Those explanations accompany shopping calculations and dinner readiness. Extra
unknown stock does not turn an otherwise fully covered requirement into a gap.

`useBy` is an optional, inclusive **user-entered planning date**, not a food-safety
assessment, freshness rating, purchase date, or shelf-life prediction. Missing
means unknown. A batch is date-eligible on its entered date and excluded after
that date; the app neither extends the date nor declares the food safe/unsafe.
Past-dated stock remains part of physical on-hand totals until explicitly changed
or removed.

Planning checks the later of today and the dinner date, so an unfinished
historical dinner cannot make past-dated stock eligible again. Actual cooking
checks the cooking date, including when a future dinner is cooked early.

## Pantry browser: on hand versus reservations

The new [PantryView](../app/components/PantryView.tsx) replaces the inline pantry
view previously defined in `RagChefApp.tsx`. Each ingredient group shows:

- **Amount on hand:** physical quantities across all its batches, including
  past-dated stock. Compatible units total together; different dimensions stay
  separate, with an additional count of unknown-amount batches.
- **Reserved for selected week:** virtual allocations for saved, uncooked
  dinners in the selected week. Locked uncooked dinners still reserve stock;
  cooked dinners and other weeks do not.
- **Available today after reservations:** the remaining confirmed quantities,
  excluding batches past their entered date today. This is not a promise that
  the same food will be eligible on a future dinner date.

Reservations use the full pantry before filtering or searching. Dinners allocate
in date order, with eligible earlier-dated batches used first, so later dinners
do not spend the same quantity again. These calculations do not mutate physical
stock. Group totals still include hidden batches; the view explains when only
some of a group's batches are displayed.

Search, current/name/date sorting, and the **All items**, **Use soon**,
**Past entered date**, and **No date entered** filters change the view, not stock.
Counts are batch counts. Use soon includes today through three days ahead;
all three review filters exclude known zero amounts but can include unknown
amounts. Empty batches remain in All items. When Chef has neither due-soon nor
past-dated batches, its Use soon empty-state link opens No date entered, not a
claim that undated food needs no attention. Chef's pantry chips group ingredients
and open batch review instead of deleting stock.

## Adding ingredients without merging batches

The Pantry form and Chef quick-add use the same parsing and review path.
`rice: 300 g`, `300 g rice`, and `rice 300 g` are supported, with newline,
semicolon, and comma list separators. Recognized comma preparation clauses stay
attached to the ingredient rather than becoming separate stocks.

Only a bare new ingredient can bypass the preview. Multiple rows, entered
amounts/dates, ambiguous wording, and an existing canonical match require review,
even if the existing batch is empty or past-dated. Uncertain input such as
`1–2 cups rice`, `2 large onions`, or `1 (400 g) can tomatoes` retains its text
and a review reason instead of guessing an ingredient/quantity split. Review
metadata and original-input hints are preview-only, not stored batch fields.

The preview allows name, amount, and optional date edits and shows:

- Repeated canonical ingredients within the preview.
- Every matching existing batch with its own amount and date.
- **Confirm new batch** / **Confirm new batches** for duplicates: every confirmed
  row creates a distinct batch ID, without changing existing stock or merging dates.
- **Correct existing batch** when updating stock was intended. This closes the
  preview and focuses that saved row in Pantry; it does not add stock or transfer
  preview values. Use its inline fields or **Edit batch** to make the correction.

**Add another batch** pre-fills the ingredient for another entry, not a top-up of
an existing row. Confirmed additions are marked **Just added** and reachable via
**View added batches**. Invalid names, amounts, or dates prevent confirmation;
duplicate batches still count toward the existing 500-row pantry limit. Known
zero amounts are permitted for manual pantry records, unlike purchase additions.

## Inline edits and the batch editor

Inline amount/date fields hold a local draft. A valid change applies on **blur
or Enter**; Enter blurs the field. **Escape** restores the current saved value.
Invalid drafts stay visible with an error and **Restore current value**, without
saving malformed stock or blocking unrelated valid edits. Clearing a date makes
it unknown. The focused batch stays in view while its group has focus, so an
edit that changes sorting/filter membership does not immediately move the next
field away during keyboard navigation.

Both inline edits and **Edit batch** compare the current batch with the snapshot
being edited inside the functional kitchen update. A changed name, amount, date,
or ID, or a removed batch, blocks a stale replacement. The editor offers
**Load current batch** when it still exists; it never recreates a removed batch.

The editor previews one of three actions before confirmation:

| Action | Effect and boundary |
| --- | --- |
| **Correct batch** | Replaces this batch's recorded name/form, physical amount, or entered date while retaining its ID. It is a correction, not a cooking transformation or new purchase. |
| **Record usage** | Subtracts a known positive quantity in compatible units, no greater than physical on-hand stock. Unknown on-hand amounts must first be corrected or marked finished. Reservations recalculate; they are not subtracted twice. No dinner is marked cooked. |
| **Mark finished** | Sets the amount to zero while retaining the ID, name, and entered date in All items. It does not remove the batch or append a journal event. |

For example, with `500 g` on hand and `450 g` reserved, recording `100 g` used
leaves `400 g` physical stock, not a negative balance based on the `50 g`
unreserved estimate. Future planning reflects the resulting shortage.

**Remove** is separate and uses the existing session recovery-bar Undo. Batch
corrections, usage, and Mark finished do not gain a general journal or edit-undo
stack. Follow the kitchen save indicator for persistence/sync status after an
edit is applied.

## Purchases, new cycles, and guarded undo

A shopping check marks an item bought but does not add pantry stock. **Add bought
items to pantry** opens a review of actual purchased amounts and optional
per-batch **Use by** planning dates. Dates start unknown; they are not inherited
from existing batches. Incomplete/invalid dates and invalid amounts block
confirmation. A known zero purchase is rejected; blank or note-only amounts
remain valid but unquantified. A valid past date is accepted with an availability
warning.

**Confirm pantry additions** adds separate batches and a receipt containing
their original snapshots, including entered dates. Editing live stock later does
not rewrite those snapshots. Application is guarded by the shopping key and
purchase cycle as well as receipt/batch IDs; retries do not add the same purchase
twice, and a stale preview must be reviewed again.

For an item still on the current shopping list whose bought cycle already has a
receipt, two explicit controls start another cycle:

- **Need to buy again** makes it unchecked and returns it to To buy.
- **Record another purchase** keeps it bought with a new pending cycle. Use
  **Add bought items to pantry** to review and confirm the next separate batch;
  the repeat button itself does not add stock or open the purchase preview.

Unchecking and rechecking also creates a new cycle. These actions preserve older
receipts and batches and do not disturb unrelated pending purchases. The explicit
repeat action identifies the displayed receipt, cycle, shopping key, and batch;
a duplicate/stale click cannot advance a later cycle. If an ingredient is no
longer on the shopping list because it is covered, these row controls are not a
general reorder action from history.

**Pantry additions** lists the selected week's receipts, independently of changing
shopping totals. **Undo pantry additions** removes a receipt and its batches
only if **every** batch still matches the retained receipt:

- The batch ID, exact name, and entered date must be unchanged.
- Amount text may match exactly, or parse to the same normalized quantity, unit,
  and dimension. `1 kg` and `1000 g` are equivalent; `1000 ml` is not.
- Unknown amount notes must match verbatim; two unparseable notes are not equal
  just because both amounts are unknown.

Actual quantity changes, renaming, date changes, removed batches, or outstanding
consumption block the whole receipt's undo. Cooking followed by **Undo cooked**
can restore the original quantity with normalized formatting, making purchase
undo available again. This does not authorize undoing later substantive changes.
Purchase undo leaves shopping checks/cycles and unrelated stock alone; it is not
an append-only audit journal.

## Chef: cook now is not planned-week availability

With dinner/cooking kitchen context, the server uses the revision-checked saved
kitchen, not client-supplied pantry quantities. `chefPantryProjection` supplies
eligible **physical on-hand** amounts before reservations, preserving raw amount
notes. Zero and past-date batches are excluded using the relevant availability
date. A context warning explains how to interpret that list:

| Request purpose | Availability calculation |
| --- | --- |
| Planning | Uses the later of today and the target dinner date, after other uncooked dinners in the target week reserve stock. The saved dinner being previewed is excluded from other reservations; a new preview can also exclude the unlocked planned target slot it would replace. |
| Cooking / cook now | Uses today's physical stock with no virtual reservations for other dinners, even for early or cross-week cooking. The calculation does not move the saved dinner, rescale it from preview inputs, or rewrite its final overrides or version hashes. |

Server readiness, not pantry names or `pantryMatch`, establishes measured
coverage. Partial quantities and review gaps are not full coverage; package
contents and unknown notes must not be converted into invented amounts. These
rules and the context warning are included for focused cooking questions too.
Asking Chef never deducts stock. Actual cooking completion remains a separate
reviewed action with optional deductions, using the actual cooking date.

Chef request validation supports the kitchen's 500 pantry rows and 200-character
names, plus 160-character quantity notes and 40-character unit strings. Over-limit
inputs are rejected rather than silently slicing the list at 120 rows or
truncating names/notes. This is an API validation change, not a kitchen schema
migration.

## History-aware recovery

`compareKitchens` adds two independent counts, shown in draft recovery and backup
restore previews:

- `shoppingCyclesChanged`: added, removed, or changed cycle entries, keyed by
  shopping key.
- `shoppingPurchasesChanged`: added, removed, or changed receipts, keyed by
  receipt ID. A changed nested batch/date/cycle counts once for that receipt;
  reordering the receipt array alone does not count as a change.

History-only differences are therefore visible even if pantry rows and shopping
checks are identical. Missing optional history and empty history are equivalent
for these counts, preserving older kitchens. Comparison does not mutate states,
regenerate IDs, or rebuild stock from receipts.

Restoring a backup replaces the current pantry, checks, and purchase history
with the backup's values together; it does not replay purchases into the current
pantry. The existing recoverable copy and revision safeguards still apply.
Receipt history supports repeat-cycle detection and purchase undo, not a full
record of every manual inventory edit.

## Compatibility and current PR7 overlap

For these pantry changes, kitchen schema **2**, backup export version **2**, and
the original/version-1 backup import support remain unchanged. Optional dates
and purchase history were already supported storage fields. Derived groups,
amount states, reservation balances, and review explanations are not persisted.
No new migration, data rewrite, new ingredient alias, or branch merge is required
for stages 1–3. Existing installation migrations mentioned in the operating guide
are separate from this change.

As checked on November 8, 2026,
[PR7 — Add reviewed kitchen workflows, browser login, and Figma-inspired UI](https://github.com/AvitanMan/rag-chef/pull/7)
was **OPEN**, with base `main`, head `codex/ux-browser-login`, and no merge date.
The inspected local/remote head was `337d560`. It includes earlier planning and
assistant branch work, but is not the implementation baseline for this document.

Integration requires deliberate reconciliation, not choosing one whole version
of an overlapping file:

- **Pantry/app UI:** PR7 changes `RagChefApp.tsx`, its still-inline `PantryView`,
  navigation, and styling. Preserve the extracted batch browser, full-pantry
  totals, explicit correction flow, and blur/Enter/Escape behavior when combining
  them with its redesign. `app/globals.css` and `docs/guide.md` also overlap.
- **Shopping:** both change `WeeklyKitchenViews.tsx` and `shopping-purchases.ts`.
  PR7 adds shopping-check Undo and a redesigned layout; this work adds explicit
  repeat cycles and quantity-equivalent purchase undo. Check Undo must not undo
  an already-applied purchase. `PurchasePreview.tsx` also overlaps: retain the
  new date validation alongside PR7's `randomId` compatibility helper.
- **Recovery:** PR7 adds base-aware drafts, reviewed recovery UI, and
  purchase-aware conflict merging in `kitchen-merge.ts`. The current main work
  adds history-difference counts, not that merge flow. Future integration must
  carry counts through the review and preserve selected live batch state with
  its receipt/cycle, without resurrecting consumed stock from receipt snapshots.
- **Chef:** `app/api/chef/route.ts`, `chef-context.ts`, and `chef-schema.ts` overlap
  provider/session work and compatible hashing in PR7. Preserve saved-kitchen
  authority, full pantry limits, raw notes, and the cook-now/planning distinction
  without dropping that branch's context/version safeguards.

PR7's assistant actions, shared-kitchen/login flows, additional providers, schema
extensions, database migrations, and redesigned recovery screens are **not**
claimed as stages 1–3 features on main. Keeping schema version 2 here is not a
promise that backups containing PR7-only optional fields are accepted by main's
strict validator. Cross-branch behavior and compatibility need validation after
integration; the PR's evidence cannot certify this combined working tree.

## Acceptance criteria and validation status

These are review criteria for the implemented behavior, **not checked-off test
results**. No full-suite, build, browser, or real-model sign-off is claimed by
this documentation update.

1. **Batch identity:** adding canonical duplicates yields distinct IDs and dates;
   grouping, searching, and sorting never merge or rewrite them. Cooked rice and
   unrelated rice products remain separate. Accent-insensitive search does not
   broaden canonical recipe coverage.
2. **Certainty and units:** known compatible amounts cover only their measured
   quantity; unknown amounts never reduce shopping; zero is excluded. Package
   counts do not satisfy mass, volume, or a different count type. Review notes
   stay attached to the correct ingredient.
3. **Dates:** an entered date is inclusive, blank is unknown, and past-dated
   stock remains physically on hand but unavailable. Future/historical planning
   and actual cooking use their respective dates without safety claims.
4. **Reservations and filters:** saved uncooked dinners reserve once, in the
   selected week, using the full pantry. Hiding an earlier batch does not shift
   its reservation to a visible one; displayed group totals explain hidden rows.
5. **Add preview:** ambiguous text is preserved for review. Duplicates show
   existing batches and explicit new-batch confirmation. Correct existing batch
   navigates without adding stock or silently applying preview fields. Invalid
   entries block confirmation, including when the 500-row limit would be exceeded.
6. **Inline editing:** typing alone leaves saved stock unchanged; blur/Enter
   commits valid edits; Escape restores the current value. Invalid drafts remain
   local, keyboard navigation stays usable through sorting/filter changes, and
   concurrent changes cannot be overwritten by a stale edit.
7. **Editor actions:** correction retains the ID; usage subtracts from physical
   stock only and rejects unknown, incompatible, zero, or excessive deductions;
   Mark finished retains a zero batch. None merges batches or marks dinner cooked.
   Removed or changed snapshots cannot be silently reapplied.
8. **Purchase dates:** optional dates are independently validated and retained
   in both the new batch and receipt. Existing batches are unchanged; past dates
   warn, invalid/incomplete dates block, and known zero purchases are rejected.
9. **Repeat purchases:** each explicit repeat or uncheck/recheck starts a new
   cycle without adding stock until confirmed. Retries, stale buttons/previews,
   and reused batch IDs cannot duplicate an applied cycle or disturb another
   pending purchase. Older receipts survive.
10. **Undo composition:** purchase → cook with deduction → Undo cooked → purchase
    undo works when stock returns to an equivalent quantity and original identity/
    date. Substantive edits or removal block the entire purchase undo; unknown
    notes require exact equality. Unrelated stock and later work are preserved.
11. **Chef context:** planning uses target-week reservations; cook now uses today's
    physical stock even across weeks. Saved dates, final amounts, and hashes stay
    unchanged. Up to 500 eligible rows reach the context without truncation;
    over-limit requests are rejected, and names/notes cannot establish measured
    sufficiency.
12. **Recovery and compatibility:** cycle-only and receipt-only differences yield
    nonzero counts, receipt reordering does not, and missing optional history is
    handled as empty. Backup/recovery retains original IDs and dates without
    replaying purchases, adding derived fields, or changing schema version 2.

### Implementation and regression-test map

The following modules and existing/new test files were inspected to ground this
contract. Test presence is not evidence that every test has passed.

| Area | Implementation | Regression tests |
| --- | --- | --- |
| Shared amounts, eligibility, identity and allocation | [quantities.ts](../app/lib/quantities.ts), [kitchen-stock.ts](../app/lib/kitchen-stock.ts), [recipe-browser.ts](../app/lib/recipe-browser.ts), [use-soon.ts](../app/lib/use-soon.ts) | [pantry-semantics](../tests/pantry-semantics.test.mjs), [quantities](../tests/quantities.test.mjs), [recipe-browser](../tests/recipe-browser.test.mjs), [recipe-presentation](../tests/recipe-presentation.test.mjs) |
| Grouped browser and guarded edits | [PantryView.tsx](../app/components/PantryView.tsx), [pantry-browser.ts](../app/lib/pantry-browser.ts), [RagChefApp.tsx](../app/components/RagChefApp.tsx), [UseSoon.tsx](../app/components/UseSoon.tsx) | [pantry-browser](../tests/pantry-browser.test.mjs) |
| Parsing and duplicate preview | [pantry-input.ts](../app/lib/pantry-input.ts), [PantryImportPreview.tsx](../app/components/PantryImportPreview.tsx) | [pantry-input](../tests/pantry-input.test.mjs) |
| Purchases and repeat cycles | [shopping-purchases.ts](../app/lib/shopping-purchases.ts), [PurchasePreview.tsx](../app/components/PurchasePreview.tsx), [WeeklyKitchenViews.tsx](../app/components/WeeklyKitchenViews.tsx) | [shopping-purchases](../tests/shopping-purchases.test.mjs) |
| Chef availability and limits | [chef-context.ts](../app/lib/chef-context.ts), [chef-schema.ts](../app/lib/chef-schema.ts), [Chef route](../app/api/chef/route.ts) | [chef-context](../tests/chef-context.test.mjs) |
| History differences | [kitchen-recovery.ts](../app/lib/kitchen-recovery.ts), [RagChefApp.tsx](../app/components/RagChefApp.tsx) | [kitchen-recovery](../tests/kitchen-recovery.test.mjs) |

The combined changes still need recorded validation against the criteria above,
including browser checks of native date inputs, blur/Enter/Escape, focus retention,
mobile layout, stale edits, and purchase/backup/recovery round trips. The normal
commands are in [Development and testing](guide.md#development-and-testing);
real-model evaluation remains separate. This docs-only update does not run those
application checks or claim that all tests are done.

## Deferred stage 4

Not implemented here: richer package metadata (such as package size/content or
opened state), barcode/product lookup, storage-location modeling, and a full
inventory journal for purchases, corrections, usage, and disposal. Existing
package-count units, purchase receipts, completion deductions, and the transient
removal Undo bar are not substitutes for those features. Any richer persisted
model needs its own design, compatibility review, and validation before it can
be documented as implemented.
