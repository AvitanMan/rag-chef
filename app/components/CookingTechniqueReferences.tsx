import type { CookingTechniqueGuide } from "@/app/lib/chef-context";

export function CookingTechniqueReferences({ guides }: { guides?: CookingTechniqueGuide[] }) {
  return guides?.map(guide => <section className="technique-reference" aria-label={`${guide.term} explained`} key={guide.term}>
    <h4>What {guide.term.toLowerCase()} means</h4>
    <p>{guide.explanation}</p>
    <p className="quantity-note">General technique reference; recipe-specific times and amounts still come from your recipe.</p>
    <a href={guide.sourceUrl} target="_blank" rel="noreferrer">{guide.sourceName} · {guide.term}</a>
    <a href={guide.licenseUrl} target="_blank" rel="noreferrer">CC BY-SA 4.0</a>
  </section>);
}
