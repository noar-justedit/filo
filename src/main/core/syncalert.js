'use strict';
// LIVE SYNC down: when to send the phone alert (Noar, 12/10/2026). Pure: the
// caller gives the sessions with their status and the time, gets back the
// alerts to send ('down' once a session failed for `limitMs`, 'up' when one
// that was announced down works again).

// Why a connected session cannot work right now, or '' when it can.
function reason(p, st) {
  st = st || {};
  const peer = String((p.peer && p.peer.name) || 'the remote computer').split(' · ')[0];
  if (p.via === 'server') return p.auto && st.state === 'error' ? `server: ${st.error || 'error'}` : '';
  if (p.auto) {
    if (st.state === 'error') return st.error || 'SYNCTHING error';
    if (p.peer && st.peer && !st.peer.connected && !['starting', 'waiting', 'paused'].includes(st.state)) return `${peer} not reachable`;
  }
  if (p.via === 'hybrid' && p.fsAuto && st.server && st.server.state === 'error') return `S-FTP BACKUP: ${st.server.error || 'error'}`;
  return '';
}

class SyncAlert {
  constructor() { this.down = {}; }   // pairId → { since, reason, alerted }
  // list: [{ pair, status }]. Returns [{ kind: 'down'|'up', pair, reason, minutes }].
  step(list, now, limitMs, on) {
    const out = [], seen = new Set();
    for (const { pair, status } of list) {
      seen.add(pair.id);
      const why = reason(pair, status), d = this.down[pair.id];
      if (why) {
        if (!d) { this.down[pair.id] = { since: now, reason: why, alerted: false }; continue; }
        d.reason = why;
        if (on && !d.alerted && now - d.since >= limitMs) { d.alerted = true; out.push({ kind: 'down', pair, reason: why, minutes: Math.round((now - d.since) / 60000) }); }
      } else if (d) {
        delete this.down[pair.id];
        if (on && d.alerted) out.push({ kind: 'up', pair, reason: d.reason, minutes: Math.round((now - d.since) / 60000) });
      }
    }
    for (const id of Object.keys(this.down)) if (!seen.has(id)) delete this.down[id];
    return out;
  }
}

module.exports = { reason, SyncAlert };
