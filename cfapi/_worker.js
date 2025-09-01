/**
 * =================================================================================
 * All-in-One AI Gateway Worker (ESM Format for Cloudflare Pages)
 * =================================================================================
 *
 * This version uses the ES Modules (ESM) format for optimal compatibility with
 * Cloudflare Pages deployment.
 *
 * ---------------------------------------------------------------------------------
 * SUPPORTED SERVICES & USAGE:
 * ---------------------------------------------------------------------------------
 *
 *  - CEREBRAS:
 *    - Route Key: /cerebras
 *    - Base URL: https://<your_pages_url>/cerebras
 *    - Auth: Use `Authorization: Bearer YOUR_CEREBRAS_API_KEY` header.
 *    - Example: `<your_pages_url>/cerebras/v1/chat/completions`
 *
 *  - GEMINI (Google):
 *    - Route Key: /gemini
 *    - Base URL: https://<your_pages_url>/gemini
 *    - Auth: Append `?key=YOUR_GEMINI_API_KEY` to your request URL.
 *    - Example: `<your_pages_url>/gemini/v1beta/models/gemini-pro:generateContent?key=...`
 *
 *  - OPENAI:
 *    - Route Key: /openai
 *    - Base URL: https://<your_pages_url>/openai
 *    - Auth: Use `Authorization: Bearer YOUR_OPENAI_API_KEY` header.
 *    - Example: `<your_pages_url>/openai/v1/chat/completions`
 *
 *  - GROQ:
 *    - Route Key: /groq
 *    - Base URL: https://<your_pages_url>/groq
 *    - Auth: Use `Authorization: Bearer YOUR_GROQ_API_KEY` header.
 *    - Example: `<your_pages_url>/groq/openai/v1/chat/completions`
 *
 *  - CLAUDE (Anthropic):
 *    - Route Key: /claude
 *    - Base URL: https://<your_pages_url>/claude
 *    - Auth: Use `x-api-key: YOUR_CLAUDE_API_KEY` header.
 *    - Required Header: `anthropic-version: 2023-06-01` (or newer).
 *    - Example: `<your_pages_url>/claude/v1/messages`
 *
 * =================================================================================
 */

// --- CONFIGURATION ---
// Add or modify API routes here.
const ROUTE_MAP = {
  "cerebras": "api.cerebras.ai",
  "claude": "api.anthropic.com",
  "gemini": "generativelganguage.googleapis.com",
  "groq": "api.groq.com",
  "openai": "api.openai.com",
};

// --- WORKER LOGIC (ES Modules format) ---
export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request);
  }
};

// --- CORE HANDLER (No changes needed inside this function) ---
async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  const url = new URL(request.url);
  const pathSegments = url.pathname.split('/').filter(Boolean);

  if (pathSegments.length < 1) {
    return new Response('Invalid request. Please use a path like /gemini/..., /openai/..., etc.', { status: 400 });
  }

  const routeKey = pathSegments[0];
  const targetHost = ROUTE_MAP[routeKey];

  if (!targetHost) {
    const availableRoutes = Object.keys(ROUTE_MAP).join(', ');
    return new Response(`Unknown API route: "${routeKey}". Available routes: ${availableRoutes}`, { status: 404 });
  }

  url.hostname = targetHost;
  url.pathname = '/' + pathSegments.slice(1).join('/');

  const proxyRequest = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow',
  });

  try {
    const response = await fetch(proxyRequest);
    const newResponse = new Response(response.body, response);
    applyCorsHeaders(newResponse);
    return newResponse;
  } catch (e) {
    return new Response('Failed to connect to the upstream API.', { status: 502 });
  }
}

// --- HELPER FUNCTIONS (No changes needed here) ---
function applyCorsHeaders(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', [
    'Content-Type', 'Authorization', 'x-api-key',
    'x-goog-api-key', 'anthropic-version', 'openai-organization'
  ].join(', '));
}

function handleOptions() {
  const response = new Response(null, { status: 204 });
  applyCorsHeaders(response);
  return response;
}```
