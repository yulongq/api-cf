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
// 使用const常量对象，键使用小写形式以避免后续toLowerCase调用
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
/**
 * 从请求中提取API密钥，根据不同服务商的格式
 * @param {Request} request - 传入的请求
 * @param {string} service - 服务提供商名称
 * @returns {string|null} 提取的API密钥
 */
function extractApiKey(request, service) {
  // 避免不必要的toLowerCase调用，因为服务名称已经在fetch中处理过
  switch (service) {
    case 'gemini':
      // Gemini使用x-goog-api-key头
      return request.headers.get('x-goog-api-key') || null;
    case 'claude':
      // Claude使用x-api-key头
      return request.headers.get('x-api-key') || null;
    default:
      // 其他服务商使用Authorization头的Bearer格式
      const authHeader = request.headers.get('Authorization');
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
    
    // 使用事务确保原子性，避免并发访问问题
    return await db.transaction(async (tx) => {
      // 更新并获取下一个索引
      const statement = tx.prepare(`
         INSERT INTO ${ROTATION_STATE_TABLE} (service_name, next_index)
         VALUES (?1, 1)
         ON CONFLICT(service_name) DO UPDATE
         SET next_index = (next_index + 1) % ?2
         RETURNING next_index;
       `).bind(service, keysCount);
      
      const { results } = await statement.all();
      
      // 确保索引在有效范围内
      const nextIndex = results[0]?.next_index || 1;
      return (nextIndex - 1 + keysCount) % keysCount;
    });
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

      // 提取服务名称（已验证为小写）
      const service = pathSegments[0];
      
      // 延迟克隆请求和解析数据，仅在必要时执行
      requestData = { service, model: 'unknown' };
      
      // 尝试提取模型信息，但不阻塞主要逻辑
      try {
        if (request.method === 'POST') {
          // 仅当需要记录模型信息时才克隆请求和解析body
          if (env.LOGS) {
            const clonedRequest = request.clone();
            const body = await clonedRequest.json().catch(() => ({}));
            requestData.model = body.model || 'unknown';
          }
        } else if (service === 'gemini' && pathSegments[3]) {
          // 对于Gemini的GET请求，从URL路径提取模型
          requestData.model = pathSegments[3].split(':')[0];
        }
      } catch (e) {
        // 忽略任何数据提取错误，继续处理请求
      }

      // 处理API轮询逻辑，并传递已解析的URL以避免重复创建
      response = await handleRequestWithRotation(request, service, env, url);
      
      // 仅当有LOGS绑定时才克隆响应和记录日志
      if (env.LOGS) {
        const clonedResponse = response.clone();
        ctx.waitUntil(logRequest(env, requestData, clonedResponse, startTime));
      }
      
      return response;

    } catch (err) {
      // 对于URL格式错误，我们已经在前面单独处理并返回，这里处理其他错误
      response = new Response(err.message || 'An unexpected error occurred.', { status: 500 });
      
      // 仅当有LOGS绑定时才记录错误日志
      if (env.LOGS) {
        ctx.waitUntil(logRequest(env, requestData, response, startTime, err));
      }

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
/**
 * 带轮询功能的请求处理函数
 * @param {Request} request - 传入的请求
 * @param {string} service - 服务提供商名称
 * @param {object} env - 环境变量，包含LOGS和DB绑定
 * @param {URL} url - 已解析的URL对象，避免重复创建
 * @returns {Promise<Response>} 处理后的响应
 */
async function handleRequestWithRotation(request, service, env, url) {
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  // 服务提供商已经在fetch函数中验证过，这里直接获取目标主机
  const targetHost = ROUTE_MAP[service];

  // 重用传入的URL对象，避免重复创建
  url.hostname = targetHost;
  url.pathname = url.pathname.substring(service.length + 1); // Removes /service prefix

  // 获取MASTER_KEY配置
  const masterKey = env.MASTER_KEY;
  
  // 只有在启用轮询模式时才提取API密钥和处理轮询逻辑
  if (masterKey) {
    const requestApiKey = extractApiKey(request, service);
    
    if (requestApiKey === masterKey) {
      // 启用轮询模式
      const serviceKeysEnv = env[`${service.toUpperCase()}_KEYS`];
      
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
        
        // 避免不必要的toLowerCase调用
        switch (service) {
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
        
        // 创建带有新头信息的代理请求并发送
        const proxyRequest = new Request(url.toString(), {
          method: request.method,
          headers: headers,
          body: request.body,
          redirect: 'follow',
        });
        
        const upstreamResponse = await fetch(proxyRequest);
        const newResponse = new Response(upstreamResponse.body, upstreamResponse);
        applyCorsHeaders(newResponse);
        return newResponse;
        
      } catch (e) {
        return new Response(`轮询配置错误: ${e.message}`, { status: 500 });
      }
    }
  }
  
  // 非轮询模式，直接创建请求并发送，避免额外的比较操作
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
 * Asynchronously logs data to the Analytics Engine.
 * @param {object} env - The environment object containing bindings.
 * @param {object} requestData - Data extracted from the request {service, model}.
 * @param {Response} response - The final response object.
 * @param {number} startTime - The timestamp when the request started.
 * @param {Error} [error] - An optional error object if the request failed.
 */
async function logRequest(env, requestData, response, startTime, error = null) {
  // 检查是否有LOGS绑定，避免不必要的计算
  if (!env.LOGS) {
    console.log("Analytics Engine binding 'LOGS' not found. Skipping logging.");
    return;
  }

  const latencyMs = Date.now() - startTime;
  const service = requestData.service || "unknown";
  const model = requestData.model || "unknown";

  try {
    // 准备日志数据点，只在有错误时添加错误信息
    const dataPoint = {
      // 按照要求配置数据点
      indexes: [
        service
      ],
      // 仅在有错误时添加错误信息
      blobs: error ? [
        service,
        model,
        error.message
      ] : [
        service,
        model,
        null
      ],
      doubles: [
        response.status,
        latencyMs
      ],
    };

    // Write the data point to the Analytics Engine
    env.LOGS.writeDataPoint(dataPoint);

  } catch (logError) {
    // 记录日志本身失败时，记录到控制台但不影响主流程
    console.error('Failed to log request:', logError);
  }
}


// --- HELPER FUNCTIONS ---
function applyCorsHeaders(response) {
  // 避免重复设置CORS头
  if (!response.headers.has('Access-Control-Allow-Origin')) {
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, openai-organization');
  }
}

function handleOptions() {
  // 直接创建带有CORS头的响应，避免额外的函数调用
  const response = new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, openai-organization'
    }
  });
  return response;
}
