import { fetchHA } from './ha.js';

// Room cleaning for the Dreame/MOVA vacuum, through the integration's segment service.
// The vacuum's `rooms` attribute is { "<map name>": [{ id, name, ... }] }; the segment
// id is the room's `id`. Anything that doesn't match exactly is refused, never guessed.

export const VACUUM_ENTITY = 'vacuum.mova_e30_ultra';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Rooms of the only saved map. Zero or several maps is ambiguous, so it returns null.
export function roomsOnSingleMap(rooms) {
  if (!isPlainObject(rooms)) return null;
  const maps = Object.values(rooms);
  if (maps.length !== 1 || !Array.isArray(maps[0])) return null;
  return maps[0];
}

export function findRoom(rooms, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return rooms.find((r) => String(r.name || '').trim().toLowerCase() === wanted) || null;
}

export async function cleanRoom(name) {
  const state = await fetchHA(`states/${VACUUM_ENTITY}`);
  if (!state.ok) return { ok: false, output: `Cannot reach the vacuum: ${state.output}` };

  const rooms = roomsOnSingleMap(state.data.attributes?.rooms);
  if (!rooms) return { ok: false, output: 'I cannot tell which map is active, so I will not start a room clean, Sir.' };

  const room = findRoom(rooms, name);
  if (!room) {
    const known = rooms.map((r) => r.name).join(', ');
    return { ok: false, output: `I don't know a room called "${String(name || '').trim()}", Sir. The rooms are: ${known}.` };
  }

  const res = await fetchHA('services/dreame_vacuum/vacuum_clean_segment', 'POST', {
    entity_id: VACUUM_ENTITY,
    segments: room.id,
  });
  if (!res.ok) return { ok: false, output: `Could not start the ${room.name} clean: ${res.output}` };
  return { ok: true, output: `Sent the vacuum to clean the ${room.name}, Sir. Check the vacuum to confirm it started.` };
}
