// Where to go after sign-in. Only the OAuth consent page on this origin is allowed (no open redirect).

/** `search` is location.search; returns path+query of a same-origin /oauth/authorize URL, else null. */
export function safeNext(search, origin) {
  const next = new URLSearchParams(search).get('next');
  if (!next) return null;
  let url;
  try { url = new URL(next, origin); } catch { return null; }
  if (url.origin !== origin || url.pathname !== '/oauth/authorize') return null;
  return url.pathname + url.search;
}
