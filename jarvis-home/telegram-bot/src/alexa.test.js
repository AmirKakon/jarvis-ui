import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from './alexa.js';

const { parseDeviceMap, lastCalledPlayer, deviceIdOf } = _internal;

test('parseDeviceMap reads id=player pairs and skips malformed entries', () => {
  assert.deepEqual(
    parseDeviceMap(' amzn1.ask.device.AAA = media_player.living_room_echo ,amzn1.ask.device.BBB=media_player.alines_echo_dot,broken,=x'),
    { 'amzn1.ask.device.AAA': 'media_player.living_room_echo', 'amzn1.ask.device.BBB': 'media_player.alines_echo_dot' },
  );
  assert.deepEqual(parseDeviceMap(undefined), {});
});

test('lastCalledPlayer picks the media_player flagged last_called', () => {
  const states = [
    { entity_id: 'sensor.last_called', attributes: { last_called: true } },
    { entity_id: 'media_player.alines_echo_dot', attributes: { last_called: false } },
    { entity_id: 'media_player.living_room_echo', attributes: { last_called: true } },
  ];
  assert.equal(lastCalledPlayer(states), 'media_player.living_room_echo');
  assert.equal(lastCalledPlayer([{ entity_id: 'media_player.x', attributes: {} }]), null);
  assert.equal(lastCalledPlayer(null), null);
});

test('deviceIdOf reads the Echo id from the request context', () => {
  assert.equal(deviceIdOf({ context: { System: { device: { deviceId: 'amzn1.ask.device.AAA' } } } }), 'amzn1.ask.device.AAA');
  assert.equal(deviceIdOf({}), null);
});
