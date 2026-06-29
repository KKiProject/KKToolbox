# ST-MemoryAugment

SillyTavern 增强记忆扩展，提供上下文压缩、向量记忆、Reranker 精排、世界书语义触发和旁路弹幕。当前版本：`1.0.0`。

## 安装

本项目包含 UI Extension 和 Server Plugin，两部分必须同时安装。

1. 将 UI 文件放入：

   ```text
   SillyTavern/public/scripts/extensions/third-party/st-memory-augment/
   ```

2. 将 `server-plugin/st-memory-augment` 目录复制到：

   ```text
   SillyTavern/plugins/st-memory-augment/
   ```

3. 确认 `config.yaml` 包含：

   ```yaml
   enableServerPlugins: true
   ```

4. 重启 SillyTavern，在扩展设置中展开 **Memory Augment**，或点击顶部导航栏的脑图标快速打开。

本扩展无第三方 npm 依赖，使用 Node.js 内置模块及 SillyTavern 自带运行环境。

## API 配置

所有地址均填写 **Base URL**，可使用 `https://api.example.com`、`https://api.example.com/v1` 或带尾斜杠的形式；插件会统一移除末尾 `/v1` 和斜杠后再拼接具体端点。请不要填写 `/v1/embeddings` 等完整接口地址。API Key 和模型名不会硬编码在插件源码中。

| 配置 | 实际请求路径 | 用途 |
|---|---|---|
| Embedding API | `{base_url}/v1/embeddings` | 聊天和世界书向量化 |
| Reranker API | `{base_url}/v1/rerank` | 对向量候选精排，可留空 |
| 弹幕副 API | `{base_url}/v1/chat/completions` | 独立生成观众弹幕，可留空 |
| 模型列表 | `{base_url}/v1/models` | 三组 API 的模型下拉列表 |

Embedding 为核心配置。Reranker 未配置时自动使用向量相似度排序；弹幕 API 未配置或弹幕关闭时不会发起请求。

填写 Base URL 和 API Key 后可点击“拉取模型”。成功结果按配置区和 Base URL 缓存在扩展设置中；请求失败时会显示具体错误并保留手动模型输入框。

## 功能

### 向量记忆与精排

- AI 消息完成后自动摄入当前聊天快照。
- 默认每 3 条消息组成一个 chunk，仅变更的 chunk 会重新生成向量。
- 生成前使用最近 2–3 条消息检索 top-K，再按需 rerank 并保留 top-N。
- 数据按用户和聊天隔离，存放于用户数据目录的 `vectors/st-memory-augment/`。

### 上下文压缩

- 使用 SillyTavern 当前主 API 的 `generateQuietPrompt` 分段生成摘要。
- 每累计 5 次 AI 回复触发一次摘要；用户消息不参与计数，但摘要覆盖自上次摘要以来的全部用户消息和 AI 回复。
- AI 回复计数和上次摘要边界保存在 `chatMetadata.kktoolbox_summary_state`，摘要正文不写入聊天元数据。
- 摘要通过 SillyTavern 的 `executeSlashCommands` 写入聊天关联世界书，条目使用 `[KKT摘要]` 前缀并常驻激活。
- 生成时仅发送最近 N 楼原文；更早消息只从本次生成使用的 `chat` 副本中移除，SillyTavern 聊天记录不受影响。
- 摘要由 SillyTavern 在世界书位置自动注入，RAG 召回则注入到本次生成副本中。

### 世界书语义触发

- 选择器列出当前聊天、角色、全局及 persona 关联的有效世界书条目。
- 只有勾选并点击“向量化世界书”的条目参与语义检索。
- 语义触发是 ST 原生关键词触发的补充，不修改条目的关键词、常驻或禁用状态。
- 世界书更新后插件会提示重新向量化。

### 弹幕

- 在 AI 消息下方显示默认收起的“观众弹幕”区域。
- 可携带最近 N 楼和 RAG 片段，使用完全独立的 Chat Completions API。
- 弹幕可缓存到 `chatMetadata.memory_augment_barrages`，但绝不写入 `context.chat`，不会进入后续生成上下文。

## 主要设置

- 发送最近原文楼层数、按 AI 回复次数计算的摘要触发间隔、摘要最大 token。
- chunk 大小、top-K、top-N、Reranker 阈值。
- 世界书语义触发开关和条目选择器。
- 弹幕开关、最近楼层数、RAG 开关和系统提示词。

## 故障排查

- 设置面板显示 `offline`：确认 Server Plugin 已复制、`enableServerPlugins` 已开启并重启 ST。
- 自动摄入失败：检查浏览器控制台及 Embedding Base URL、Key、模型名。
- 没有 RAG 内容：先积累消息并确认状态面板已有 chunk。
- 没有世界书召回：确认条目已勾选、开关已启用，并在条目更新后重新向量化。
- 没有弹幕：确认弹幕开关和独立副 API 三项配置完整。

## 隐私说明

聊天分块、摘要和弹幕缓存保存在本地 SillyTavern 用户数据中。启用相应功能时，待处理文本会发送到用户配置的 API 服务商。
