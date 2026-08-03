import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOrphanedToolResults } from '../src/contextBudget';

// 该测试锁定梯度 4 闸门的行为契约:proxy 转发前对 body.messages 无条件调用
// stripOrphanedToolResults(见 src/proxy.ts trim 块后)。这里直接验证该调用
// 对"带孤儿、未触发 trim"的请求也能清干净,并保留合法配对。
test('gate strips a client-sent orphan even when no trim happened', () => {
  const messages: any[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    // 孤儿:父 tool_use 从不存在
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'ghost', content: 'orphan' },
      { type: 'text', text: 'hi' },
    ] },
  ];
  stripOrphanedToolResults(messages);
  // 合法配对保留
  assert.deepEqual(messages[1].content, [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]);
  // 孤儿块被剥离,同消息内正常块保留
  assert.deepEqual(messages[2].content, [{ type: 'text', text: 'hi' }]);
});

test('gate is a no-op on a fully-paired body', () => {
  const messages: any[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ];
  const before = JSON.parse(JSON.stringify(messages));
  stripOrphanedToolResults(messages);
  assert.deepEqual(messages, before);
});
