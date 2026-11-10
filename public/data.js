// Every Supabase RPC call of the pages, with the shape the pages expect. No DOM access here.
import { rpc } from './auth.js';
import { ApiError } from './ui.js';

// An answer without the expected shape is an upstream error, never a half drawn page.
function shaped(ok, data) {
  if (!ok) throw new ApiError(0, 'upstream_error');
  return data;
}

function requestsOf(data) {
  return shaped(data !== null && typeof data === 'object' && Array.isArray(data.requests), data).requests;
}

function rowsOf(data) {
  return shaped(Array.isArray(data), data);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function overviewOf(data) {
  const ok =
    isObject(data) &&
    isObject(data.sync) &&
    isObject(data.sync.requested) &&
    isObject(data.sync.requested.sync) &&
    isObject(data.sync.requested.discover) &&
    isObject(data.proposals) &&
    Array.isArray(data.proposals.items) &&
    Array.isArray(data.proposals.failures) &&
    ['calendars', 'sources', 'rooms', 'unmatchedBuildings', 'campus'].every((key) => Array.isArray(data[key])) &&
    isObject(data.buildingLinks) &&
    isObject(data.shapes);
  return shaped(ok, data);
}

export function reportRoom(roomId, kind, extra = {}) {
  return rpc('report_room', { p_room_id: roomId, p_kind: kind, p_category: extra.category ?? null, p_lesson_id: extra.lessonId ?? null });
}

export async function myRequests() {
  return requestsOf(await rpc('my_requests'));
}

export async function whoamiRole() {
  const rows = await rpc('whoami');
  return Array.isArray(rows) && rows[0] ? rows[0].role : null;
}

export const admin = Object.freeze({
  pending: async () => requestsOf(await rpc('pending_requests')),
  overview: async () => overviewOf(await rpc('admin_overview')),
  staff: async () =>
    rowsOf(await rpc('list_staff')).map((u) => ({
      userId: u.user_id,
      email: u.email,
      role: u.role,
      lastSignInAt: u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : null,
    })),
  // The mail goes in the POST body, never in a URL.
  findUser: async (email) => {
    const rows = rowsOf(await rpc('find_user', { p_email: String(email).trim().toLowerCase() }));
    return rows[0] ? { userId: rows[0].user_id, email: rows[0].email, role: rows[0].role } : null;
  },
  setRole: (userId, role) => rpc('set_user_role', { target: userId, new_role: role }),
  review: (id, decision) => rpc('review_request', { p_id: id, p_decision: decision }),
  requestSync: () => rpc('admin_request_sync'),
  requestDiscover: () => rpc('admin_request_discover'),
  addCalendar: (id, label) => rpc('admin_add_calendar', { p_id: id, p_label: label }),
  addFeed: (source, ref, label) => rpc('admin_add_feed', { p_source: source, p_ref: ref, p_label: label }),
  setCalendarActive: (id, active) => rpc('admin_set_calendar_active', { p_id: id, p_active: active }),
  removeCalendar: (id) => rpc('admin_remove_calendar', { p_id: id }),
  setSources: (urls) => rpc('admin_set_sources', { p_urls: urls }),
  setRoomFloor: (roomId, floor) => rpc('admin_set_room_floor', { p_room_id: roomId, p_floor: floor }),
  setRoomBridge: (roomId, bridge) => rpc('admin_set_room_bridge', { p_room_id: roomId, p_bridge: bridge }),
  setBuildingShape: (key, floors, baseLevel) => rpc('admin_set_building_shape', { p_key: key, p_floors: floors, p_base_level: baseLevel }),
  linkBuilding: (name, key) => rpc('admin_link_building', { p_name: name.trim(), p_key: key }),
});
