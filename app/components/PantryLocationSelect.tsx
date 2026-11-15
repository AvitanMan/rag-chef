"use client";

import type { PantryLocation } from "../lib/kitchen-types";
import { PANTRY_LOCATIONS } from "../lib/pantry-location";

export function PantryLocationSelect({ value, onChange, label, disabled = false }: {
  value?: PantryLocation;
  onChange: (location: PantryLocation | undefined) => void;
  label: string;
  disabled?: boolean;
}) {
  return <label className="pantry-location-select">{label}<select value={value ?? ""} disabled={disabled}
    onChange={event => onChange(event.currentTarget.value ? event.currentTarget.value as PantryLocation : undefined)}>
    <option value="">Unsorted</option>
    {PANTRY_LOCATIONS.map(location => <option key={location.value} value={location.value}>{location.label}</option>)}
  </select></label>;
}
