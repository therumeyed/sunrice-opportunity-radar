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
  // "curry" alone is ambiguous (Steph/Stephen/Seth/Dell Curry, NBA) --
  // `exclude` is read by apifySocial.js to reject a social match that also
  // contains one of these, rather than force bare substring-matching to
  // decide what "curry" means here.
  {
    theme: 'curry_night',
    label: 'Curry night',
    queries: ['curry', 'basmati', 'biryani'],
    exclude: ['steph curry', 'stephen curry', 'seth curry', 'dell curry', 'warriors', 'golden state', 'nba', 'basketball']
  },
  { theme: 'healthy_eating', label: 'Healthy eating', queries: ['low gi', 'brown rice', 'protein snacks'] },
  { theme: 'lunchbox_snacks', label: 'Lunchbox & snacks', queries: ['rice cakes', 'kids snacks', 'lunchbox snacks'] },
  { theme: 'sushi_asian', label: 'Sushi & Asian cooking', queries: ['sushi', 'sushi rice', 'japanese food'] },
  // Genuinely mainstream, fixed-date Australian occasions only -- a
  // shifting/non-Gregorian cultural or religious occasion belongs under
  // Multicultural discovery below, never here, because this theme can
  // auto-promote straight to a Create recommendation and those can't.
  { theme: 'seasonal', label: 'Seasonal occasions', queries: ['christmas', 'australia day'] }
];

// Lunar New Year, Diwali and Ramadan are real, recurring searches worth
// tracking, but their dates shift (and aren't Gregorian), and they're
// culturally-specific rather than mainstream-Australian -- exactly the
// content this theme exists to flag for human review rather than let
// auto-promote to a Create recommendation the way "seasonal" can.
// `requiresReview: true` is read by the report builder to force confidence
// down to 'early_signal' regardless of score, whatever surfaces here.
const MULTICULTURAL_THEME = {
  theme: 'multicultural',
  label: 'Multicultural discovery',
  queries: ['lunar new year', 'diwali', 'ramadan'],
  requiresReview: true
};

const ALL_TOPICS = [...TOPICS, MULTICULTURAL_THEME];

function allQueries() {
  return ALL_TOPICS.flatMap((t) => t.queries.map((q) => ({ theme: t.theme, query: q })));
}

function themeForQuery(query) {
  const hit = ALL_TOPICS.find((t) => t.queries.includes(query));
  return hit ? hit.theme : null;
}

function excludeForQuery(query) {
  const hit = ALL_TOPICS.find((t) => t.queries.includes(query));
  return hit?.exclude || [];
}

module.exports = { TOPICS, MULTICULTURAL_THEME, ALL_TOPICS, allQueries, themeForQuery, excludeForQuery };
