import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickCallOptions, haikuModel, sonnetModel, opusModel, openaiSmallModel, transcribeModel } from './models.js';
import { responseText } from './agents/shared.js';

test('defaults are the 5.5 Claude tiers and the GPT-6 / gpt-transcribe OpenAI models', () => {
  assert.equal(haikuModel(), 'claude-haiku-5-5');
  assert.equal(sonnetModel(), 'claude-sonnet-5-5');
  assert.equal(opusModel(), 'claude-opus-5-5');
  assert.equal(openaiSmallModel(), 'gpt-6-luna');
  assert.equal(transcribeModel(), 'gpt-transcribe');
});

test('env overrides win over defaults', () => {
  process.env.MODEL_HAIKU = 'claude-haiku-4-5-20251001';
  try {
    assert.equal(haikuModel(), 'claude-haiku-4-5-20251001');
  } finally {
    delete process.env.MODEL_HAIKU;
  }
});

test('quickCallOptions disables thinking only on Haiku 5.x', () => {
  assert.deepEqual(quickCallOptions('claude-haiku-5-5'), { thinking: { type: 'disabled' } });
  assert.deepEqual(quickCallOptions('claude-haiku-4-5-20251001'), {});
  assert.deepEqual(quickCallOptions('claude-sonnet-5-5'), {});
  assert.deepEqual(quickCallOptions('claude-opus-5-5'), {});
});

test('responseText skips thinking and tool blocks', () => {
  const data = {
    content: [
      { type: 'thinking', thinking: 'hmm', signature: 'x' },
      { type: 'text', text: '{"ok":' },
      { type: 'tool_use', id: 't', name: 'n', input: {} },
      { type: 'text', text: 'true} ' },
    ],
  };
  assert.equal(responseText(data), '{"ok":true}');
  assert.equal(responseText({}), '');
  assert.equal(responseText(null), '');
});
