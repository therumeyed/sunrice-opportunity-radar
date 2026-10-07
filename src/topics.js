// Editable topic library. Each entry drives one DataForSEO Trends request
// and one round of social search per platform. `theme` values double as the
// Theme filter options in the UI.
//
// Biased toward short, broad terms rather than long specific phrases --
// Google Trends' related-queries feature is sensitive to phrase
// length/specificity, and a long compound phrase is much more likely to
// have thin or empty related-query data than the word it's built from.
// Themes chosen from SunRice's own real product categories (Everyday Rice,
// Healthy Rice Blends, Microwave Rice, Rice Snacks) and the cuisine
// categories their own site organizes recipe content around (curry night,
// Chinese/Indian/Korean recipes, sushi).
const TOPICS = [
  { theme: 'weeknight_dinners', label: 'Weeknight dinners', queries: ['fried rice', 'rice recipes', 'dinner ideas'] },
  { theme: 'curry_night', label: 'Curry night', queries: ['curry', 'basmati', 'biryani'] },
  { theme: 'healthy_eating', label: 'Healthy eating', queries: ['low gi', 'brown rice', 'protein snacks'] },
  { theme: 'lunchbox_snacks', label: 'Lunchbox & snacks', queries: ['rice cakes', 'kids snacks', 'lunchbox snacks'] },
  { theme: 'sushi_asian', label: 'Sushi & Asian cooking', queries: ['sushi', 'sushi rice', 'japanese food'] },
  { theme: 'seasonal', label: 'Seasonal occasions', queries: ['lunar new year', 'diwali', 'christmas', 'ramadan', 'australia day'] }
];

// Multicultural discovery is deliberately query-less: rice is a staple
// across far more cuisines than the themes above name explicitly, so this
// surfaces whatever related queries come up on their own rather than
// hard-coding assumptions, and flags every hit for human review before
// it's used for audience targeting. `requiresReview: true` is read by the
// report builder to force confidence down to 'early_signal' regardless of
// score.
const MULTICULTURAL_THEME = { theme: 'multicultural', label: 'Multicultural discovery', queries: [], requiresReview: true };

const ALL_TOPICS = [...TOPICS, MULTICULTURAL_THEME];

function allQueries() {
  return ALL_TOPICS.flatMap((t) => t.queries.map((q) => ({ theme: t.theme, query: q })));
}

function themeForQuery(query) {
  const hit = ALL_TOPICS.find((t) => t.queries.includes(query));
  return hit ? hit.theme : null;
}

module.exports = { TOPICS, MULTICULTURAL_THEME, ALL_TOPICS, allQueries, themeForQuery };
