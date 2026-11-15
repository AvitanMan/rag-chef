import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "pantry-location-navigation" });
after(() => sources.dispose());
const { PANTRY_LOCATIONS, normalizePantryLocation, withPantryLocation } = await sources.import("app/lib/pantry-location.ts");

test("legacy and malformed history choices fall back to All without guessing a food location", () => {
  const pantry = Object.freeze([Object.freeze({ id: "legacy", name: "rice", measure: "300 g" })]);
  for (const value of [undefined, null, "", "Fridge", "pantry", "shelf", "constructor", "__proto__", 0, [], {}, { value: "fridge" }]) {
    assert.equal(normalizePantryLocation(value, pantry), "all");
  }
  assert.equal(Object.hasOwn(pantry[0], "location"), false);
});

test("named location choices remain usable when empty or when all stock is currently unavailable", () => {
  const pantry = [{ id: "finished", name: "rice", measure: "0 g", location: "cupboard" },
    { id: "past", name: "milk", measure: "200 ml", location: "fridge", useBy: "2020-01-01" }];
  for (const { value } of PANTRY_LOCATIONS) {
    assert.equal(normalizePantryLocation(value, []), value);
    assert.equal(normalizePantryLocation(value, pantry), value);
  }
  assert.equal(normalizePantryLocation("all", []), "all");
});

test("Unsorted stays selectable for saved finished and past-date batches without changing them", () => {
  for (const stock of [{ id: "finished", name: "rice", measure: "0 g" },
    { id: "past", name: "milk", measure: "200 ml", useBy: "2020-01-01" }]) {
    const pantry = Object.freeze([Object.freeze(stock)]), before = structuredClone(pantry);
    assert.equal(normalizePantryLocation("unsorted", pantry), "unsorted");
    assert.deepEqual(pantry, before);
  }
});

test("moving or removing the last Unsorted batch normalizes its view choice to All", () => {
  const first = { id: "first", name: "rice", measure: "300 g" };
  const second = { id: "second", name: "milk", measure: "" };
  const firstMoved = withPantryLocation(first, "cupboard"), secondMoved = withPantryLocation(second, "fridge");
  assert.equal(normalizePantryLocation("unsorted", [firstMoved, second]), "unsorted");
  assert.equal(normalizePantryLocation("unsorted", [firstMoved, secondMoved]), "all");
  assert.equal(normalizePantryLocation("unsorted", [firstMoved]), "all");
  assert.equal(normalizePantryLocation("unsorted", []), "all");
  assert.equal(Object.hasOwn(first, "location"), false);
  assert.equal(Object.hasOwn(second, "location"), false);
});
