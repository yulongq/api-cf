/**
 * =================================================================================
 * Unified AI Gateway Worker with Enhanced Logging (v9.0)
 * =================================================================================
 *
 * New Features in this version:
 * 1.  **Refined Analytics Schema**:
 *     - `blob3` now stores `errorMessage`.
 *     - `blob4` now stores `cacheStatus`.
 * 2.  **Improved Cache Status Logging**: The `cacheStatus` field now uses more descriptive
 *     values: 'HIT', 'MISS', or 'N/A' (for non-cacheable requests).
 * 3.  **Structured Model Logging**: For Intelligent Gateway requests (e.g., model: "openai/gpt-4o"),
 *     the logs will correctly store 'openai' as the service and 'gpt-4o' as the model.
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
const CACHE_TTL_SECONDS = 30 * 60;
const NON_CACHEABLE_PATHS = ["/v1/images/generations"];
const NON_CACHEABLE_MODELS = ["dall-e", "vision", "image"];

// --- WORKER LOGIC ---
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    let response;
    // NEW: logService/logModel for dedicated logging, cacheStatus defaults to 'N/A'
    let service, model, requestBody, logService, logModel, cacheStatus = 'N/A', errorMessage = null;
    let isIntelligentGateway = false;

    try {
      const url = new URL(request.url);
      const incomingApiKey = getApiKey(request);
      let overrideApiKey = null;

      // --- Dual-Mode Routing ---
      if (url.pathname.startsWith('/v1/chat/completions')) {
        isIntelligentGateway = true;
        if (!incomingApiKey || incomingApiKey !== env.MASTER_KEY) {
          throw new ErrorResponse("This endpoint requires a valid Master Key.", 401);
        }
        requestBody = await request.clone().json();
        model = requestBody.model || '';
        const modelParts = model.split('/');
        if (modelParts.length < 2 || !ROUTE_MAP[modelParts[0]]) {
          throw new ErrorResponse(`Invalid model format. Expected 'provider/model_name', received: '${model}'`, 400);
        }
        service = modelParts[0];
        // NEW: Store separated parts for logging
        logService = service;
        logModel = modelParts.slice(1).join('/');
        requestBody.model = logModel; // Rewrite model name for upstream

      } else { // Transparent Gateway
        const pathSegments = url.pathname.split('/').filter(Boolean);
        service = pathSegments[0] || 'unknown';
        try {
          const tempBody = await request.clone().json();
          model = tempBody.model || 'unknown';
        } catch (e) { model = 'unknown'; }
        // NEW: Assign values for logging
        logService = service;
        logModel = model;
      }

      // --- Key Rotation ---
      if (env.MASTER_KEY && env.DB && incomingApiKey === env.MASTER_KEY) {
        overrideApiKey = await getRotatingKeyFromD1(service, env);
      }

      // --- Universal Caching ---
      const isCacheable = isRequestCacheable(request, logModel); // Use logModel for check
      if (isCacheable) {
        const cacheKey = await generateContentBasedCacheKey(request, isIntelligentGateway ? JSON.stringify(requestBody) : null);
        const cache = caches.default;
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          cacheStatus = 'HIT';
          response = new Response(cachedResponse.body, cachedResponse);
        } else {
          cacheStatus = 'MISS';
          response = await handleRequest(request, service, overrideApiKey, isIntelligentGateway, requestBody);
          if (response.ok) {
            const responseToCache = response.clone();
            responseToCache.headers.set('Cache-Control', `max-age=${CACHE_TTL_SECONDS}`);
            ctx.waitUntil(cache.put(cacheKey, responseToCache));
          }
        }
      } else {
        // cacheStatus remains 'N/A'
        response = await handleRequest(request, service, overrideApiKey, isIntelligentGateway, requestBody);
      }

    } catch (e) {
      errorMessage = e.message;
      const status = e instanceof ErrorResponse ? e.status : 500;
      response = new Response(JSON.stringify({ error: { message: errorMessage } }), { status });
      logService = service || "unknown";
      logModel = model || "unknown";
    } finally {
      // --- Asynchronous Analytics Logging ---
      const durationMs = Date.now() - startTime;
      const logData = {
        service: logService,
        model: logModel,
        cacheStatus,
        statusCode: response.status,
        durationMs,
        errorMessage,
      };
      ctx.waitUntil(logToAnalyticsEngine(env, logData));
    }

    return response;
  }
};

// --- NEW: Custom Error Class for better status code handling ---
class ErrorResponse extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * --- MODIFIED: Analytics Engine Logging Function ---
 * Swapped blob3 and blob4 to match new schema.
 */
async function logToAnalyticsEngine(env, data) {
  if (!env.LOGS) {
    console.log("Analytics Engine binding 'LOGS' not found. Skipping logging.");
    return;
  }

  env.LOGS.writeDataPoint({
    blobs: [
      data.service || "unknown",
      data.model || "unknown",
      data.errorMessage || "",       // MODIFIED: blob3 is now errorMessage
      data.cacheStatus || "unknown", // MODIFIED: blob4 is now cacheStatus
    ],
    doubles: [
      data.statusCode || 500,
      data.durationMs || 0,
    ],
    indexes: [
      data.service || "unknown",
    ],
  });
}

// --- UNCHANGED OR MINIMALLY CHANGED HELPER FUNCTIONS ---

async function handleRequest(request, service, overrideApiKey, isIntelligentGateway, modifiedBody) {
  if (request.method === 'OPTIONS') return handleOptions();

  const url = new URL(request.url);
  const targetHost = ROUTE_MAP[service];
  if (!targetHost) throw new ErrorResponse(`Unknown service provider: "${service}".`, 404);

  url.hostname = targetHost;
  url.pathname = isIntelligentGateway ? '/v1/chat/completions' : url.pathname.substring(service.length + 1);

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
  const response = new Response(upstreamResponse.body, upstreamResponse);
  applyCorsHeaders(response);
  return response;
}

function applyCorsHeaders(response) {
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, openai-organization');
}

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

async function getRotatingKeyFromD1(service, env) {
  const secretName = `${service.toUpperCase()}_KEYS`;
  const keyJson = env[secretName];
  if (!keyJson) throw new ErrorResponse(`Rotation failed: Secret ${secretName} not found.`, 500);
  const keys = JSON.parse(keyJson);
  if (!Array.isArray(keys) || keys.length === 0) throw new ErrorResponse(`Rotation failed: Secret ${secretName} is not a valid array.`, 500);

  const statement = env.DB.prepare(`INSERT INTO rotation_state (service_name, next_index) VALUES (?1, 1) ON CONFLICT(service_name) DO UPDATE SET next_index = (next_index + 1) % ?2 RETURNING next_index;`).bind(service, keys.length);
  try {
    const { results } = await statement.all();
    const nextIndexRaw = results[0]?.next_index ?? 1;
    const currentIndex = (nextIndexRaw - 1 + keys.length) % keys.length;
    return keys[currentIndex];
  } catch (e) {
    throw new ErrorResponse(`D1 Database Error: ${e.message}`, 500);
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
  applyCorsHeaders(response);
  return response;
}
