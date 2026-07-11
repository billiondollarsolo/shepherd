#!/usr/bin/env node
/**
 * flock-mcp — a tiny, dependency-free MCP (Model Context Protocol) stdio server
 * that exposes Flock's agent-orchestration API as tools the host agent can
 * AUTO-DISCOVER and call. It is launched per session by the agent's MCP config
 * and authenticates with a separate, explicitly scoped orchestration credential:
 *
 *   FLOCK_HOOK_URL    http://<origin>/api/hooks/<callerId>  (origin + caller id)
 *   FLOCK_ORCHESTRATE_TOKEN  the optional per-session bearer capability
 *
 * Tools → endpoints (all project-scoped + capped server-side):
 *   flock_list_agents  → GET  /api/orchestrate/:caller/agents
 *   flock_spawn        → POST /api/orchestrate/:caller/spawn   {agentType}
 *   flock_send         → POST /api/orchestrate/:caller/send    {targetId,text}
 *   flock_wait         → GET  /api/orchestrate/:caller/wait/:target?status&timeoutMs
 *   flock_read_output  → GET  /api/orchestrate/:caller/read/:target?limit
 *   flock_kill         → POST /api/orchestrate/:caller/kill    {targetId}
 *   flock_restart      → POST /api/orchestrate/:caller/restart {targetId}
 *
 * MCP transport: newline-delimited JSON-RPC 2.0 over stdio.
 */
import readline from 'node:readline';

const ENV = (() => {
  const url = process.env.FLOCK_HOOK_URL || '';
  const m = url.match(/^(https?:\/\/[^/]+)\/api\/hooks\/([^/?]+)/);
  return {
    origin: m ? m[1] : '',
    callerId: m ? m[2] : '',
    token: process.env.FLOCK_ORCHESTRATE_TOKEN || '',
  };
})();

async function api(method, path, body) {
  const res = await fetch(ENV.origin + path, {
    method,
    headers: { authorization: `Bearer ${ENV.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return json;
}

const TOOLS = [
  {
    name: 'flock_list_agents',
    description:
      'List the other agents in this project — their id, type, live status, and latest message. Use this to see who is working on what.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flock_spawn',
    description:
      'Launch another agent in this project to work in parallel (returns its id). Then flock_wait for it to be idle, flock_send it a task, and flock_wait again.',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          description: 'claude-code | codex | gemini | grok | opencode | terminal',
        },
      },
      required: ['agentType'],
    },
  },
  {
    name: 'flock_send',
    description:
      'Send a task or reply (as terminal input) to another agent in this project. Wait until it is idle first.',
    inputSchema: {
      type: 'object',
      properties: { targetId: { type: 'string' }, text: { type: 'string' } },
      required: ['targetId', 'text'],
    },
  },
  {
    name: 'flock_wait',
    description:
      'Block until another agent reaches a status (idle | awaiting_input | done | error | running), then return. Use after spawn/send to coordinate.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        status: { type: 'string', description: 'default: idle' },
        timeoutMs: { type: 'number', description: 'default 30000, max 120000' },
      },
      required: ['targetId'],
    },
  },
  {
    name: 'flock_read_output',
    description:
      "Read another agent's recent output (its latest assistant messages, oldest→newest) so you can inspect what it produced before acting. Use after flock_wait.",
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        limit: { type: 'number', description: 'how many recent messages (default 10, max 50)' },
      },
      required: ['targetId'],
    },
  },
  {
    name: 'flock_kill',
    description:
      'Terminate another agent in this project (clean up a finished worker). Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { targetId: { type: 'string' } },
      required: ['targetId'],
    },
  },
  {
    name: 'flock_restart',
    description:
      'Restart another agent: terminate it and launch a fresh agent of the SAME type (returns the new id). Use when a worker is stuck or errored.',
    inputSchema: {
      type: 'object',
      properties: { targetId: { type: 'string' } },
      required: ['targetId'],
    },
  },
];

async function callTool(name, a) {
  const c = encodeURIComponent(ENV.callerId);
  switch (name) {
    case 'flock_list_agents':
      return (await api('GET', `/api/orchestrate/${c}/agents`)).agents;
    case 'flock_spawn':
      return api('POST', `/api/orchestrate/${c}/spawn`, { agentType: a.agentType });
    case 'flock_send':
      return api('POST', `/api/orchestrate/${c}/send`, { targetId: a.targetId, text: a.text });
    case 'flock_wait':
      return api(
        'GET',
        `/api/orchestrate/${c}/wait/${encodeURIComponent(a.targetId)}?status=${encodeURIComponent(a.status || 'idle')}&timeoutMs=${Number(a.timeoutMs) || 30000}`,
      );
    case 'flock_read_output':
      return (
        await api(
          'GET',
          `/api/orchestrate/${c}/read/${encodeURIComponent(a.targetId)}?limit=${Number(a.limit) || 10}`,
        )
      ).messages;
    case 'flock_kill':
      return api('POST', `/api/orchestrate/${c}/kill`, { targetId: a.targetId });
    case 'flock_restart':
      return api('POST', `/api/orchestrate/${c}/restart`, { targetId: a.targetId });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function reply(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === 'initialize') {
    return reply({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'flock', version: '0.1.0' },
      },
    });
  }
  if (method === 'notifications/initialized') return; // notification: no response
  if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    if (!ENV.origin || !ENV.callerId || !ENV.token) {
      return reply({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: 'flock orchestration unavailable (missing session env)' },
          ],
          isError: true,
        },
      });
    }
    try {
      const out = await callTool(params?.name, params?.arguments || {});
      return reply({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(out) }] },
      });
    } catch (e) {
      return reply({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `error: ${e?.message || String(e)}` }],
          isError: true,
        },
      });
    }
  }
  if (id != null)
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
