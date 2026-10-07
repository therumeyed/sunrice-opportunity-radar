// Plain fetch() has no default timeout -- if a provider's API stalls mid-
// request (no response, connection just sits open), the await never
// resolves, no matter how tight a polling loop's own maxWaitMs budget is
// wrapped around it. Every outbound call in this codebase goes through this
// instead so a stalled connection fails fast and the existing retry/error
// handling actually gets a chance to run.
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
