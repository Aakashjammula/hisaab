// MCP over Streamable HTTP, stateless: every POST carries a bearer token from our OAuth server and gets one
// JSON response (no sessions, no SSE). Platform-neutral like the rest of http/.
import { Hono, type Context } from 'hono';
import { AppError } from '../core/errors.ts';
import type { AppDeps } from './app.ts';
import { buildTools, serverInstructions } from './mcp-tools.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
/** Browser origins allowed to call /mcp besides our own (MCP asks servers to check Origin against DNS rebinding). */
const CLAUDE_ORIGINS = ['https://claude.ai', 'https://claude.com'];
const CALLS_PER_MINUTE = 120;

type Id = string | number | null;
interface RpcMessage { jsonrpc?: string; id?: Id; method?: unknown; params?: unknown }

const rpcResult = (c: Context, id: Id, result: unknown) => c.json({ jsonrpc: '2.0', id, result });
const rpcError = (c: Context, id: Id, code: number, message: string) => c.json({ jsonrpc: '2.0', id, error: { code, message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function mcpRoutes(d: AppDeps): Hono {
  const app = new Hono();
  const tools = buildTools(d);
  const byName = new Map(tools.map(t => [t.name, t]));
  const toolList = tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.on(['GET', 'DELETE'], '/', c => c.body(null, 405, { Allow: 'POST' }));

  app.post('/', async c => {
    const origin = new URL(c.req.url).origin;
    const from = c.req.header('origin');
    if (from && from !== origin && !CLAUDE_ORIGINS.includes(from)) return c.json({ error: 'Origin not allowed' }, 403);

    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const who = await d.oauth.authenticateBearer(token);
    if (!who) {
      c.header('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
      return c.json({ error: 'invalid_token' }, 401);
    }

    const wait = await d.limiter.hit(`mcp-user:${who.user.id}`, CALLS_PER_MINUTE, 60, new Date());
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json({ error: 'Too many requests' }, 429);
    }

    let msg: unknown;
    try { msg = await c.req.json(); } catch { return rpcError(c, null, -32700, 'Parse error'); }
    if (!isObject(msg)) return rpcError(c, null, -32600, 'Invalid request: send one JSON-RPC message per request');
    const m = msg as RpcMessage;
    // Notifications and responses to (non-existent) server requests: accepted, nothing to answer.
    if (m.id === undefined || m.method === undefined) return c.body(null, 202);
    const id = m.id;
    if (typeof m.method !== 'string') return rpcError(c, id, -32600, 'Invalid request');
    const params = isObject(m.params) ? m.params : {};

    switch (m.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return rpcResult(c, id, {
          protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hisaab', title: 'Hisaab', version: '1.0.0' },
          instructions: serverInstructions(d.timeZone),
        });
      }
      case 'ping':
        return rpcResult(c, id, {});
      case 'tools/list':
        return rpcResult(c, id, { tools: toolList });
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
        if (!tool) return rpcError(c, id, -32602, `Unknown tool: ${String(params.name)}`);
        try {
          const out = await tool.run(who.user, isObject(params.arguments) ? params.arguments : {});
          return rpcResult(c, id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
        } catch (err) {
          if (!(err instanceof AppError)) d.log?.(`MCP tool ${tool.name} failed`, err);
          const text = err instanceof AppError ? err.message : 'Something went wrong, try again';
          return rpcResult(c, id, { content: [{ type: 'text', text }], isError: true });
        }
      }
      default:
        return rpcError(c, id, -32601, `Method not found: ${m.method}`);
    }
  });

  return app;
}
