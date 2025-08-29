/**
 * =================================================================================
 * All-in-One AI Gateway Worker (ESM Format for Cloudflare Pages)
 * =================================================================================
 *
 * This version uses the ES Modules (ESM) format for optimal compatibility with
 * Cloudflare Pages deployment.
 *
 * How to use: (No change in usage)
 * - GEMINI:   https://<your_pages_url>/gemini/...
 * - OPENAI:   https://<your_pages_url>/openai/...
 * - GROQ:     https://<your_pages_url>/groq/...
 * - CLAUDE:   https://<your_pages_url>/claude/...
 * =================================================================================
 */

// --- CONFIGURATION ---
const ROUTE_MAP = {
  "gemini": "generativelanguage.googleapis.com",
  "openai": "api.openai.com",
  "groq": "api.groq.com",
  "claude": "api.anthropic.com",
};

// --- WORKER LOGIC (Updated to ES Modules format) ---
export default {
  /**
   * The main entry point for the Worker.
   * @param {Request} request The incoming request.
   * @param {object} env Environment variables.
   * @param {object} ctx Execution context.
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    // The core request handling logic is moved into a separate function
    // for clarity, but it could also be placed directly here.
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
}
