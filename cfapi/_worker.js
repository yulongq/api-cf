/**
 * =================================================================================
 * All-in-One AI Gateway Worker with Analytics Engine Logging
 * =================================================================================
 *
 * This version integrates with Cloudflare Analytics Engine to log key metrics
 * for every API request, providing powerful, free observability.
 *
 * It requires an Analytics Engine binding named `LOGS`.
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

// --- WORKER LOGIC (ES Modules format) ---
export default {
  /**
   * The main entry point for the Worker.
   * @param {Request} request The incoming request.
   * @param {object} env Environment variables, including the LOGS binding.
   * @param {object} ctx Execution context, used for ctx.waitUntil().
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    let response;
    let requestData = {};

    try {
      // 验证URL格式
      const url = new URL(request.url);
      
      // 解析路径段
      const pathSegments = url.pathname.split('/').filter(Boolean);
      
      // 检查是否有服务提供商部分，并且该提供商在ROUTE_MAP中配置
      if (pathSegments.length < 1 || !ROUTE_MAP[pathSegments[0]]) {
        // URL格式错误，返回错误码625，且不记录到日志
        return new Response('url格式错误', { status: 625 });
      }

      // Clone the request to safely read the body
      const clonedRequest = request.clone();
      requestData = await extractRequestData(clonedRequest);

      response = await handleRequest(request, requestData.service);
      
      // Clone the response to read status, etc., without consuming the body
      const clonedResponse = response.clone();
      
      // Asynchronously log the successful request
      ctx.waitUntil(logRequest(env, requestData, clonedResponse, startTime));
      
      return response;

    } catch (err) {
      // 对于URL格式错误，我们已经在前面单独处理并返回，这里处理其他错误
      // In case of other errors, create a synthetic error response
      response = new Response(err.message || 'An unexpected error occurred.', { status: 500 });
      
      // Asynchronously log the failed request
      ctx.waitUntil(logRequest(env, requestData, response, startTime, err));

      return response;
    }
  }
};

// --- CORE HANDLER ---
async function handleRequest(request, service) {
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  const url = new URL(request.url);

  // 服务提供商已经在fetch函数中验证过，这里直接获取目标主机
  const targetHost = ROUTE_MAP[service];

  url.hostname = targetHost;
  url.pathname = url.pathname.substring(service.length + 1); // Removes /service prefix

  const proxyRequest = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow',
  });

  const upstreamResponse = await fetch(proxyRequest);
  const newResponse = new Response(upstreamResponse.body, upstreamResponse);
  applyCorsHeaders(newResponse);
  return newResponse;
}

/**
 * Extracts key information from the incoming request.
 * @param {Request} request
 * @returns {Promise<object>}
 */
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
    } catch (e) {
        // Ignore if body is not JSON or empty
    }
    
    // For Gemini, model is in the URL, e.g., /gemini/v1beta/models/gemini-pro:generateContent
    if (service === 'gemini' && pathSegments[3]) {
        model = pathSegments[3].split(':')[0];
    }
    
    return { service, model };
}


/**
 * Asynchronously logs data to the Analytics Engine.
 * @param {object} env - The environment object containing bindings.
 * @param {object} requestData - Data extracted from the request {service, model}.
 * @param {Response} response - The final response object.
 * @param {number} startTime - The timestamp when the request started.
 * @param {Error} [error] - An optional error object if the request failed.
 */
async function logRequest(env, requestData, response, startTime, error) {
  // If the LOGS binding doesn't exist, do nothing.
  if (!env.LOGS) {
    console.log("Analytics Engine binding 'LOGS' not found. Skipping logging.");
    return;
  }

  const latencyMs = Date.now() - startTime;
  const service = requestData.service || "unknown";
  const model = requestData.model || "unknown";
  const errorMessage = error ? error.message : null;

  const dataPoint = {
    // 按照要求配置数据点
    // index1存储服务商
    indexes: [
      service
    ],
    // blob1存储使用服务商，blob2存储模型，blob3存储报错信息
    blobs: [
      service,      // blob1: 服务商
      model,        // blob2: 模型
      errorMessage  // blob3: 报错信息
    ],
    // double1存储状态码，double2存储耗时
    doubles: [
      response.status, // double1: HTTP状态码
      latencyMs        // double2: 耗时（毫秒）
    ],
  };

  // Write the data point to the Analytics Engine
  env.LOGS.writeDataPoint(dataPoint);
}


// --- HELPER FUNCTIONS ---
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
