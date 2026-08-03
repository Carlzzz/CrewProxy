import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOrphanedToolResults } from '../src/contextBudget';

test('strips a mixed orphan tool_result block but keeps sibling text', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'ghost', content: 'orphan' },
      { type: 'text', text: 'hi' },
    ] },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].content, [
    { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
    { type: 'text', text: 'hi' },
  ]);
});

test('removes the whole message when it becomes empty after stripping', () => {
  const messages = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
});

test('leaves valid pairs untouched', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ];
  const before = JSON.parse(JSON.stringify(messages));
  stripOrphanedToolResults(messages);
  assert.deepEqual(messages, before);
});

test('does not remove a tool_use that has no tool_result (allowed mid-turn)', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content[0].type, 'tool_use');
});

test('handles string content and missing content without throwing', () => {
  const messages: any[] = [
    { role: 'user', content: 'plain string' },
    { role: 'assistant' },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 2);
});
