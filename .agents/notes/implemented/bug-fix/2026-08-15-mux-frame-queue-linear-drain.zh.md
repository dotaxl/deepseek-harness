# Agent Note: mux 帧队列的线性排空

Status: implemented

[English](2026-08-15-mux-frame-queue-linear-drain.md) | 中文

## Problem

`dsh --profile web` 把浏览器 UI 与所有 agent 会话共置在同一个 Node 事件循环上。一个长会话流式输出期间，host 稳定在 80–90% CPU、约 1 GB RSS——且在会话日志最后一次写入后数分钟仍不下降。`sample` 显示主线程约 90% 时间落在 `AsyncGeneratorResumeNext → Builtin_ArrayShift → MoveElements/memmove`，每个元素伴随一次 `writev`：`dsh-host-apiproxy` 的 `FrameQueue.iterate` 用 `while (buffer.length > 0) yield buffer.shift()` 排空缓冲，而每连接的 WebSocket 泵（`dsh-client-connection` 的 `websocket-downlink.ts`）每帧一次 `socket.send`。mux 队列对每个会话的每条 `session/event` 推入一帧——流式期间是 chunk 级频率——且无上界，于是浏览器跟不上时，downlink 会积压数万帧；此后每次 `shift()` 都要 memmove 整段剩余元素，排空退化为平方级。这饿死了事件循环：用户输入晚到 host，正是用户报告的"发送内容后没有立即显示"。

产线一侧的姊妹缺陷——一个啰嗦运行产生约 6 万事件——已由 agent-loop 终止守卫约束（[note](2026-08-15-agent-loop-runaway-loop-bounds.md)，中文版为同名的 `.zh.md`）。本 note 修复分发侧：即使没有新事件，它也会因积压持续排空而保持高热。

## Decision

host 侧队列与镜像它的浏览器侧 inbox 现在都通过 head 游标消费，不再 `shift()`：

- `FrameQueue`（`packages/host/apiproxy/src/api-proxy.ts`）推进 `head` 越过已消费条目并 yield `buffer[head++]`；`push`/`end`/waiter 与 abort/cleanup 语义不变。出队摊还 O(1)。
- `WebApiClient.readWebSocket` 的 inbox（`packages/client/connection/src/client/web-api-client.ts`）采用同样游标。
- 两者仅在已消费前缀压倒存活剩余部分时丢弃前缀（`head > 1024 && head * 2 > buffer.length` → `splice(0, head)`），数组既不会无限增长，又保持基本只追加。1024 下限避免稳定的 chunk 级流在 splice 上反复抖动。

inbox 的测试孪生（`fixture.ts` 的 `drain`）保留 `shift()`：其积压受脚本化重放帧约束，永远到不了 chunk 级流量，平方场景在那里不可达。

mux 协议不变——不合并帧、不新增背压。socket 级背压已存在（泵逐次 await `send` 回调）；缺陷在队列排空成本，不在流控。若线缆本身成为瓶颈，chunk 帧合并仍是后续项。

## Alternatives considered

**带丢弃/刷新语义的有界队列。** 从饱和的 downlink 丢弃 chunk 帧会拿完整性换延迟，但与 `lastSeq` 重连基线的顺序关系和逐帧 rpcId 使刷新语义成为一次协议重设计。游标在不触碰契约的前提下移除了饱和的成因（CPU）。

**在 `iterate` 内按 `splice(0)` 批量出队。** 每次唤醒一次 splice 取 N 帧也是线性，但它改变了 yield 粒度且每批仍付出 O(剩余) 的代价；游标严格更简单。

## Verification

`packages/host/apiproxy/tests/api-proxy-mux-backlog.spec.ts` 用真实的 `events.mux` 流排空 5000 事件的停滞积压——规模足以跨越压缩边界——断言每帧按严格递增的 seq 顺序到达，另有交错的生产/消费轮次保持顺序。服务器重启后的运行时检查：空闲 host CPU 回到 10% 以下（原为 80–90%），重启进程的 `sample` 不再出现 `ArrayShift` 主导的调用栈。

## Consequences

落后于活跃 agent chunk 频率的 downlink 现在在链路两端都以线性时间排空积压，慢的浏览器标签页只消耗它自己的渲染工作，不再拖累共享事件循环。积压帧仍逐帧一次 `writev` 投递——极端积压下的延迟由 socket 决定，而非平方级数组搬移。压缩阈值是队列内部的固定尺度（同 1024 下限），不做部署级调参：它没有面向消费者的含义。
