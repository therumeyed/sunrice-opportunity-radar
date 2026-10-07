function matchesAny(text, phrases) {
  const t = (text || '').toLowerCase();
  return phrases.some((p) => t.includes(String(p).toLowerCase()));
}

module.exports = { matchesAny };
