/**
 * =================================================================================
 * All-in-One AI Gateway Worker
 * =================================================================================
 *
 * This Cloudflare Worker acts as a versatile, transparent proxy for multiple AI APIs.
 * It routes requests based on a URL prefix, allowing you to bypass regional blocks
 * and consolidate API access through a single endpoint.
 *
 * ---------------------------------------------------------------------------------
 * HOW TO USE:
 * ---------------------------------------------------------------------------------
 *
 * 1.  **Configure your client's Base URL** to point to this worker, followed by the
 *     route key for the desired service.
 * 2.  The client remains responsible for providing the API key.
 *
 * ---------------------------------------------------------------------------------
 * SUPPORTED SERVICES & USAGE:
 * ---------------------------------------------------------------------------------
 *
 *  - GEMINI (Google):
 *    - Route Key: /gemini
 *    - Base URL: https://<your_worker_url>/gemini
 *    - Auth: Append `?key=YOUR_GEMINI_API_KEY` to your request URL.
 *    - Example: `<worker_url>/gemini/v1beta/models/gemini-pro:generateContent?key=...`
 *
 *  - OPENAI:
 *    - Route Key: /openai
 *    - Base URL: https://<your_worker_url>/openai
 *    - Auth: Use `Authorization: Bearer YOUR_OPENAI_API_KEY` header.
 *    - Example: `<worker_url>/openai/v1/chat/completions`
 *
 *  - GROQ:
 *    - Route Key: /groq
 *    - Base URL: https://<your_worker_url>/groq
 *    - Auth: Use `Authorization: Bearer YOUR_GROQ_API_KEY` header.
 *    - Example: `<worker_url>/groq/openai/v1/chat/completions` (Groq uses an OpenAI-compatible path)
 *
 *  - CLAUDE (Anthropic):
 *    - Route Key: /claude
 *    - Base URL: https://<your_worker_url>/claude
 *    - Auth: Use `x-api-key: YOUR_CLAUDE_API_KEY` header.
 *    - Required Header: `anthropic-version: 2023-06-01` (or newer).
 *    - Example: `<worker_url>/claude/v1/messages`
 *
 * =================================================================================
 */

// --- CONFIGURATION ---
// Add or modify API routes here.
// Format: "route_key": "target_api_hostname"
const ROUTE_MAP = {
  "gemini": "generativelanguage.googleapis.com",
  "openai": "api.openai.com",
  "groq": "api.groq.com",
  "claude": "api.anthropic.com",
};

// --- WORKER LOGIC ---
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

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

  // --- Main routing logic ---
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
    // The `response.body` is a ReadableStream, which means this worker
    // inherently supports streaming responses from the API to the client.
    const newResponse = new Response(response.body, response);
    
    // Apply CORS headers to the final response.
    applyCorsHeaders(newResponse);
    
    return newResponse;

  } catch (e) {
    return new Response('Failed to connect to the upstream API.', { status: 502 });
  }
}

// --- HELPER FUNCTIONS ---

/**
 * Applies permissive CORS headers to a Response object.
 * @param {Response} response The response to modify.
 */
function applyCorsHeaders(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  
  // This header is crucial for allowing complex requests with custom headers.
  // We list common auth/control headers used by the supported APIs.
  response.headers.set('Access-Control-Allow-Headers', [
    'Content-Type',
    'Authorization',      // For OpenAI, Groq (Bearer token)
    'x-api-key',          // For Claude
    'x-goog-api-key',     // For Gemini (if sent as header)
    'anthropic-version',  // For Claude
    'openai-organization' // For OpenAI
  ].join(', '));
}

/**
 * Handles CORS preflight (OPTIONS) requests.
 * @returns {Response}
 */
function handleOptions() {
  const response = new Response(null, { status: 204 }); // 204 No Content
  applyCorsHeaders(response);
  return response;
}
