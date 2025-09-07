# Analytics Engine 设置指南

本文档提供了配置 Cloudflare Analytics Engine 以支持 API 请求日志记录功能的说明。

## 1. 创建 Analytics Engine 数据集

首先，您需要在 Cloudflare 仪表板中创建一个 Analytics Engine 数据集：

1. 登录到 [Cloudflare 仪表板](https://dash.cloudflare.com/)
2. 导航到 **Analytics** > **Analytics Engine**
3. 点击 **Create Dataset** 按钮
4. 为数据集输入一个名称（例如：`ai_gateway_logs`）
5. 点击 **Create** 完成创建

## 2. 配置 wrangler.toml

确保您的 `wrangler.toml` 文件中已正确配置 Analytics Engine 数据集绑定：

```toml
[[analytics_engine_datasets]]
binding = "LOGS"                # 这是您代码中 `env.LOGS` 的名字，必须与要求一致
dataset = "ai_gateway_logs"     # 数据集的名称，与您在步骤1中创建的名称一致
```

## 3. 了解日志记录格式

在 `_worker.js` 文件中，日志记录功能会自动收集以下信息：

```javascript
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
```

## 4. 使用 Analytics Engine 查询日志

创建并绑定数据集后，您可以使用 Cloudflare 的 SQL 查询功能来分析日志数据：

1. 登录到 [Cloudflare 仪表板](https://dash.cloudflare.com/)
2. 导航到 **Analytics** > **Analytics Engine**
3. 选择您创建的数据集
4. 使用 SQL 查询编辑器编写查询，例如：

```sql
SELECT * FROM ai_gateway_logs
WHERE time > now() - 1d
ORDER BY time DESC
LIMIT 100;
```

## 5. 常见问题解决

如果遇到 Analytics Engine 相关错误，请检查以下几点：

1. 确保您的 Analytics Engine 数据集已正确创建
2. 确保 `wrangler.toml` 中的绑定名称和数据集名称与实际配置一致
3. 确保您的 Cloudflare 账户有足够的权限使用 Analytics Engine 服务
4. 免费账户有一定的日志容量限制，如果日志数据量超过限制，部分日志可能不会被记录

## 6. 禁用日志记录

如果您不想使用日志记录功能，只需确保 `wrangler.toml` 中没有 `[[analytics_engine_datasets]]` 配置，或注释掉相关配置。Worker 代码中已经包含了对 `LOGS` 绑定不存在时的处理逻辑，不会影响主要功能。
