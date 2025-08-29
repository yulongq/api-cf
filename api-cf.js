/**
 * Welcome to your new Multi-API Proxy Worker!
 * 
 * This worker acts as a smart router. It inspects the first part of the URL path
 * to decide which backend API to forward the request to.
 * 
 * How to use:
 * - For Gemini:  https://<worker_url>/gemini/v1beta/models/...
 * - For Groq:    https://<worker_url>/groq/openai/v1/chat/completions
 * 
 * The client is still responsible for providing the API key in the request.
 */

// --- 路由配置 ---
// 在这里添加或修改你想要代理的API
// 格式: "路由关键字": "目标API的域名"
const ROUTE_MAP = {
  "gemini": "generativelanguage.googleapis.com",
  "groq": "api.groq.com",
  // 以后想加别的，就在这里加一行，例如:
  // "targon": "api.targon.com"
};

// Worker 的入口点
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

/**
 * 处理所有传入的请求
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleRequest(request) {
  // 处理浏览器的 CORS preflight OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  const url = new URL(request.url);
  
  // 从路径中提取路由关键字
  // 例如: /gemini/v1beta/models -> ["gemini", "v1beta", "models"]
  const pathSegments = url.pathname.split('/').filter(Boolean);
  
  if (pathSegments.length < 1) {
    return new Response('Invalid request. Please specify an API route, e.g., /gemini/... or /groq/...', { status: 400 });
  }

  const routeKey = pathSegments[0];
  const targetHost = ROUTE_MAP[routeKey];

  // 如果找不到对应的路由，返回错误
  if (!targetHost) {
    return new Response(`Unknown API route key: "${routeKey}". Available routes: ${Object.keys(ROUTE_MAP).join(', ')}`, { status: 404 });
  }

  // --- 核心路由逻辑 ---
  // 1. 设置目标域名
  url.hostname = targetHost;

  // 2. 从路径中移除我们的路由关键字 (e.g., /gemini/v1beta... -> /v1beta...)
  url.pathname = '/' + pathSegments.slice(1).join('/');

  // 创建并转发请求
  const proxyRequest = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow'
  });

  try {
    const response = await fetch(proxyRequest);
    const newResponse = new Response(response.body, response);

    // 设置通用的CORS响应头
    setCorsHeaders(newResponse);

    return newResponse;

  } catch (e) {
    return new Response('Failed to connect to the upstream API.', { status: 502 });
  }
}

/**
 * 设置 CORS 响应头
 * @param {Response} response
 */
function setCorsHeaders(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, PUT, DELETE');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key, x-api-key'); // 添加了更多常见的key
}

/**
 * 处理 OPTIONS 请求的辅助函数
 * @returns {Response}
 */
function handleOptions() {
  const response = new Response(null, { status: 204 }); // 204 No Content is standard for preflights
  setCorsHeaders(response);
  return response;
}
