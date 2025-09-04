/**
 * =================================================================================
 * All-in-One AI Gateway Worker with Logging and Intelligent Caching (v4.1)
 * =================================================================================
 *
 * This version includes:
 * - Selective caching for text-based POST requests.
 * - Expanded non-cacheable list for image generation (OpenAI, Google).
 * - Guaranteed handling for OpenAI-compatible providers.
 * - Enhanced logging with cache status ('HIT', 'MISS', 'N/A').
 * - FIX: Corrected 'SHA-26' to 'SHA-256' in generateCacheKey function.
 *
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
const CACHE_TTL_SECONDS = 30 * 60; // 30 minutes

// List of URL paths that should NEVER be cached.
const NON_CACHEABLE_PATHS = [
    "/v1/images/generations", // OpenAI DALL-E Image Generation
];

// List of model name KEYWORDS that should NEVER be cached. Case-insensitive.
const NON_CACHEABLE_MODELS = [
    "dall-e",
    "vision",
    "image", // Catches gemini-2.0-flash-exp-image-generation
];

// --- WORKER LOGIC ---
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    
    // We need request data (like model) early for the caching decision.
    // Clone the request to read its body safely without consuming it.
    const requestClone = request.clone();
    const requestData = await extractRequestData(requestClone);
    
    // Make the caching decision based on both the request and its extracted data.
    const isCacheable = isRequestCacheable(request, requestData);
    
    let cacheKey;
    if (isCacheable) {
      cacheKey = await generateCacheKey(request); // Use original request for key
      const cache = caches.default;
      const cachedResponse = await cache.match(cacheKey);
      
      if (cachedResponse) {
        console.log("Cache HIT");
        const responseWithHeader = new Response(cachedResponse.body, cachedResponse);
        responseWithHeader.headers.set('X-Cache-Status', 'HIT');
        ctx.waitUntil(logRequest(env, requestData, responseWithHeader.clone(), startTime));
        return responseWithHeader;
      }
      console.log("Cache MISS");
    }

    // --- Cache MISS or Non-Cacheable Request ---
    let response;
    try {
      // Forward the ORIGINAL request which still has its body intact.
      response = await handleRequest(request, requestData.service);
      
      const clonedResponse = response.clone();
      
      if (isCacheable && response.ok && cacheKey) {
        const responseToCache = response.clone();
        responseToCache.headers.set('Cache-Control', `max-age=${CACHE_TTL_SECONDS}`);
        ctx.waitUntil(caches.default.put(cacheKey, responseToCache));
        clonedResponse.headers.set('X-Cache-Status', 'MISS');
      } else {
        clonedResponse.headers.set('X-Cache-Status', 'N/A');
      }
      
      ctx.waitUntil(logRequest(env, requestData, clonedResponse, startTime));
      return response;

    } catch (err) {
      response = new Response(err.message || 'An unexpected error occurred.', { status: 500 });
      response.headers.set('X-Cache-Status', 'N/A');
      ctx.waitUntil(logRequest(env, requestData, response.clone(), startTime, err));
      return response;
    }
  }
};

// --- CORE HANDLER (No changes needed) ---
async function handleRequest(request, service) {
  if (request.method === 'OPTIONS') return handleOptions();
  const url = new URL(request.url);
  const targetHost = ROUTE_MAP[service];
  if (!targetHost) {
    const availableRoutes = Object.keys(ROUTE_MAP).join(', ');
    return new Response(`Unknown API route: "${service}". Available routes: ${availableRoutes}`, { status: 404 });
  }
  url.hostname = targetHost;
  url.pathname = url.pathname.substring(service.length + 1);
  const proxyRequest = new Request(url.toString(), { method: request.method, headers: request.headers, body: request.body, redirect: 'follow' });
  const upstreamResponse = await fetch(proxyRequest);
  const newResponse = new Response(upstreamResponse.body, upstreamResponse);
  applyCorsHeaders(newResponse);
  return newResponse;
}

// --- LOGGING & DATA EXTRACTION (No changes needed) ---
async function extractRequestData(request) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const service = pathSegments[0] || 'unknown';
    let model = 'unknown';
    try {
        if (request.method === 'POST') {
            const body = await request.json();
            model = body.model || 'unknown';
        }
    } catch (e) {}
    if (service === 'gemini' && pathSegments[3]) {
        model = pathSegments[3].split(':')[0];
    }
    return { service, model };
}

async function logRequest(env, requestData, response, startTime, error) {
  if (!env.LOGS) return;
  const latencyMs = Date.now() - startTime;
  const cacheStatus = response.headers.get('X-Cache-Status') || 'N/A';
  const dataPoint = {
    blobs: [ requestData.service || "unknown", requestData.model || "unknown", error ? error.message : null, cacheStatus ],
    doubles: [ response.status, latencyMs ],
  };
  env.LOGS.writeDataPoint(dataPoint);
}

// --- UPDATED CACHING HELPERS ---

/**
 * Determines if a request is eligible for caching based on its method, 
 * path, and the model specified in its body.
 * @param {Request} request The incoming request.
 * @param {object} requestData The extracted data ({service, model}).
 * @returns {boolean} True if the request can be cached.
 */
function isRequestCacheable(request, requestData) {
  // 1. Only cache POST requests
  if (request.method !== 'POST') {
    return false;
  }
  
  // 2. Check against URL path blacklist
  const url = new URL(request.url);
  for (const path of NON_CACHEABLE_PATHS) {
    if (url.pathname.includes(path)) {
      return false;
    }
  }

  // 3. Check against model name keyword blacklist
  const modelLower = requestData.model.toLowerCase();
  for (const modelKeyword of NON_CACHEABLE_MODELS) {
    if (modelLower.includes(modelKeyword)) {
      return false;
    }
  }
  
  // If all checks pass, it's cacheable
  return true;
}

/**
 * Generates a unique cache key from the request's URL and body.
 */
async function generateCacheKey(request) {
  const requestClone = request.clone();
  const body = await requestClone.text();
  const dataToHash = request.url + body;
  const encoder = new TextEncoder();
  const data = encoder.encode(dataToHash);
  // FIX: Changed 'SHA-26' to 'SHA-256'
  const digest = await crypto.subtle.digest('SHA-256', data); 
  const hashArray = Array.from(new Uint8Array(digest));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(new URL(hashHex, request.url).toString(), {
    headers: request.headers,
    method: 'GET',
  });
}

// --- STANDARD HELPERS (No changes needed) ---
function applyCorsHeaders(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, openai-organization');
}

function handleOptions() {
  const response = new Response(null, { status: 204 });
  applyCorsHeaders(response);
  return response;
}
