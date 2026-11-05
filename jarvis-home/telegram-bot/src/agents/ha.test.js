import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExcludes, parseResolution, serviceFor, _internal } from './ha.js';

const { buildEntityList } = _internal;

const STATES = [
  { entity_id: 'switch.living_room_ac', state: 'off', attributes: { friendly_name: 'Living Room AC' } },
  { entity_id: 'scene.turn_on_livingroom_ac', state: '2026-08-19T14:04:00', attributes: { friendly_name: 'Turn on Livingroom AC Cold' } },
  { entity_id: 'scene.turn_off_livingroom_ac', state: '2026-08-20T11:39:00', attributes: { friendly_name: 'Turn off Livingroom AC' } },
  { entity_id: 'script.livingroom_ac_heat', state: 'off', attributes: { friendly_name: 'Living Room AC - Heat' } },
  { entity_id: 'script.livingroom_ac_off', state: 'off', attributes: { friendly_name: 'Living Room AC - Off' } },
  { entity_id: 'input_select.livingroom_ac_mode', state: 'cool', attributes: { friendly_name: 'Living room AC mode' } },
  { entity_id: 'light.bedroom_light', state: 'unavailable', attributes: { friendly_name: 'Bedroom Light' } },
  { entity_id: 'sensor.outdoor_temperature', state: '24', attributes: {} },
];

test('buildEntityList hides excluded look-alikes and unavailable entities, and lists modes as context', () => {
  const { controllable, context } = buildEntityList(STATES, parseExcludes(' scene.*livingroom_ac* ,script.livingroom_ac_off'));
  assert.deepEqual(controllable.split('\n'), [
    'switch.living_room_ac | Living Room AC | off',
    'script.livingroom_ac_heat | Living Room AC - Heat | off',
  ]);
  assert.equal(context, 'input_select.livingroom_ac_mode | Living room AC mode | cool');
  assert.equal(buildEntityList(STATES, []).controllable.split('\n').length, 5, 'nothing hidden without HA_AGENT_EXCLUDE');
});

test('parseResolution reads the JSON even when the model wraps it in prose or fences', () => {
  const pick = { action: 'turn_on', entity_id: 'switch.living_room_ac' };
  const cases = [
    ['bare', JSON.stringify(pick), pick],
    ['fenced', `\`\`\`json\n${JSON.stringify(pick)}\n\`\`\``, pick],
    ['prose around it', `Since it's off, I'll turn it on: ${JSON.stringify(pick)} — done.`, pick],
    ['no JSON', 'I am not sure which device you mean.', null],
    ['empty', '', null],
  ];
  for (const [name, text, expected] of cases) assert.deepEqual(parseResolution(text), expected, name);
});

test('serviceFor never lets "off" or "toggle" run a scene or script that does something else', () => {
  const cases = [
    ['device off', 'switch.living_room_ac', 'turn_off', 'Living Room AC', 'turn_off'],
    ['device toggle', 'light.kitchen', 'toggle', 'Kitchen', 'toggle'],
    ['run a script', 'script.livingroom_ac_heat', 'turn_on', 'Living Room AC - Heat', 'turn_on'],
    ['off script by name', 'script.livingroom_ac_off', 'turn_off', 'Living Room AC - Off', 'turn_on'],
    ['off scene by id', 'scene.turn_off_livingroom_ac', 'turn_off', 'Turn off Livingroom AC', 'turn_on'],
    ['toggle script', 'script.livingroom_ac_smart_toggle', 'toggle', 'Living Room AC - Smart Toggle', 'turn_on'],
    ['"off" on the ON scene', 'scene.turn_on_livingroom_ac', 'turn_off', 'Turn on Livingroom AC Cold', null],
    ['"toggle" on a plain script', 'script.livingroom_ac_heat', 'toggle', 'Living Room AC - Heat', null],
    ['"office" is not "off"', 'scene.office_lights', 'turn_off', 'Office Lights', null],
  ];
  for (const [name, entityId, action, friendly, expected] of cases) {
    const { service, error } = serviceFor(entityId, action, friendly);
    assert.equal(service ?? null, expected, name);
    if (expected === null) assert.match(error, /can't turn anything off/, name);
  }
});
