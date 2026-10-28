// Search engines and their suggestion endpoints (OpenSearch suggestion JSON: [query, [suggestions…]]).

export const ENGINES = Object.freeze({
  google: { name: 'Google', search: 'https://www.google.com/search?q={q}', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q={q}' },
  duckduckgo: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q={q}', suggest: 'https://duckduckgo.com/ac/?q={q}&type=list' },
  bing: { name: 'Bing', search: 'https://www.bing.com/search?q={q}', suggest: 'https://api.bing.com/osjson.aspx?query={q}' },
  brave: { name: 'Brave Search', search: 'https://search.brave.com/search?q={q}', suggest: 'https://search.brave.com/api/suggest?q={q}' },
  startpage: { name: 'Startpage', search: 'https://www.startpage.com/sp/search?query={q}', suggest: null },
  ecosia: { name: 'Ecosia', search: 'https://www.ecosia.org/search?q={q}', suggest: 'https://ac.ecosia.org/autocomplete?q={q}&type=list' },
  kagi: { name: 'Kagi', search: 'https://kagi.com/search?q={q}', suggest: 'https://kagi.com/api/autosuggest?q={q}' },
});

/**
 * @param {{searchEngine: string, customSearch?: {name: string, url: string}|null}} prefs
 * @returns {{id: string, name: string, search: string, suggest: string|null}}
 */
export function currentEngine(prefs) {
  if (prefs.searchEngine === 'custom' && prefs.customSearch && validTemplate(prefs.customSearch.url)) {
    return { id: 'custom', name: String(prefs.customSearch.name || 'Custom'), search: prefs.customSearch.url, suggest: null };
  }
  const e = ENGINES[prefs.searchEngine] || ENGINES.google;
  return { id: ENGINES[prefs.searchEngine] ? prefs.searchEngine : 'google', ...e };
}

/** A custom template must be an https URL containing {q} (or %s, OpenSearch-style). */
export function validTemplate(t) {
  if (typeof t !== 'string' || t.length > 2048) return false;
  const norm = t.replace('%s', '{q}');
  if (!norm.includes('{q}')) return false;
  try {
    const u = new URL(norm.replace('{q}', 'test'));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function searchUrl(engine, query) {
  return engine.search.replace('%s', '{q}').replace('{q}', encodeURIComponent(query));
}

/**
 * Fetch suggestions (best effort, 1.5 s budget, no cookies).
 * @param {{suggest: string|null}} engine
 * @param {string} query
 * @param {(url: string, init?: any) => Promise<Response>} fetchImpl
 * @returns {Promise<string[]>}
 */
export async function fetchSuggestions(engine, query, fetchImpl) {
  if (!engine.suggest || !query.trim() || query.length > 200) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetchImpl(engine.suggest.replace('{q}', encodeURIComponent(query)), { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return [];
    const text = await res.text();
    if (text.length > 64 * 1024) return [];
    const data = JSON.parse(text);
    const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return list.filter((s) => typeof s === 'string' && s.length <= 200).slice(0, 6);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
