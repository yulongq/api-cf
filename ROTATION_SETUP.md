# API密钥轮询功能配置指南

本文档提供了配置Cloudflare D1数据库、MASTER_KEY和各服务商API密钥以支持API密钥轮询功能的详细说明。

## 1. 表名配置

在 `_worker.js` 文件中，表名已设置为常量，您可以根据实际数据库中的表名进行修改：

```javascript
// 表名常量，方便修改
const ROTATION_STATE_TABLE = 'rotation_state'; // 用户可以根据实际数据库表名修改
```

默认表名为 `rotation_state`，您可以根据自己的需求修改这个值。

## 2. 创建表的 SQL 语句

您需要在 D1 数据库中创建相应的表。请使用以下 SQL 语句(可直接在仪表盘执行)：

```sql
CREATE TABLE IF NOT EXISTS rotation_state (
  service_name TEXT PRIMARY KEY,
  next_index INTEGER NOT NULL DEFAULT 1,
  last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## 3. 使用 Wrangler CLI 初始化数据库(可选)

如果您是首次设置数据库，可以使用 Wrangler CLI 执行上述 SQL 语句：

```bash
# 执行初始化 SQL 到远程数据库
npx wrangler d1 execute api-rotation-db --remote --command="CREATE TABLE IF NOT EXISTS rotation_state (service_name TEXT PRIMARY KEY, next_index INTEGER NOT NULL DEFAULT 1, last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);"

# 或执行初始化 SQL 到本地开发数据库
npx wrangler d1 execute api-rotation-db --local --command="CREATE TABLE IF NOT EXISTS rotation_state (service_name TEXT PRIMARY KEY, next_index INTEGER NOT NULL DEFAULT 1, last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);"
```

## 4. 配置 wrangler.toml

确保您的 `wrangler.toml` 文件中已正确配置 D1 数据库绑定：

```toml
[[d1_databases]]
binding = "DB"                  # 这是您代码中 `env.DB` 的名字，必须保持一致
database_name = "api-rotation-db" # 数据库的名称
database_id = "您的数据库ID"      # 您的数据库 ID
```

## 5. 配置 MASTER_KEY 主密钥

MASTER_KEY 是启用轮询模式的控制开关，用于验证请求是否使用轮询功能。

### 配置步骤

1. 在 Cloudflare Workers 仪表板中，进入您的 Worker 设置页面
2. 导航到 "变量" 或 "Secrets" 部分
3. 添加一个名为 `MASTER_KEY` 的变量密钥
4. 设置一个强密码作为其值，建议使用随机生成的长字符串以提高安全性

### 注意事项

- MASTER_KEY 是敏感信息，请妥善保管
- 所有使用轮询功能的请求必须使用 MASTER_KEY 作为其 API 密钥

## 6. 配置各服务商 API 密钥

为每个您想要使用轮询功能的服务提供商配置 API 密钥列表。

### 配置步骤

1. 在 Cloudflare Workers 仪表板中，进入您的 Worker 设置页面
2. 导航到 "变量" 或 "Secrets" 部分
3. 为想要使用轮询功能的服务提供商添加对应的密钥变量：
   - `GEMINI_KEYS`：用于 Gemini API 的密钥列表
   - `OPENAI_KEYS`：用于 OpenAI API 的密钥列表
   - `CLAUDE_KEYS`：用于 Claude API 的密钥列表
   - `GROQ_KEYS`：用于 Groq API 的密钥列表
   - `CEREBRAS_KEYS`：用于 Cerebras API 的密钥列表

### 密钥格式要求

每个服务商的密钥列表必须是有效的 JSON 数组格式，例如：

```json
["api_key_1", "api_key_2", "api_key_3"]
```

### 注意事项

- 严格遵循格式，任何不想使用轮询的服务商可以不配，但不能配置为空或者不完全
- 建议为每个服务提供商配置多个密钥以充分利用轮询功能
- 密钥是敏感信息，请妥善保管


## 7. 使用轮询功能

配置完成后，您可以通过以下方式使用轮询功能：

1. 将请求中的原始 API 密钥替换为您配置的 `MASTER_KEY`
2. 发送请求到 Worker，Worker 会自动使用轮询算法选择一个可用的 API 密钥
3. 系统会自动记录每个服务提供商的密钥使用状态，并在下次请求时使用下一个可用密钥

## 8. 常见问题解决

如果遇到数据库错误或轮询功能不工作，请检查以下几点：

1. 确保您的 D1 数据库已正确创建并绑定到 Worker
2. 确保表名在代码中和数据库中保持一致
3. 确保表结构包含必要的字段：`service_name`, `next_index`, `last_updated`
4. 确保 `service_name` 字段已设置为主键，以便 `ON CONFLICT` 子句正常工作
5. 确保已正确配置 `MASTER_KEY` 环境变量
6. 确保已为相应服务提供商配置了有效的密钥列表，且格式为 JSON 数组
7. 确保请求中使用的 API 密钥与配置的 `MASTER_KEY` 匹配

## 9. 测试数据库连接

您可以在 Worker 代码中添加简单的测试逻辑，以确保数据库连接正常工作：

```javascript
async function testDatabaseConnection(env) {
  if (!env.DB) {
    console.error('D1数据库未配置');
    return false;
  }
  
  try {
    const result = await env.DB.prepare('SELECT 1 as test').all();
    console.log('数据库连接成功:', result);
    return true;
  } catch (e) {
    console.error('数据库连接错误:', e);
    return false;
  }
}
```