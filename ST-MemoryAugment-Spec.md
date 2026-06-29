# ST-MemoryAugment 插件施工规范

> **本文档是给 Claude Code (Codex) 的施工指令。请严格按照本文档的架构、文件结构和功能规范来实现代码。**

---

## 一、项目概述

为 SillyTavern（以下简称 ST）开发一个名为 `st-memory-augment` 的增强记忆插件，包含以下核心功能：

1. **上下文压缩**：自动摘要旧消息，分层隐藏，控制 context 长度
2. **向量记忆 (RAG)**：将聊天原文做 embedding 存储，每轮对话前召回相关历史
3. **Reranker 精排**：向量粗召回后用 reranker 模型精排，提升召回质量
4. **世界书语义触发**：对部分世界书条目做向量化，用语义匹配替代关键词触发
5. **弹幕旁路系统**：独立 API 调用生成"观众评论"，带最近 N 楼 + RAG 记忆，不写入聊天历史
6. **缓存友好注入顺序**：稳定内容靠前、变动内容靠后，最大化 prompt cache 命中

本插件由两部分组成：
- **Server Plugin**（Node.js 后端）：向量存储、embedding/reranker API 调用、弹幕 API 调用
- **UI Extension**（前端 JS）：设置面板、generate_interceptor 上下文操纵、弹幕 UI 渲染、事件监听

---

## 二、SillyTavern 扩展体系要点（必读）

### 2.1 UI Extension 结构

UI 扩展位于 `public/scripts/extensions/third-party/<extension-name>/` 目录。

必需文件：
```
st-memory-augment/
├── manifest.json
├── index.js          # 主入口
├── settings.html     # 设置面板 HTML 模板
├── style.css         # 样式
└── barrage.html      # 弹幕 UI 模板
```

**manifest.json 示例：**
```json
{
    "display_name": "Memory Augment",
    "loading_order": 5,
    "requires": [],
    "optional": [],
    "dependencies": [],
    "js": "index.js",
    "css": "style.css",
    "author": "用户自定义",
    "version": "0.1.0",
    "homePage": "",
    "auto_update": false,
    "generate_interceptor": "memoryAugmentInterceptor"
}
```

### 2.2 核心 API

```javascript
const context = SillyTavern.getContext();
// 可用属性/方法：
context.chat                    // 聊天消息数组（可变）
context.characters              // 角色列表
context.characterId             // 当前角色索引
context.groups                  // 群组列表
context.groupId                 // 当前群组 ID
context.chatMetadata            // 当前聊天的元数据（可持久化）
context.extensionSettings       // 扩展设置对象（可持久化）
context.saveSettingsDebounced() // 保存设置
context.saveMetadata()          // 保存聊天元数据
context.renderExtensionTemplateAsync(extName, templateId, data) // 渲染 HTML 模板
```

### 2.3 关键事件

```javascript
const { eventSource, event_types } = SillyTavern.getContext();

// 消息相关
event_types.MESSAGE_RECEIVED          // AI 消息生成完毕，写入 chat 对象后
event_types.MESSAGE_SENT              // 用户发送消息后
event_types.CHARACTER_MESSAGE_RENDERED // AI 消息渲染到 DOM 后

// 生成相关
event_types.GENERATION_STARTED        // 生成开始
event_types.GENERATION_ENDED          // 生成结束

// 聊天相关
event_types.CHAT_CHANGED              // 切换聊天/角色时
```

### 2.4 generate_interceptor（核心 Hook）

在 `manifest.json` 中声明 `"generate_interceptor": "memoryAugmentInterceptor"`，然后在 `index.js` 中定义全局函数：

```javascript
globalThis.memoryAugmentInterceptor = async function(chat, contextParams) {
    // chat: 消息对象数组，可直接修改（增删改消息）
    // 在这里做：
    //   1. 调用后端获取 RAG 召回内容
    //   2. 注入摘要
    //   3. 注入 RAG 召回的历史片段
    //   4. 调整消息顺序（缓存友好）
    //   5. 隐藏/移除过旧的原始消息
};
```

### 2.5 generateQuietPrompt（后台静默调用 LLM）

用于摘要生成等不需要用户看到的后台 LLM 调用：

```javascript
import { generateQuietPrompt } from "../../../../script.js";
const summary = await generateQuietPrompt({ quietPrompt: "请将以下内容摘要为..." });
```

### 2.6 Server Plugin 结构

Server Plugin 位于 ST 根目录的 `plugins/<plugin-name>/` 目录。需要在 `config.yaml` 中设置 `enableServerPlugins: true`。

```
plugins/st-memory-augment/
├── index.js          # 入口，导出 init / exit / info
├── vector-store.js   # 向量存储逻辑
├── embedding.js      # embedding API 调用封装
├── reranker.js       # reranker API 调用封装
└── barrage.js        # 弹幕 API 调用封装
```

**index.js 基本结构：**
```javascript
async function init(router) {
    // 注册路由
    router.post('/embed', ...);
    router.post('/search', ...);
    router.post('/rerank', ...);
    router.post('/barrage', ...);
    router.post('/ingest', ...);
    router.get('/status', ...);
}

async function exit() {
    // 清理
}

module.exports = {
    init,
    exit,
    info: {
        id: 'st-memory-augment',
        name: 'Memory Augment',
        description: 'Vector RAG memory, summarization, and barrage system',
    },
};
```

路由会被挂载到 `/api/plugins/st-memory-augment/` 路径下。

---

## 三、文件结构总览

```
SillyTavern/
├── plugins/
│   └── st-memory-augment/              # Server Plugin
│       ├── index.js                     # 入口：路由注册
│       ├── vector-store.js              # 向量存储（JSON 文件 + 内存索引）
│       ├── embedding.js                 # Embedding API 封装
│       ├── reranker.js                  # Reranker API 封装
│       ├── barrage.js                   # 弹幕 LLM API 封装
│       └── package.json                 # 依赖声明
│
├── public/scripts/extensions/third-party/
│   └── st-memory-augment/              # UI Extension
│       ├── manifest.json
│       ├── index.js                     # 前端主逻辑
│       ├── settings.html                # 设置面板
│       ├── barrage.html                 # 弹幕显示区域模板
│       ├── style.css                    # 样式
│       ├── context-manager.js           # 上下文压缩 + 注入排序
│       ├── rag-client.js                # 调用后端 RAG 接口的客户端
│       └── barrage-ui.js                # 弹幕前端渲染逻辑
│
└── data/                                # ST 数据目录
    └── <user>/
        └── vectors/                     # 向量数据存放（由 server plugin 管理）
            └── <chat-id>/
                ├── chunks.json          # 原文分块 + 元数据
                └── vectors.bin          # 向量二进制（或 JSON）
```

---

## 四、模块详细规范

### 模块 1：向量存储（Server Plugin - vector-store.js）

**数据结构：**
```javascript
// chunks.json 中每条记录
{
    "id": "chunk_001",
    "chat_id": "chat_xxx",
    "message_ids": [10, 11, 12],       // 包含的消息楼层号
    "text": "原始文本内容拼接...",       // 存原文，不存摘要
    "summary_tag": "第10-12楼：角色A和B在酒馆讨论任务",  // 简短标签
    "vector": [0.1, 0.2, ...],          // 1024 维 float32
    "timestamp": 1700000000,
    "type": "chat"                      // "chat" | "worldinfo"
}
```

**API 端点：**

| 端点 | 方法 | 功能 |
|------|------|------|
| `/ingest` | POST | 接收新消息，分块，调 embedding，存储 |
| `/search` | POST | 接收查询文本，返回 top-K 相关 chunks |
| `/rerank` | POST | 接收查询 + 候选 chunks，调 reranker 精排 |
| `/status` | GET | 返回当前存储状态（chunk 数、最后更新时间等）|
| `/clear` | POST | 清除指定 chat 的向量数据 |

**分块策略：**
- 默认每 3-5 条消息打包成一个 chunk
- 每个 chunk 附带一个简短摘要标签（用 LLM 生成，通过 generateQuietPrompt 或弹幕副 API）
- 向量用原文生成，不用摘要生成
- 分块数量可通过设置面板调整

### 模块 2：Embedding API 封装（Server Plugin - embedding.js）

**对接硅基流动 BGE-M3：**
```
POST https://api.siliconflow.cn/v1/embeddings
Headers: { Authorization: "Bearer <API_KEY>" }
Body: {
    "model": "BAAI/bge-m3",
    "input": ["文本1", "文本2", ...],
    "encoding_format": "float"
}
```

- 支持批量输入，一次最多 64 条
- 返回 1024 维向量
- 需要做限速和重试（429 指数退避）
- **设置项：** API 地址、API Key、模型名（均可自定义，不硬编码）

### 模块 3：Reranker API 封装（Server Plugin - reranker.js）

**对接硅基流动 BGE-Reranker：**
```
POST https://api.siliconflow.cn/v1/rerank
Headers: { Authorization: "Bearer <API_KEY>" }
Body: {
    "model": "BAAI/bge-reranker-v2-m3",
    "query": "当前对话上下文",
    "documents": ["候选文本1", "候选文本2", ...],
    "top_n": 5
}
```

- 输入：query + 向量粗召回的候选列表
- 输出：按相关性重排后的结果
- **设置项：** API 地址、API Key、模型名、reranker 阈值（低于阈值的不注入）

### 模块 4：上下文压缩与注入（UI Extension - context-manager.js）

**核心逻辑在 `generate_interceptor` 中执行：**

1. **分层策略：**
   - 最近 N 楼（用户可配置，默认 5）：保留原文
   - N 楼之前：仅从本次生成的 `chat` 副本中移除原文，绝不修改 `context.chat`
   - 摘要通过 `executeSlashCommands` 存储在当前聊天关联的世界书中，由 SillyTavern 自动注入

2. **摘要生成时机：**
   - 监听 `MESSAGE_RECEIVED` 事件
   - 每累计 X 次 AI 回复（默认 5 次）检查是否需要触发摘要，用户消息不参与计数
   - 摘要范围覆盖自上次摘要以来的全部未摘要消息，包括用户消息和 AI 回复
   - AI 回复计数和摘要边界持久化在 `chatMetadata.kktoolbox_summary_state`
   - 使用 `generateQuietPrompt` 调用当前主 API 做摘要
   - 摘要正文写入 `[KKT摘要]` 前缀的聊天世界书常驻条目

3. **缓存友好注入顺序（在 interceptor 中重排 chat 数组）：**
   ```
   ① 系统预设（不动，ST 自己管）
   ② 常驻世界书条目（不动，ST 自己管）
   ③ RAG 召回内容（作为 system/narrator 消息注入）
   ④ 语义触发的世界书条目（同上）
   ⑤ 世界书常驻摘要（由 SillyTavern 在世界书位置注入）
   ⑥ 最近 N 楼原文（只发送生成副本中的这些原文）
   ⑦ 用户当前输入（不动）
   ```

4. **RAG 注入流程：**
   - 取最近 2-3 条消息文本作为 query
   - 调后端 `/search` 获取 top-K（默认 20）候选
   - 调后端 `/rerank` 精排，取 top-N（默认 5）
   - 将结果作为特殊消息注入 chat 数组
   - 注入格式：`[记忆召回] 以下是与当前对话相关的历史片段：\n...`

### 模块 5：世界书语义触发

**实现方式：**
- 在设置面板中提供一个按钮："向量化当前世界书条目"
- 遍历用户的 lorebook 条目，对设为"语义触发"（用户需在 ST 中标记，或我们自己在设置中提供条目选择器）的条目做 embedding
- 存入向量库，type 标记为 `"worldinfo"`
- 在 RAG 召回时同时检索 chat 和 worldinfo 类型的向量
- 注入时世界书条目放在 RAG 历史片段前面

**注意：不要覆盖 ST 原生的关键词触发逻辑，我们的语义触发是补充，不是替代。**

### 模块 6：弹幕旁路系统

**后端（Server Plugin - barrage.js）：**
```
POST https://<用户自定义API地址>/v1/chat/completions
Headers: { Authorization: "Bearer <API_KEY>" }
Body: {
    "model": "<用户配置的便宜模型>",
    "messages": [
        { "role": "system", "content": "你是一群正在观看小说直播的观众..." },
        { "role": "user", "content": "以下是最近的故事内容：\n[最近N楼原文]\n\n[RAG召回的相关历史]\n\n请以弹幕/评论区的形式吐槽点评。" }
    ],
    "max_tokens": 500
}
```

- 弹幕 API 独立于 ST 主 API，单独配置地址、key、模型名
- 弹幕请求的 context 组装：最近 N 楼原文（默认 5）+ RAG 召回片段
- 使用 OpenAI 兼容格式（大多数国产 API 都兼容）

**前端（UI Extension - barrage-ui.js）：**
- 监听 `CHARACTER_MESSAGE_RENDERED` 事件
- AI 回复渲染完毕后，异步调后端弹幕接口
- 将返回的弹幕内容渲染到消息下方的折叠区域（或侧边悬浮面板）
- **关键：弹幕内容不写入 `context.chat`，不调用 `saveMetadata`**
- 弹幕可以选择性存储到 `chatMetadata` 仅供展示回看，但不参与 context 组装

### 模块 7：设置面板（UI Extension - settings.html）

用 ST 标准的 `inline-drawer` 风格构建设置面板，分以下区块：

**① API 配置**
- Embedding API：地址、Key、模型名
- Reranker API：地址、Key、模型名
- 弹幕副 API：地址、Key、模型名

**② 上下文压缩设置**
- 发送最近 N 楼原文（slider，范围 1-20，默认 5）
- 摘要触发间隔（每 X 次 AI 回复触发一次摘要，默认 5）
- 摘要最大长度（token 数，默认 500）

**③ RAG 设置**
- 分块大小（几条消息一个 chunk，默认 3）
- 向量粗召回数量 top-K（默认 20）
- Reranker 精排后保留数量 top-N（默认 5）
- Reranker 相关性阈值（0-1，默认 0.3，低于此值不注入）
- 世界书语义触发开关
- "向量化世界书"按钮
- "重建当前聊天向量"按钮

**④ 弹幕设置**
- 弹幕总开关
- 弹幕携带最近 N 楼上文（默认 5）
- 弹幕携带 RAG 召回开关（默认开）
- 弹幕系统提示词（可编辑 textarea）

**⑤ 状态面板**
- 当前聊天已存储 chunk 数量
- 最后一次摘要时间
- 向量库总大小

设置持久化使用 `context.extensionSettings['st-memory-augment']`。

---

## 五、开发分阶段计划

### Phase 1：骨架搭建（优先做这个）
- [ ] 创建 Server Plugin 目录和入口文件（info/init/exit 导出）
- [ ] 创建 UI Extension 目录、manifest.json、index.js
- [ ] 设置面板 HTML 模板 + 设置读写逻辑
- [ ] Server Plugin 路由桩（所有端点返回 mock 数据）
- [ ] 验证插件能被 ST 正常加载和显示

### Phase 2：向量存储 + Embedding
- [ ] 实现 embedding.js（硅基流动 API 调用，含重试逻辑）
- [ ] 实现 vector-store.js（JSON 文件存储 + 余弦相似度检索）
- [ ] 实现 `/ingest` 和 `/search` 端点
- [ ] 前端监听 `MESSAGE_RECEIVED`，自动调 `/ingest` 存储新消息
- [ ] 测试：发送消息后能正确存储和检索

### Phase 3：Reranker + RAG 注入
- [ ] 实现 reranker.js（API 调用封装）
- [ ] 实现 `/rerank` 端点
- [ ] 实现 `generate_interceptor`：组装 query → search → rerank → 注入 chat 数组
- [ ] 测试：生成时能正确召回并注入相关历史

### Phase 4：上下文压缩
- [ ] 实现摘要生成逻辑（使用 generateQuietPrompt）
- [x] 实现世界书常驻摘要条目与旧 chatMetadata 摘要迁移
- [ ] 在 interceptor 中实现旧消息替换/隐藏
- [ ] 实现缓存友好的注入排序
- [ ] 测试：长对话中旧消息被正确压缩

### Phase 5：弹幕系统
- [ ] 实现 barrage.js（副 API 调用）
- [ ] 实现 `/barrage` 端点
- [ ] 实现前端弹幕 UI（折叠区域）
- [ ] 监听 `CHARACTER_MESSAGE_RENDERED`，异步触发弹幕生成
- [ ] 测试：弹幕正常显示且不影响聊天历史

### Phase 6：世界书语义触发
- [ ] 实现世界书条目读取（通过 getContext）
- [ ] 实现条目向量化和存储
- [ ] 在 RAG 检索时同时检索 worldinfo 类型向量
- [ ] 测试：语义相关的世界书条目能被正确触发

---

## 六、技术约束

1. **Server Plugin 使用 CommonJS**（`module.exports`），不是 ESM
2. **UI Extension 使用 ESM**（`import/export`），因为 ST 前端是 ESM
3. **不要引入重量级依赖**，向量检索用纯 JS 实现余弦相似度即可
4. **所有 API 地址、Key、模型名不要硬编码**，全部从设置读取
5. **向量数据存储路径**应该在 ST 的用户数据目录下，通过 `req.user` 获取用户路径
6. **弹幕内容绝对不能写入 `context.chat`**，只做前端展示
7. **不要覆盖 ST 原有的 summarize / vector storage 扩展**，我们是并行的独立插件
8. **Embedding API 使用 OpenAI 兼容格式**（`/v1/embeddings`），这样换厂商只需改地址和 key
9. **弹幕 API 使用 OpenAI Chat Completions 兼容格式**（`/v1/chat/completions`）
10. **Reranker API 使用 Jina/硅基流动的 `/v1/rerank` 格式**

---

## 七、余弦相似度参考实现

```javascript
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

## 八、关键提醒

- `generate_interceptor` 只裁剪本次生成副本中的旧原文并注入 RAG；摘要由 SillyTavern 世界书机制自动注入
- `MESSAGE_RECEIVED` 事件是我们存储新消息向量的触发点
- `CHARACTER_MESSAGE_RENDERED` 事件是我们触发弹幕生成的时机
- 摘要写入聊天关联世界书的 `[KKT摘要]` 常驻条目；`chatMetadata` 只保存计数、边界和条目索引，不保存摘要正文
- `extensionSettings` 用于存储全局设置（API 配置、各种参数）
- 调用后端 Server Plugin 的路径格式：`/api/plugins/st-memory-augment/<endpoint>`

---

## 九、先从 Phase 1 开始

**第一步就是把骨架搭起来，确保 ST 能正常加载插件，设置面板能显示，所有路由桩能响应。后续功能逐步填充。**
