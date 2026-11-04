import type { CSSProperties, ReactNode } from "react";

export type KitchenIconName = "plan" | "chef" | "recipes" | "shop" | "pantry" | "settings" | "arrow" | "leaf" | "logout" | "plate";

const paths: Record<KitchenIconName, ReactNode> = {
  plan: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 11h18M7 15h2m6 0h2M7 18h2" /></>,
  chef: <><path d="M8 17h8l1-7a4 4 0 0 0-2-7 4 4 0 0 0-6 0 4 4 0 0 0-2 7l1 7Zm0 0v4h8v-4M10 8v4m4-4v4" /></>,
  recipes: <><path d="M12 6C8 3 5 3 2 4v16c3-1 6-1 10 2 4-3 7-3 10-2V4c-3-1-6-1-10 2Zm0 0v16M5 8l4 1M5 12l4 1m6-4 4-1m-4 5 4-1" /></>,
  shop: <><path d="m3 8 2 13h14l2-13H3Zm5 0 4-6 4 6M8 12v5m4-5v5m4-5v5" /></>,
  pantry: <><path d="M5 5h14M6 2h12v3l2 4v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9l2-4Z" /><rect x="7" y="11" width="10" height="6" rx="2" /></>,
  settings: <><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 2h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-2H9Z" /><circle cx="11.5" cy="11" r="3" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  leaf: <><path d="M20 3C9 2 3 6 4 13c1 7 12 9 16-10ZM4 21c1-6 5-10 11-13" /></>,
  logout: <><path d="M9 3H4v18h5m5-14 5 5-5 5M8 12h11" /></>,
  plate: <><circle cx="13" cy="12" r="8" /><circle cx="13" cy="12" r="5" /><path d="M1 3v6m3-6v6M1 7h3M2.5 9v12" /></>,
};

export function KitchenIcon({ name, className = "", style }: { name: KitchenIconName; className?: string; style?: CSSProperties }) {
  return <svg className={`kitchen-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}>{paths[name]}</svg>;
}
