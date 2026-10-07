const crypto = require('crypto');

// Stable identity for a source_item independent of DB state -- combined with
// source_type as the dedupe key (see db.js source_items UNIQUE constraint).
// Prefer a real external id/url; fall back to hashing the visible content so
// sources with no stable id (e.g. a Trends snapshot) still dedupe sanely
// within the same day.
function contentHash(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex');
}

module.exports = { contentHash };
