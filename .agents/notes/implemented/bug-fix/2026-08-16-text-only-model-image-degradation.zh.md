# Agent Note：为纯文本模型切换降级图片历史

Status: implemented

[English](2026-08-16-text-only-model-image-degradation.md) | 中文

## 问题

会话的持久历史里一旦出现过一张图片，`session.selectModel` 就会拒绝一切到纯文本输入模型的切换，而纯文本路由每次请求都会把图片重发给会拒绝它的提供方。用户被锁死、切不回来：图片已经持久化，换模型不该要求 fork 或新开会话，而且对图片的过往分析——assistant 的文字回答——仍在历史里且依然有用。这个门还拦得过宽：即使*下一*个请求根本不带新图片，切换也被拒绝。

## 决策

历史图片在请求边界降级；只有新输入设门。

- `LlmRuntime` 在既有的精确模型查询中解析目标模型的输入模态（`resolveCallFor` 在 config 旁返回它；`prepareCall` 经其绑定注册的流把它带过去）。模态已声明且不含 `image` 时，请求中的每个图片块——包括嵌在 tool-result 内容里的，`contentHasImage` 本就递归行走——在适配器分派前被替换为 `[image omitted]` 占位文本。被降级的只有请求：会话日志保留原始图片及此前 assistant 对它的任何分析，调用方的消息对象不受影响。冻结请求保持冻结。模态未声明时请求原样发出——适配器仍是其真正拒绝内容的执法点。
- `session.selectModel` 只对排在 agent inbox（`nextTurn`/`nextStep`）里的图片设门：它们会作为新输入发出、随即被纯文本路由拒绝，在那里拒绝可以在用户排入更多工作之前点名模型。持久历史不再阻塞切换。
- `session.prompt` 仍拒绝当前模型为纯文本时携带*新*图片的 prompt（`attachment-error`）：把用户刚附上、期待被分析的图片悄悄换成占位符，等于撒谎，而发送时的 `attachment-error` 廉价地阻止了这一点。

SenseNova 路由的 `sensenova-6.8-flash-lite` 条目现在声明 `input: [text, image]`（网关元数据证实该模型接受图片），因此图片准入接受它，此前点名 6.8 Flash Lite 不支持图片的拒绝不复存在。

## 考虑过的替代方案

**继续拒绝切换，要求使用支持图片的模型。** 因为一张历史图片把会话钉死在一个路由家族上——这恰是模型选择要避免的。

**切换时从持久日志剥离图片。** 日志是每个模型可见输入的重建来源；为满足一条路由删除持久内容，会把它同时毁掉于未来所有支持图片的路由。

**把新附件也降级。** 用户刚附上、期待被分析的图片被悄悄换成占位符，是发送时 `attachment-error` 就能廉价阻止的谎言。

## 验证

`packages/llm/llm/tests/service.spec.ts` 把带图片的 user 消息加嵌套 tool-result 图片的消息流到纯文本路由，断言适配器在两个层级都收到占位文本，而调用方的消息保留图片、请求保持冻结；模态未声明的路由收到原消息对象。`packages/host/apiproxy/tests/api-proxy-models.spec.ts` 覆盖门的拆分：带图片持久历史上的纯文本选择成功；同一选择在 inbox 排有图片时返回 `model-unavailable`；清空队列后再次成功。`examples/sensenova-agent/tests/keyless-smoke.e2e.ts` 启动真实组合，断言 lite 模型以 `inputModalities: ['text', 'image']` 解析。

## 后果

带图片历史的会话随时可以切换到任何模型；纯文本路由看到 `[image omitted]` 占位符而非会拒绝的字节，会话对图片的文字记忆完好保留。在网关会拒绝的模型上多声明 `image` 仍会在轮次中途失败（模态声明不经验证），但恢复途径现在是一次模型切换，而非 fork 或新开会话。占位文本按原文对模型可见，并像任何文本一样计入输入 token。
