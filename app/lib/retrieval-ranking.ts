/** Search-only forms. Never use these for stock, quantities, or exclusions. */
const FORMS: Record<string, string> = {
  mushrooms: "mushroom", tomatoes: "tomato", onions: "onion", eggs: "egg", lentils: "lentil", beans: "bean", chickpeas: "chickpea", garbanzo: "chickpea", garbanzos: "chickpea",
  potatoes: "potato", carrots: "carrot", crepes: "crepe", pancakes: "pancake", muffins: "muffin", omelette: "omelet", omelettes: "omelet", omelets: "omelet", curries: "curry", curried: "curry", creamy: "cream", noodles: "noodle",
};
const STOP = new Set("a an and are as at be by can could do does for from how i in is it of on or recipe source step that the this to what when which with would".split(" "));
export function retrievalTerms(text: string): string[] {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[-_]+/g, " ")
    .replace(/\brice(?: stick)? noodles?\b/g, "ricenoodle noodle").replace(/\bblack eyed peas?\b/g, "bean")
    .match(/[a-z0-9]+/g)?.map((word) => FORMS[word] ?? word) ?? [];
}
export type RetrievalDocument = { id: string; title: string; ingredients: string; other: string };
export function bm25Scores(documents: RetrievalDocument[], query: string): Map<string, number> {
  const terms = [...new Set(retrievalTerms(query).filter((word) => !STOP.has(word)))];
  const scores = new Map(documents.map((document) => [document.id, 0]));
  for (const [field, weight] of [["title", 3], ["ingredients", 2], ["other", 1]] as const) {
    const tokenized = documents.map((document) => retrievalTerms(document[field]));
    const average = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(documents.length, 1) || 1;
    for (const term of terms) {
      const frequency = tokenized.filter((tokens) => tokens.includes(term)).length;
      const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
      tokenized.forEach((tokens, index) => {
        const tf = tokens.filter((token) => token === term).length;
        if (!tf) return;
        const value = weight * idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * tokens.length / average));
        scores.set(documents[index].id, scores.get(documents[index].id)! + value);
      });
    }
  }
  return scores;
}
export function reciprocalRanks(rankings: string[][], limit = 20): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) [...new Set(ranking)].slice(0, limit).forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1)));
  return scores;
}
