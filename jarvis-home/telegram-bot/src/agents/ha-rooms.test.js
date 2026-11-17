import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomsOnSingleMap, findRoom, cleanRoom, VACUUM_ENTITY } from './ha-rooms.js';

process.env.HA_URL = 'http://ha.test:8123';
process.env.HA_TOKEN = 'test-token';

const ROOMS = {
  Dganya: [
    { id: 1, name: 'Bathroom 2' },
    { id: 8, name: 'Kitchen' },
    { id: 9, name: 'Living Room' },
  ],
};

test('roomsOnSingleMap returns the rooms only when there is exactly one map', () => {
  assert.equal(roomsOnSingleMap(ROOMS), ROOMS.Dganya);
  assert.equal(roomsOnSingleMap({ Dganya: [], Other: [] }), null);
  assert.equal(roomsOnSingleMap({}), null);
  assert.equal(roomsOnSingleMap(undefined), null);
  assert.equal(roomsOnSingleMap([{ id: 1, name: 'Kitchen' }]), null);
});

test('findRoom matches the room name exactly, ignoring case and spacing', () => {
  assert.deepEqual(findRoom(ROOMS.Dganya, '  kitchen '), { id: 8, name: 'Kitchen' });
  assert.equal(findRoom(ROOMS.Dganya, 'Kitch'), null);
  assert.equal(findRoom(ROOMS.Dganya, 'Bathroom'), null);
  assert.equal(findRoom(ROOMS.Dganya, ''), null);
});

function stubHa(stateBody, { serviceStatus = 200 } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith(`/api/states/${VACUUM_ENTITY}`)) {
      return new Response(JSON.stringify(stateBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify([]), { status: serviceStatus, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('cleanRoom sends the room id to the Dreame segment service', async () => {
  const stub = stubHa({ state: 'docked', attributes: { rooms: ROOMS } });
  try {
    const result = await cleanRoom('Kitchen');
    assert.equal(result.ok, true);
    const service = stub.calls.at(-1);
    assert.equal(service.url, 'http://ha.test:8123/api/services/dreame_vacuum/vacuum_clean_segment');
    assert.equal(service.method, 'POST');
    assert.deepEqual(service.body, { entity_id: VACUUM_ENTITY, segments: 8 });
  } finally {
    stub.restore();
  }
});

test('cleanRoom refuses an unknown room without calling the vacuum', async () => {
  const stub = stubHa({ state: 'docked', attributes: { rooms: ROOMS } });
  try {
    const result = await cleanRoom('Garage');
    assert.equal(result.ok, false);
    assert.match(result.output, /Bathroom 2, Kitchen, Living Room/);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0);
  } finally {
    stub.restore();
  }
});

test('cleanRoom refuses when the active map is ambiguous', async () => {
  const stub = stubHa({ state: 'docked', attributes: { rooms: { A: ROOMS.Dganya, B: [] } } });
  try {
    const result = await cleanRoom('Kitchen');
    assert.equal(result.ok, false);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0);
  } finally {
    stub.restore();
  }
});

test('cleanRoom reports a failed service call instead of claiming success', async () => {
  const stub = stubHa({ state: 'docked', attributes: { rooms: ROOMS } }, { serviceStatus: 500 });
  try {
    const result = await cleanRoom('Kitchen');
    assert.equal(result.ok, false);
    assert.match(result.output, /Could not start the Kitchen clean/);
  } finally {
    stub.restore();
  }
});
