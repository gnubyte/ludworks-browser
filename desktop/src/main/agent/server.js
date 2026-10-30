// The agent server: HTTP on 127.0.0.1 only, for the lwb CLI / MCP bridge and MCP clients that speak
// Streamable HTTP. Every request needs the bearer token from <profile>/agent-endpoint.json. Requests
// that a web page could make are refused: any Origin header (browsers send one on cross-site POSTs),
// and a Host other than the loopback address (DNS rebinding). No Electron here (unit-tested).
//
//   GET  /v1/status   {ok, app, access}
//   GET  /v1/tools    {serverInfo, instructions, tools}
//   POST /v1/call     {tool, args} → {content, isError}
//   POST /mcp         MCP JSON-RPC (single or batch) → JSON, or 202 for notifications
//   DELETE /mcp       ends the caller's session

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ENDPOINT_FILE = 'agent-endpoint.json';
export const DEFAULT_PORT = 47821;
const MAX_BODY = 16 * 1024 * 1024;

/** An error with the HTTP status the caller gets (403 access refused, 404 unknown tool…). */
export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function newToken() {
  return randomBytes(32).toString('hex');
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Header values that end up in the UI and logs: short, printable. lwb sends UTF-8 (a folder named "Übung");
 *  Node hands header bytes over as latin1. */
export function cleanHeader(v, max = 100) {
  const raw = String((Array.isArray(v) ? v[0] : v) || '');
  const s = /[\u0080-ÿ]/.test(raw) ? Buffer.from(raw, 'latin1').toString('utf8') : raw;
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩�]/g, '').trim().slice(0, max);
}

/**
 * @typedef {{client: string, session: string, label: string, mcpSession: string}} Identity
 * @typedef {object} Handler
 * @property {() => any} status
 * @property {() => any} catalog
 * @property {(id: Identity, tool: string, args: any, signal: AbortSignal) => Promise<any>} call
 * @property {(id: Identity, message: any, signal: AbortSignal) => Promise<{response: any, sessionId?: string}>} mcp
 * @property {(id: Identity) => void} endSession
 */

export class AgentServer {
  /** @param {{token: string, handler: Handler, log?: any}} o */
  constructor({ token, handler, log = null }) {
    this.token = token;
    this.handler = handler;
    this.log = log;
    this.port = 0;
    this.server = http.createServer((req, res) => this.onRequest(req, res).catch((e) => this.fail(res, e)));
    this.server.keepAliveTimeout = 30_000;
    this.server.requestTimeout = 0; // tool calls may wait minutes (user approval, browser_wait_for)
    this.server.headersTimeout = 20_000;
  }

  /** Listens on the preferred port, else any free one. Resolves to the port. */
  listen(preferred = DEFAULT_PORT) {
    const tryPort = (port) =>
      new Promise((resolve, reject) => {
        const onErr = (e) => {
          this.server.off('listening', onOk);
          reject(e);
        };
        const onOk = () => {
          this.server.off('error', onErr);
          resolve(this.server.address().port);
        };
        this.server.once('error', onErr);
        this.server.once('listening', onOk);
        this.server.listen({ port, host: '127.0.0.1', exclusive: true });
      });
    return tryPort(preferred || 0)
      .catch((e) => {
        if (!preferred || (e.code !== 'EADDRINUSE' && e.code !== 'EACCES')) throw e;
        return tryPort(0);
      })
      .then((port) => {
        this.port = port;
        return port;
      });
  }

  close() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  allowedHost(host) {
    const h = String(host || '').toLowerCase();
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(h);
  }

  async onRequest(req, res) {
    if (!this.allowedHost(req.headers.host)) return this.send(res, 403, { error: 'Host not allowed.' });
    if (req.headers.origin !== undefined) return this.send(res, 403, { error: 'Requests from web pages are not accepted.' });
    const auth = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!auth || !sameToken(auth[1], this.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return this.send(res, 401, { error: 'Missing or wrong token (see agent-endpoint.json in the browser profile).' });
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = {
      client: cleanHeader(req.headers['x-lwb-client']),
      session: cleanHeader(req.headers['x-lwb-session'], 200),
      label: cleanHeader(req.headers['x-lwb-label']),
      mcpSession: cleanHeader(req.headers['mcp-session-id'], 200),
    };
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /v1/status':
        return this.send(res, 200, await this.handler.status());
      case 'GET /v1/tools':
        return this.send(res, 200, await this.handler.catalog());
      case 'POST /v1/call': {
        const body = await readJson(req);
        if (!body || typeof body.tool !== 'string') return this.send(res, 400, { error: 'Body must be {"tool": "...", "args": {...}}.' });
        const result = await this.handler.call(id, body.tool, body.args && typeof body.args === 'object' ? body.args : {}, ac.signal);
        return this.send(res, 200, result);
      }
      case 'POST /mcp': {
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          if (e instanceof HttpError && e.status === 400) return this.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          throw e;
        }
        const { response, sessionId } = await this.handler.mcp(id, body, ac.signal);
        if (sessionId) res.setHeader('Mcp-Session-Id', sessionId);
        if (response === null || response === undefined) {
          res.statusCode = 202;
          return res.end();
        }
        return this.send(res, 200, response);
      }
      case 'DELETE /mcp':
        await this.handler.endSession(id);
        res.statusCode = 204;
        return res.end();
      case 'GET /mcp':
        // No server-initiated stream: everything is request/response.
        res.setHeader('Allow', 'POST, DELETE');
        return this.send(res, 405, { error: 'Use POST.' });
      default:
        return this.send(res, 404, { error: `Not found: ${route}` });
    }
  }

  send(res, status, body) {
    if (res.headersSent || res.destroyed) return;
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  }

  fail(res, e) {
    if (e instanceof HttpError) return this.send(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
    if (this.log) this.log.warn('agent server error', { message: e && e.message });
    this.send(res, 500, { error: e && e.message ? e.message : 'Internal error' });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
        resolve(text.trim() ? JSON.parse(text) : null);
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------------------- discovery file
/** Writes <profile>/agent-endpoint.json atomically, readable by this user only. */
export function writeEndpoint(profileDir, data) {
  mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, ENDPOINT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...data }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Removes the discovery file if it is still ours. */
export function removeEndpoint(profileDir, port) {
  const file = path.join(profileDir, ENDPOINT_FILE);
  try {
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    if (port && cur.port !== port) return;
  } catch {
    /* missing or unreadable: remove anyway */
  }
  rmSync(file, { force: true });
}
