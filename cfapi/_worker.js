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

// --- HELPER FUNCTIONS FOR API ROTATION ---

/**
 * 从请求中提取API密钥，根据不同服务商的格式
 * @param {Request} request - 传入的请求
 * @param {string} service - 服务提供商名称
 * @returns {string|null} 提取的API密钥
 */
function extractApiKey(request, service) {
  const authHeader = request.headers.get('Authorization');
  const xApiKeyHeader = request.headers.get('x-api-key');
  const xGoogApiKeyHeader = request.headers.get('x-goog-api-key');
  
  switch (service.toLowerCase()) {
    case 'gemini':
      // Gemini使用x-goog-api-key头
      return xGoogApiKeyHeader || null;
    case 'claude':
      // Claude使用x-api-key头
      return xApiKeyHeader || null;
    default:
      // 其他服务商使用Authorization头的Bearer格式
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
      }
      return null;
  }
}

/**
 * 从D1数据库获取下一个要使用的API密钥索引
 * @param {object} db - D1数据库实例
 * @param {string} service - 服务提供商名称
 * @param {number} keysCount - 可用密钥数量
 * @returns {Promise<number>} 下一个要使用的密钥索引
 */
async function getNextKeyIndex(db, service, keysCount) {
  if (!db) {
    throw new Error('D1数据库未配置');
  }
  
  try {
    // 表名常量，方便修改
    const ROTATION_STATE_TABLE = 'rotation_state'; // 用户可以根据实际数据库表名修改
    
    // 更新并获取下一个索引
    const statement = db.prepare(`
      INSERT INTO ${ROTATION_STATE_TABLE} (service_name, next_index, last_updated)
      VALUES (?1, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(service_name) DO UPDATE
      SET next_index = (next_index + 1) % ?2,
          last_updated = CURRENT_TIMESTAMP
      RETURNING next_index;
    `).bind(service, keysCount);
    
    const { results } = await statement.all();
    
    // 确保索引在有效范围内
    const nextIndex = results[0]?.next_index || 1;
    return (nextIndex - 1 + keysCount) % keysCount;
  } catch (e) {
    throw new Error(`D1数据库错误: ${e.message}`);
  }
}

// --- WORKER LOGIC (ES Modules format) ---
export default {
  /**
   * The main entry point for the Worker.
   * @param {Request} request The incoming request.
   * @param {object} env Environment variables, including the LOGS binding.
   * @param {object} ctx Execution context, used for ctx.waitUntil().
   * @returns {Promise<Response>}      */
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
        // URL格式错误，返回错误码325，且不记录到日志
        return new Response('url格式错误', { status: 325 });
      }

      // Clone the request to safely read the body
      const clonedRequest = request.clone();
      requestData = await extractRequestData(clonedRequest);

      // 处理API轮询逻辑
      response = await handleRequestWithRotation(request, requestData.service, env);
      
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
/**
 * 带轮询功能的请求处理函数
 * @param {Request} request - 传入的请求
 * @param {string} service - 服务提供商名称
 * @param {object} env - 环境变量，包含LOGS和DB绑定
 * @returns {Promise<Response>} 处理后的响应
 */
async function handleRequestWithRotation(request, service, env) {
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  const url = new URL(request.url);

  // 服务提供商已经在fetch函数中验证过，这里直接获取目标主机
  const targetHost = ROUTE_MAP[service];

  url.hostname = targetHost;
  url.pathname = url.pathname.substring(service.length + 1); // Removes /service prefix

  // 提取请求中的API密钥
  const requestApiKey = extractApiKey(request, service);
  
  // 获取MASTER_KEY和服务提供商的密钥配置
  const masterKey = env.MASTER_KEY;
  const serviceKeysEnv = env[`${service.toUpperCase()}_KEYS`];
  
  let proxyRequest = request;
  
  // 检查是否启用轮询模式
  if (masterKey && requestApiKey === masterKey) {
    // 启用轮询模式
    if (!serviceKeysEnv) {
      // 未配置轮询API密钥
      return new Response('未配置轮询api key', { status: 326 });
    }
    
    try {
      // 解析服务提供商的密钥列表
      const serviceKeys = JSON.parse(serviceKeysEnv);
      
      if (!Array.isArray(serviceKeys) || serviceKeys.length === 0) {
        return new Response('未配置轮询api key', { status: 326 });
      }
      
      // 从D1数据库获取下一个要使用的密钥索引
      const nextIndex = await getNextKeyIndex(env.DB, service, serviceKeys.length);
      const selectedKey = serviceKeys[nextIndex];
      
      // 根据不同服务商格式设置相应的请求头
      const headers = new Headers(request.headers);
      
      switch (service.toLowerCase()) {
        case 'gemini':
          headers.set('x-goog-api-key', selectedKey);
          break;
        case 'claude':
          headers.set('x-api-key', selectedKey);
          break;
        default:
          headers.set('Authorization', `Bearer ${selectedKey}`);
          break;
      }
      
      // 创建带有新头信息的代理请求
      proxyRequest = new Request(url.toString(), {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'follow',
      });
      
    } catch (e) {
      return new Response(`轮询配置错误: ${e.message}`, { status: 500 });
    }
  }
  
  // 对于非轮询模式，保持原有请求不变
  if (proxyRequest === request) {
    proxyRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
    });
  }
  
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
