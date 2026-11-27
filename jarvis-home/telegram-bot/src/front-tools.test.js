import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRONT_TOOL_NAMES, frontTools, openaiTools, fromAnthropic, fromOpenAI } from './front-tools.js';

test('every front tool requires acknowledge and is a known action name', () => {
  for (const t of frontTools([{ name: 'recipes', description: 'Recipes' }])) {
    assert.ok(FRONT_TOOL_NAMES.includes(t.name), t.name);
    assert.ok(t.input_schema.required.includes('acknowledge'), t.name);
  }
});

test('mcp tool is offered only when a server is connected, and lists it', () => {
  assert.ok(!frontTools([]).some((t) => t.name === 'mcp'));
  const mcp = frontTools([{ name: 'qrganize', description: 'home inventory' }]).find((t) => t.name === 'mcp');
  assert.match(mcp.description, /qrganize \(home inventory\)/);
});

test('openaiTools keeps name, description and schema', () => {
  const [first] = openaiTools(frontTools());
  assert.equal(first.type, 'function');
  assert.equal(first.function.name, 'delegate');
  assert.deepEqual(first.function.parameters, frontTools()[0].input_schema);
});

test('fromAnthropic turns tool_use blocks into action objects, in order', () => {
  const { actions, text } = fromAnthropic({
    content: [
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'a', name: 'ha', input: { command: 'turn on the office light', acknowledge: 'Lights, Sir.' } },
      { type: 'tool_use', id: 'b', name: 'search', input: { query: 'port strike news', acknowledge: 'Fetching, Sir.' } },
    ],
  });
  assert.deepEqual(actions, [
    { ha: true, command: 'turn on the office light', acknowledge: 'Lights, Sir.' },
    { search: true, query: 'port strike news', acknowledge: 'Fetching, Sir.' },
  ]);
  assert.equal(text, 'On it.');
});

test('fromAnthropic with only text is a direct answer', () => {
  assert.deepEqual(fromAnthropic({ content: [{ type: 'text', text: 'Good evening, Sir.' }] }), {
    actions: [], text: 'Good evening, Sir.',
  });
});

test('fromAnthropic drops calls to tools it does not know', () => {
  const { actions } = fromAnthropic({ content: [{ type: 'tool_use', name: 'rm_rf', input: {} }] });
  assert.deepEqual(actions, []);
});

test('the action flag wins over an input field with the same name', () => {
  const { actions } = fromAnthropic({ content: [{ type: 'tool_use', name: 'bus', input: { bus: false, question: 'next 65' } }] });
  assert.equal(actions[0].bus, true);
});

test('fromOpenAI parses function calls and skips malformed arguments', () => {
  const { actions, text } = fromOpenAI({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          { type: 'function', function: { name: 'remind', arguments: '{"action":"set","text":"in 5 min","acknowledge":"Done"}' } },
          { type: 'function', function: { name: 'weather', arguments: '{not json' } },
        ],
      },
    }],
  });
  assert.deepEqual(actions, [{ remind: true, action: 'set', text: 'in 5 min', acknowledge: 'Done' }]);
  assert.equal(text, '');
});
