# 简易Cloudflare反代大陆无法直连的大模型API

在Cloudflare Workers或Pages上部署，用于反代大陆无法直接访问的大模型API。支持完全透传，不做任何修改。支持轮询API密钥，避免请求限制。

## 支持的服务提供商
暂时支持gemini, openai, claude, groq, cerebras大模型服务。

## 如何使用
**基本使用方法：**
- **GEMINI:**   `https://<your_url>/gemini/...`
- **OPENAI:**   `https://<your_url>/openai/...`
- **CLAUDE:**   `https://<your_url>/claude/...`
- **GROQ:**     `https://<your_url>/groq/...`
- **CEREBRAS:**  `https://<your_url>/cerebras/...`

## 可选功能

### 1. Analytics Engine 日志功能
该功能可记录所有API请求的关键指标，提供强大的可观测性。

**配置方法：**
- 参考详细配置指南：[Analytics Engine 日志配置指南](ANALYTICS_ENGINE_SETUP.md)
- 在Cloudflare仪表板创建Analytics Engine数据集
- 在wrangler.toml或仪表板中配置LOGS绑定
- 日志会自动记录服务商、模型、状态码、响应时间等信息

### 2. API密钥轮询功能
该功能可实现API密钥的自动轮询，有效避免单个密钥的请求限制问题。

**配置方法：**
- 参考详细配置指南：[轮询配置指南](ROTATION_SETUP.md)
- 在Cloudflare仪表板创建D1数据库
- 在wrangler.toml或仪表板中配置DB绑定
- 创建rotation_state表用于存储轮询状态
- 设置MASTER_KEY环境变量和各服务商的密钥列表

## 注意事项
- 基础反代功能无需额外配置即可使用
- 轮询功能需要配置D1数据库、MASTER_KEY和各服务商的密钥列表
- 日志功能需要配置Analytics Engine数据集和LOGS绑定
- 所有功能均为可选，您可以根据需要选择性配置






