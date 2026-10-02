// Fetch wrapper. When the Cloudflare Access session expires, API calls get redirected to the
// Access login page; with redirect:'manual' we see that as an opaque redirect and ask to sign in.

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let onSessionExpired = () => {};
export const setSessionExpiredHandler = fn => { onSessionExpired = fn; };

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      redirect: 'manual',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'You seem to be offline. Check your connection and try again.');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    onSessionExpired();
    throw new ApiError(401, 'Session expired. Sign in again.');
  }
  const data = (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  me: () => request('GET', '/api/me'),
  expenses: month => request('GET', `/api/expenses?month=${month}`),
  createExpense: body => request('POST', '/api/expenses', body),
  updateExpense: (id, body) => request('PUT', `/api/expenses/${id}`, body),
  deleteExpense: id => request('DELETE', `/api/expenses/${id}`),
  categories: () => request('GET', '/api/categories'),
  createCategory: body => request('POST', '/api/categories', body),
  updateCategory: (id, body) => request('PATCH', `/api/categories/${id}`, body),
  deleteCategory: id => request('DELETE', `/api/categories/${id}`),
  summary: period => request('GET', `/api/summary?${period.type}=${period.key}`),
  categorySummary: (id, period) => request('GET', `/api/categories/${id}/summary?${period.type}=${period.key}`),
};
