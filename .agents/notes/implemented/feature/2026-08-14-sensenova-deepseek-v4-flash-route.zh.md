# Agent Note: 通过手写 llm-pi-ai 路由接入 SenseNova 的 DeepSeek V4 Flash

Status: implemented

[English](2026-08-14-sensenova-deepseek-v4-flash-route.md) | 中文

## 问题

我们需要通过 SenseNova 平台提供 DeepSeek V4 Flash。SenseNova 暴露的是兼容 OpenAI Chat Completions 的端点，但其思考输出位于 `delta.reasoning` / `message.reasoning`，而非 DeepSeek 自有 API 使用的 `reasoning_content` 字段；并且它不是 pi-ai 内置的目录 provider。从零写一个适配器会重复 harness 已经具备的 OpenAI-completions 线网逻辑。

## 决策

在现有的 `@deepseek-ai/dsh-llm-pi-ai` 插件上加一个手写的 `openai-completions` 路由——不新增包，也不改动 `packages/` 源码。该路由将 `api: openai-completions` 指向 `https://token.sensenova.cn/v1`，设置 `apiKeyEnv: SENSENOVA_API_KEY`，并声明 `deepseek-v4-flash` 模型。pi-ai 的 `openai-completions` 协议已从 `["reasoning_content", "reasoning", "reasoning_text"]` 读取思考内容（`openai-completions.js`），因此 SenseNova 的 `reasoning` 字段在响应侧可以直接透传。

由于 SenseNova 的 OpenAI 端点没有声明 `reasoning_effort` 参数，该路由设置 `compat.supportsReasoningEffort: false` 并配合 `thinkingFormat: openai`。`openai` 不属于任何特殊处理的 thinking 格式，因此请求构造会落到通用的 OpenAI 分支，而该分支把所有 thinking 参数都挂在 `supportsReasoningEffort` 上——当它为假时，**任何** thinking 参数（`reasoning_effort`、`thinking`、`enable_thinking` ……）都不会被发送。模型仍然被声明为支持思考（`reasoningEfforts: { off: , max: max }`），以便 harness 正确标注它，并且端点默认的思考仍会出现在响应中。

该组合位于 `examples/sensenova-agent/cordis.yml`，可通过 `examples/sensenova-agent/tests/keyless-smoke.e2e.ts`（无 key 启动整棵树并解析该路由/模型）与 `examples/sensenova-agent/tests/real-model.e2e.ts`（缺少 `SENSENOVA_API_KEY` 时自动跳过）运行与验证。

## 我们放弃的部分

- **没有专用适配器包。** 如果 SenseNova 后续需要非 OpenAI 的线网差异——自定义必填请求头、不同的 `finish_reason` 集合，或加密思考——这个路由就必须变成 `llm-deepseek` 的同级包，而不再只是配置项。
- **没有请求侧的思考控制。** 思考力度完全取决于 SenseNova 端点的默认值；我们刻意不发送 `reasoning_effort`。

## 重新引入条件

如果 SenseNova 声明了 `reasoning_effort`（或 `thinking`）参数，将 `supportsReasoningEffort` 改为 `true` 并在路由中设置 `reasoningEfforts` 的线网拼写即可——无需新增包。

## 后果

该路由在不改动 `packages/` 源码、也不新增包的前提下接入了一个 vendor，因此仍然落在 harness 的纯配置扩展模型之内。它原样继承了 pi-ai `openai-completions` 协议的请求/响应处理（包括思考透传）。代价是上面两条限制：没有专用线网，也没有请求侧的思考控制。

## 备选方案

- **专用的 `llm-sensenova` 适配器包。** 否决：SenseNova 暴露的是标准 OpenAI Chat Completions 端点，而 pi-ai 已经实现了该协议，所以做一个同级包只会重复线网逻辑，没有任何行为收益。
- **无条件发送 `reasoning_effort`。** 否决：SenseNova 的端点没有声明这个参数，发送不受支持的字段可能引发 4xx；`supportsReasoningEffort: false` 在保持请求干净的同时，仍然把模型标注为支持思考。
