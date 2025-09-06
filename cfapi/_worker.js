/**
 * =================================================================================
 * Unified AI Gateway Worker with Dual-Mode Routing & Universal Caching (v7.0)
 * =================================================================================
 *
 * This version implements a sophisticated routing and caching system based on user requirements.
 *
 * Key Features:
 * 1.  **Dual-Mode Routing**:
 *     - **Transparent Gateway**: Requests like `/gemini/...` are routed based on the URL path.
 *       Supports both regular API keys and Master Key rotation.
 *     - **Intelligent Gateway**: Requests to `/v1/chat/completions` are routed based on the
 *       `model` field in the JSON body (e.g., "openai/gpt-4o"). This mode REQUIRES the Master Key.
 *
 * 2.  **Universal Smart Caching**:
 *     - The caching mechanism is now universally API key-agnostic.
 *     - Two identical requests (same model, prompts, etc.) with DIFFERENT API keys WILL
 *       now result in a cache HIT, for both gateway modes. This significantly improves
 *       cache efficiency.
 *
 * 3.  **D1-Powered Rotation**: Continues to use D1 for robust, high-volume key rotation.
 *
 * No changes are required in the Cloudflare dashboard settings.
 * =================================================================================
 */

// --- CONFIGURATION ---
const ROUTE_MAP = {
  "cerebras": "api.cerebras.ai",
  "claude": "api.anthropic.com",
  "gemini": "generativelanguage.googleapis.com",
  "groq": "api.groq.com",
  "openai": "api.openai.com",
};

// --- CACHE CONFIGURATION ---
const CACHE_TTL_SECONDS = 30 * 60;
const NON_CACHEABLE_PATHS = ["/v1/images/generations"];
const NON_CACHEABLE_MODELS = ["dall-e", "vision", "image"];

// --- WORKER LOGIC ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const incomingApiKey = getApiKey(request);
    let service, model, requestBody, overrideApiKey = null;
    let isIntelligentGateway = false;

    // --- NEW: Dual-Mode Routing Logic ---
    if (url.pathname.startsWith('/v1/chat/completions')) {
      // --- Mode 1: Intelligent Gateway (based on request body) ---
      isIntelligentGateway = true;
      console.log("Intelligent Gateway mode activated.");

      if (!incomingApiKey || incomingApiKey !== env.MASTER_KEY) {
        return new Response(JSON.stringify({ error: { message: "This endpoint requires a valid Master Key." } }), { status: 401 });
      }

      try {
        requestBody = await request.clone().json();
        model = requestBody.model || '';
        const modelParts = model.split('/');
        if (modelParts.length < 2 || !ROUTE_MAP[modelParts[0]]) {
          return new Response(JSON.stringify({ error: { message: `Invalid model format. Expected 'provider/model_name', e.g., 'openai/gpt-4o'. Received: '${model}'` } }), { status: 400 });
        }
        service = modelParts[0];
        requestBody.model = modelParts.slice(1).join('/'); // Rewrite model name for upstream
      } catch (e) {
        return new Response(JSON.stringify({ error: { message: "Failed to parse JSON body or model field." } }), { status: 400 });
      }

    } else {
      // --- Mode 2: Transparent Gateway (based on URL path) ---
      console.log("Transparent Gateway mode activated.");
      const pathSegments = url.pathname.split('/').filter(Boolean);
      service = pathSegments[0] || 'unknown';
      try {
        const tempBody = await request.clone().json();
        model = tempBody.model || 'unknown';
      } catch (e) { model = 'unknown'; }
    }

    // --- Key Rotation Logic (applies if Master Key is used in either mode) ---
    if (env.MASTER_KEY && env.DB && incomingApiKey === env.MASTER_KEY) {
      console.log(`Master Key detected for service '${service}'. Attempting key rotation.`);
      try {
        overrideApiKey = await getRotatingKeyFromD1(service, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), { status: 400 });
      }
    }

    // --- NEW: Universal Smart Caching (always API key-agnostic) ---
    const isCacheable = isRequestCacheable(request, model);
    let cacheKey;
    if (isCacheable) {
      cacheKey = await generateContentBasedCacheKey(request, isIntelligentGateway ? JSON.stringify(requestBody) : null);
      const cache = caches.default;
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log("Cache HIT (Universal Smart Cache)");
        return new Response(cachedResponse.body, cachedResponse);
      }
      console.log("Cache MISS (Universal Smart Cache)");
    }

    // --- Main Request Handling ---
    try {
      const response = await handleRequest(request, service, overrideApiKey, isIntelligentGateway, requestBody);
      
      if (isCacheable && response.ok && cacheKey) {
        const responseToCache = response.clone();
        responseToCache.headers.set('Cache-Control', `max-age=${CACHE_TTL_SECONDS}`);
        ctx.waitUntil(caches.default.put(cacheKey, responseToCache));
        const responseWithHeader = new Response(response.body, response);
        responseWithHeader.headers.set('X-Cache-Status', 'MISS');
        return responseWithHeader;
      }
      return response;
    } catch (err) {
      return new Response(err.message || 'An unexpected error occurred.', { status: 500 });
    }
  }
};

/**
 * --- MODIFIED: Handles the request with logic for both gateway modes ---
 */
async function handleRequest(request, service, overrideApiKey, isIntelligentGateway, modifiedBody) {
  if (request.method === 'OPTIONS') return handleOptions();

  const url = new URL(request.url);
  const targetHost = ROUTE_MAP[service];
  if (!targetHost) return new Response(`Unknown service provider: "${service}".`, { status: 404 });

  url.hostname = targetHost;

  // Rewrite URL path based on gateway mode
  if (isIntelligentGateway) {
    url.pathname = '/v1/chat/completions'; // Standard path for this mode
  } else {
    url.pathname = url.pathname.substring(service.length + 1); // Transparent mode path slicing
  }

  const newHeaders = new Headers(request.headers);
  if (overrideApiKey) {
    if (service === 'gemini') {
      url.searchParams.set('key', overrideApiKey);
      newHeaders.delete('Authorization');
      newHeaders.delete('x-goog-api-key');
    } else {
      newHeaders.set('Authorization', `Bearer ${overrideApiKey}`);
    }
  }
  
  const body = isIntelligentGateway ? JSON.stringify(modifiedBody) : request.body;
  if(isIntelligentGateway) newHeaders.set('Content-Type', 'application/json');

  const proxyRequest = new Request(url.toString(), {
    method: request.method,
    headers: newHeaders,
    body: body,
    redirect: 'follow'
  });

  const upstreamResponse = await fetch(proxyRequest);
  return new Response(upstreamResponse.body, upstreamResponse);
}

/**
 * --- NEW: Universal Content-Based Cache Key Generator ---
 * This function creates a cache key based on the request content, deliberately
 * ignoring the API key to allow caching across different keys.
 */
async function generateContentBasedCacheKey(request, bodyOverride) {
  const body = bodyOverride ? bodyOverride : await request.clone().text();
  const dataToHash = request.url + request.method + body;
  const encoder = new TextEncoder();
  const data = encoder.encode(dataToHash);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(digest));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://cache.internal/${hashHex}`, { method: 'GET' });
}


// --- UNCHANGED HELPER FUNCTIONS ---

async function getRotatingKeyFromD1(service, env) {
  const secretName = `${service.toUpperCase()}_KEYS`;
  const keyJson = env[secretName];
  if (!keyJson) throw new Error(`Rotation failed: Secret ${secretName} not found.`);
  const keys = JSON.parse(keyJson);
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`Rotation failed: Secret ${secretName} is not a valid array.`);
  
  const statement = env.DB.prepare(`INSERT INTO rotation_state (service_name, next_index) VALUES (?1, 1) ON CONFLICT(service_name) DO UPDATE SET next_index = (next_index + 1) % ?2 RETURNING next_index;`).bind(service, keys.length);
  try {
    const { results } = await statement.all();
    const nextIndexRaw = results[0]?.next_index ?? 1;
    const currentIndex = (nextIndexRaw - 1 + keys.length) % keys.length;
    return keys[currentIndex];
  } catch (e) {
    throw new Error(`D1 Database Error: ${e.message}`);
  }
}

function getApiKey(request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7);
  const googHeader = request.headers.get('x-goog-api-key');
  if (googHeader) return googHeader;
  const url = new URL(request.url);
  if (url.searchParams.has('key')) return url.searchParams.get('key');
  return null;
}

function isRequestCacheable(request, model) {
  if (request.method !== 'POST') return false;
  const url = new URL(request.url);
  if (NON_CACHEABLE_PATHS.some(path => url.pathname.includes(path))) return false;
  const modelLower = model.toLowerCase();
  if (NON_CACHEABLE_MODELS.some(keyword => modelLower.includes(keyword))) return false;
  return true;
}

function handleOptions() {
  const response = new Response(null, { status: 204 });
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, openai-organization');
  return response;
}
