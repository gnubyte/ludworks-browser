// Model Context Protocol (JSON-RPC 2.0) for the agent server: initialize, ping, tools/list, tools/call and
// cancellation. Transport-free (server.js speaks Streamable HTTP; the lwb CLI bridges stdio to it).
// No Electron here (unit-tested).

/** Newest first. A client asking for a newer dated revision gets it echoed: the methods used here have
 *  not changed since 2024-11-05. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

export function negotiateVersion(requested) {
  if (PROTOCOL_VERSIONS.includes(requested)) return requested;
  if (typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested > PROTOCOL_VERSIONS[0]) return requested;
  return PROTOCOL_VERSIONS[0];
}

export const ERR = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 });

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * @typedef {object} McpContext
 * @property {() => {serverInfo: any, instructions: string, tools: any[]}} catalog
 * @property {(params: any) => void} [onInitialize]   remembers clientInfo for the session
 * @property {(name: string, args: any, o: {signal: AbortSignal, requestId: any}) => Promise<{content: any[], isError?: boolean}>} callTool
 * @property {(name: string) => boolean} hasTool
 * @property {(requestId: any) => void} [cancel]      notifications/cancelled
 * @property {AbortSignal} [signal]                    the HTTP request went away
 */

/**
 * Handles one JSON-RPC message or a batch. Resolves to the response (object or array), or null when
 * nothing is to be sent back (notifications, client responses).
 * @param {any} message
 * @param {McpContext} ctx
 */
export async function handleMessage(message, ctx) {
  if (Array.isArray(message)) {
    if (!message.length) return rpcError(null, ERR.INVALID_REQUEST, 'empty batch');
    const out = (await Promise.all(message.map((m) => handleOne(m, ctx)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleOne(message, ctx);
}

async function handleOne(m, ctx) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcError(m && m.id, ERR.INVALID_REQUEST, 'not a JSON-RPC 2.0 message');
  const hasId = Object.hasOwn(m, 'id') && m.id !== null;
  if (typeof m.method !== 'string') return null; // a response from the client: we never ask it anything
  if (!hasId) {
    if (m.method === 'notifications/cancelled' && m.params && ctx.cancel) ctx.cancel(m.params.requestId);
    return null;
  }
  const id = m.id;
  const params = m.params && typeof m.params === 'object' ? m.params : {};
  try {
    switch (m.method) {
      case 'initialize': {
        if (ctx.onInitialize) ctx.onInitialize(params);
        const c = ctx.catalog();
        return rpcResult(id, {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: c.serverInfo,
          instructions: c.instructions,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: ctx.catalog().tools });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!ctx.hasTool(name)) return rpcError(id, ERR.INVALID_PARAMS, `Unknown tool: ${name || '(none)'}`);
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const result = await ctx.callTool(name, args, { signal: ctx.signal, requestId: id });
        return rpcResult(id, { content: result.content || [], isError: !!result.isError });
      }
      case 'resources/list':
        return rpcResult(id, { resources: [] });
      case 'resources/templates/list':
        return rpcResult(id, { resourceTemplates: [] });
      case 'prompts/list':
        return rpcResult(id, { prompts: [] });
      case 'logging/setLevel':
        return rpcResult(id, {});
      default:
        return rpcError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    }
  } catch (e) {
    return rpcError(id, ERR.INTERNAL, e && e.message ? e.message : String(e));
  }
}

/** True when the message (or batch) contains at least one request that expects an answer. */
export function expectsResponse(message) {
  const list = Array.isArray(message) ? message : [message];
  return list.some((m) => m && typeof m === 'object' && typeof m.method === 'string' && Object.hasOwn(m, 'id') && m.id !== null);
}

/** The clientInfo name of an initialize request, if this is one. */
export function initializeClientName(message) {
  const list = Array.isArray(message) ? message : [message];
  for (const m of list) {
    if (m && m.method === 'initialize' && m.params && m.params.clientInfo && typeof m.params.clientInfo.name === 'string') return m.params.clientInfo.name;
  }
  return null;
}
