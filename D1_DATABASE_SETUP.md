# D1 数据库设置指南

本文档提供了配置 Cloudflare D1 数据库以支持 API 密钥轮询功能的说明。

## 1. 表名配置

在 `_worker.js` 文件中，我已将表名设置为常量，您可以根据实际数据库中的表名进行修改：

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

## 5. 常见问题解决

如果遇到数据库错误，请检查以下几点：

1. 确保您的 D1 数据库已正确创建并绑定到 Worker
2. 确保表名在代码中和数据库中保持一致
3. 确保表结构包含必要的字段：`service_name`, `next_index`, `last_updated`
4. 确保 `service_name` 字段已设置为主键，以便 `ON CONFLICT` 子句正常工作

## 6. 测试数据库连接

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
