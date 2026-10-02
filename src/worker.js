import { requireSameOrigin, requireUser } from './auth.js';
import { HttpError, json } from './http.js';
import { createExpense, deleteExpense, listExpenses, updateExpense } from './routes/expenses.js';
import { createCategory, deleteCategory, listCategories, updateCategory } from './routes/categories.js';
import { categorySummary, summary } from './routes/summary.js';

// [method, pattern, handler(env, request, url, ...params)]
const routes = [
  ['GET', /^\/api\/expenses$/, (env, req, url) => listExpenses(env, url)],
  ['POST', /^\/api\/expenses$/, (env, req) => createExpense(env, req)],
  ['PUT', /^\/api\/expenses\/([^/]+)$/, (env, req, url, id) => updateExpense(env, req, id)],
  ['DELETE', /^\/api\/expenses\/([^/]+)$/, (env, req, url, id) => deleteExpense(env, id)],
  ['GET', /^\/api\/categories$/, env => listCategories(env)],
  ['POST', /^\/api\/categories$/, (env, req) => createCategory(env, req)],
  ['PATCH', /^\/api\/categories\/([^/]+)$/, (env, req, url, id) => updateCategory(env, req, id)],
  ['DELETE', /^\/api\/categories\/([^/]+)$/, (env, req, url, id) => deleteCategory(env, id)],
  ['GET', /^\/api\/categories\/([^/]+)\/summary$/, (env, req, url, id) => categorySummary(env, url, id)],
  ['GET', /^\/api\/summary$/, (env, req, url) => summary(env, url)],
  ['GET', /^\/api\/me$/, (env, req, url, user) => json(user)],
];

async function handleApi(request, env) {
  const url = new URL(request.url);
  const user = await requireUser(request, env);
  requireSameOrigin(request);

  let pathMatched = false;
  for (const [method, re, handler] of routes) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    return url.pathname === '/api/me' ? handler(env, request, url, user) : handler(env, request, url, ...m.slice(1));
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('Unhandled API error', err);
      return json({ error: 'Something went wrong, try again' }, 500);
    }
  },
};
