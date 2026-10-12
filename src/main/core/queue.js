/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The transfer queue.
//
// Work runs on "lanes" (core/lane.js): one connection each, in its own worker
// thread, opened when needed, reused from one file to the next, closed when
// idle. How many run at once is the "simultaneous transfers" setting — a
// number, or Auto (core/autotune.js).
//
// The unit of work is not always a file. A large file over SFTP is split into
// segments (core/transfer.js, "Segments"), and every free lane takes the next
// segment of a file already started before starting a new file — so one 60 GB
// clip uses every connection, and finishes first.
//
// An item that fails because the connection broke waits, then starts again on
// a fresh connection FROM WHERE IT STOPPED (.filopart, finished segments). An
// item that fails for a reason a retry cannot fix (refused password, no
// permission, disk full) fails at once.
//
// Pause aborts what is running and keeps the partial files: Start resumes
// them. The queue is saved to disk as it changes, so quitting filo — or a
// crash, or a power cut — loses nothing but the last few seconds.
//
// No Electron in here: the main process gives it a way to get a connection's
// credentials, the settings, a logger and a store, and listens to its events.

const EventEmitter = require('events');
const path = require('path');
const posix = path.posix;
const { dropPart } = require('./transfer');
const { RemoteError } = require('./errors');
const { AutoTuner, SEGMENT_START, SEGMENT_UP_START } = require('./autotune');
const { createLane } = require('./lane');

const RETRY_DELAYS_S = [5, 15, 30, 60, 120];
const IDLE_CLOSE_MS = 20000;
const PROGRESS_MS = 300;
const KEEP_FINISHED = 5000;

const ACTIVE = new Set(['running', 'asking']);
const PENDING = new Set(['queued', 'waiting']);
// Held by the user: 'paused' stays in the Queue tab and is not scheduled;
// 'stopped' goes to the Failed tab. Both keep their partial files, so Resume
// and Retry continue where the transfer was.
const HELD = new Set(['paused']);

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

class TransferQueue extends EventEmitter {
  // opts: { getEndpoint(id) → Promise<endpoint>, settings() → object, log(level, msg),
  //         store: { load() → array|null, save(array) }, endpointCap(id) → number,
  //         laneMode: 'worker' | 'inline', remember(kind, host, port, fp) }
  constructor(opts) {
    super();
    this.opts = opts;
    this.items = new Map();
    this.order = [];
    this.lanes = [];
    this.units = new Set();
    this.state = 'stopped';
    this.sessionRules = {};          // 'up' / 'down' → rule chosen with "apply to all"
    this.asks = new Map();
    this.blocked = null;
    this.tuner = null;
    this.speedSamples = [];
    this.run = null;
    this._saveTimer = null;
    this._progressTimer = null;
    this._idleTimer = setInterval(() => this._closeIdle(), 5000);
    if (this._idleTimer.unref) this._idleTimer.unref();
    this._load();
  }

  settings() { return this.opts.settings(); }
  log(level, msg) { try { this.opts.log(level, msg); } catch (_) {} }
  get active() { return this.units.size; }

  // ── Content ─────────────────────────────────────────────────────────────
  // spec: { dir: 'up'|'down', type: 'file'|'folder', local, remote, size,
  //         endpointId, endpointLabel, existing }
  // The same file again (same direction, server, local and remote path):
  //  - still in the queue (waiting, running, paused): not added twice — two
  //    items would write the same partial file at once;
  //  - stopped / failed / skipped: that item comes back, with what it already
  //    transferred. One that had started is returned in `revived` and left
  //    as it is: the window asks "resume or start again?" and retries it.
  // Before 0.3.0, adding it again made a new item that knew nothing of the
  // partial file and started again from zero, without a word.
  //
  // Two DIFFERENT files for the same destination (two "C0001.MP4" from two
  // cards into one folder) are not both queued: they would write the same
  // partial file at once, and one would replace the other. The second is
  // counted in `conflict` and left out.
  add(specs, opts) {
    const added = [], revived = [];
    let already = 0, conflict = 0;
    const keyOf = x => `${x.dir}|${x.endpointId}|${x.local}|${x.remote}`;
    const caseless = process.platform === 'darwin' || process.platform === 'win32';
    const destOf = x => (x.dir === 'down' ? `down|${caseless ? x.local.toLowerCase() : x.local}` : `up|${x.endpointId}|${x.remote}`);
    const same = new Map(), dest = new Map();
    for (const it of this.items.values()) {
      if (it.type !== 'file' || it.removed) continue;
      if (it.status !== 'done') same.set(keyOf(it), it);
      if (it.status !== 'done' && it.status !== 'skipped') dest.set(destOf(it), it);
    }
    const retryNow = [];
    for (const s of specs) {
      if (s.type !== 'folder') {
        const norm = { dir: s.dir === 'down' ? 'down' : 'up', endpointId: s.endpointId, local: String(s.local), remote: String(s.remote) };
        const old = same.get(keyOf(norm));
        const other = dest.get(destOf(norm));
        if (!old && other) { conflict++; continue; }
        if (old) {
          if (PENDING.has(old.status) || ACTIVE.has(old.status) || HELD.has(old.status) || this._unitsOf(old).length) { already++; continue; }
          if (Number(s.size)) old.size = Number(s.size);
          if (s.existing) old.existing = s.existing;
          const bytes = Math.max(old.done || 0, old.offset || 0);
          if (bytes > 0 || old.seg) revived.push({ id: old.id, bytes, name: displayName(old) });
          else retryNow.push(old.id);
          continue;
        }
      }
      const it = {
        id: newId(),
        dir: s.dir === 'down' ? 'down' : 'up',
        type: s.type === 'folder' ? 'folder' : 'file',
        local: String(s.local),
        remote: String(s.remote),
        size: Number(s.size) || 0,
        endpointId: s.endpointId,
        endpointLabel: s.endpointLabel || '',
        existing: s.existing || null,
        // LIVE SYNC: which pair and which relative path this item serves.
        sync: s.sync && typeof s.sync === 'object' ? { pairId: String(s.sync.pairId), rel: String(s.sync.rel) } : undefined,
        // Segment relay: an upload that announces its segments (relayOut),
        // or a download that takes them as they are announced (relay).
        relayOut: s.relayOut ? true : undefined,
        relay: s.relay && typeof s.relay === 'object' ? cleanRelay(s.relay) : undefined,
        status: 'queued',
        done: 0,
        attempts: 0,
        error: '',
        addedAt: Date.now(),
      };
      this.items.set(it.id, it);
      if (it.type === 'file') { same.set(keyOf(it), it); dest.set(destOf(it), it); }
      added.push(it.id);
    }
    if (opts && opts.front) {
      const firstPending = this.order.findIndex(id => PENDING.has((this.items.get(id) || {}).status));
      this.order.splice(firstPending < 0 ? this.order.length : firstPending, 0, ...added);
    } else this.order.push(...added);
    if (retryNow.length) this.retry(retryNow);
    this._changed();
    if (this.state === 'running') this._pump();
    added.revived = revived;
    added.already = already;
    added.conflict = conflict;
    added.queued = added.length + retryNow.length;   // what this call put in the queue
    return added;
  }

  get(id) { return this.items.get(id); }

  // Segment relay, receiving side: what the sender has announced so far
  // (o: { endpointId, endpointLabel, local, remote, sync, relay: { id, size,
  // mtime, segSize, count, part, hashes: { index: xxh64 }, final } }).
  // Creates the download the first time, then wakes the segments that
  // became available. Returns the item.
  relayOffer(o) {
    const key = it => `${it.endpointId}|${it.local}|${it.remote}`;
    const want = `${o.endpointId}|${o.local}|${o.remote}`;
    let it = [...this.items.values()].find(x => x.dir === 'down' && x.type === 'file' && !x.removed && x.status !== 'done' && key(x) === want);
    const r = cleanRelay(o.relay);
    if (it && it.relay && it.relay.id !== r.id && !this._unitsOf(it).length) { this.remove([it.id]); it = null; }   // the sender started again
    if (!it) {
      const ids = this.add([{ dir: 'down', type: 'file', local: o.local, remote: o.remote, size: r.size, endpointId: o.endpointId, endpointLabel: o.endpointLabel, existing: 'skip', sync: o.sync, relay: r }]);
      it = ids.length ? this.items.get(ids[0]) : null;
      if (this.state === 'stopped' && it) this.start();
      return it;
    }
    if (!it.relay || it.relay.id !== r.id) return it;          // still letting go of an earlier attempt
    it.relay.hashes = Object.assign({}, it.relay.hashes, r.hashes);
    if (r.final) it.relay.final = true;
    if (it.seg && it.seg.relayId === r.id) {
      for (let i = 0; i < it.seg.chunks.length; i++) {
        const c = it.seg.chunks[i], h = it.relay.hashes[i];
        if (h && !c.hash) c.hash = h;
        if (c.st === 'w' && (h || it.relay.final)) c.st = 'p';
      }
    }
    if (['failed', 'stopped'].includes(it.status) && !this._unitsOf(it).length) this.retry([it.id], 'resume');
    this._changed();
    if (this.state === 'running') this._pump();
    else if (this.state === 'stopped') this.start();
    return it;
  }

  counts() {
    const c = { queued: 0, running: 0, waiting: 0, asking: 0, paused: 0, done: 0, failed: 0, stopped: 0, skipped: 0, total: 0, bytesLeft: 0 };
    for (const it of this.items.values()) {
      c[it.status] = (c[it.status] || 0) + 1;
      c.total++;
      if (PENDING.has(it.status) || ACTIVE.has(it.status) || HELD.has(it.status)) c.bytesLeft += Math.max(0, (it.size || 0) - (it.done || 0));
    }
    return c;
  }

  // tab: 'queue' (queued, running, waiting, asking) | 'failed' | 'done' (done + skipped)
  page(tab, offset, limit) {
    const want = tab === 'failed' ? s => s === 'failed' || s === 'stopped'
      : tab === 'done' ? s => s === 'done' || s === 'skipped'
      : s => PENDING.has(s) || ACTIVE.has(s) || HELD.has(s);
    const ids = this.order.filter(id => { const it = this.items.get(id); return it && want(it.status); });
    if (tab === 'queue') ids.sort((a, b) => (ACTIVE.has(this.items.get(b).status) ? 1 : 0) - (ACTIVE.has(this.items.get(a).status) ? 1 : 0));
    if (tab === 'done') ids.reverse();
    const o = Math.max(0, offset || 0);
    return { total: ids.length, items: ids.slice(o, o + (limit || 200)).map(id => this._public(this.items.get(id))) };
  }

  _public(it) {
    let segs = null;
    if (it.seg && it.seg.chunks) {
      const ch = it.seg.chunks;
      segs = { total: ch.length, done: ch.filter(c => c.st === 'd').length, running: ch.filter(c => c.st === 'r').length, cells: this._segCells(it) };
    }
    return {
      id: it.id, dir: it.dir, type: it.type, local: it.local, remote: it.remote,
      size: it.size, done: it.done || 0, status: it.status, error: it.error || '',
      note: it.note || '', verify: it.verify || null, attempts: it.attempts || 0,
      phase: it.phase || '', vdone: it.vdone || 0, speed: it.speed || 0,
      endpointLabel: it.endpointLabel, retryAt: it.retryAt || 0, offset: it.offset || 0, segs,
      addedAt: it.addedAt || 0, startedAt: it.startedAt || 0, finishedAt: it.finishedAt || 0,
    };
  }

  // Every segment of a segmented file, for the piece bar of the window (the
  // way qBittorrent draws a torrent's pieces): `st` one letter per segment —
  // d done and verified, r on its way, w waiting to be tried again, p to do —
  // and `f` how much of each is in place, one character per segment
  // (code 48 + 0..100 %). Compact on purpose: a 300 GB file is ~1,200
  // segments, sent several times a second.
  _segCells(it) {
    const ch = it.seg.chunks, now = Date.now();
    const live = new Map();
    for (const u of this.units) if (u.it === it && u.kind === 'seg') live.set(u.idx, u.bytes || 0);
    let st = '', f = '';
    ch.forEach((c, i) => {
      const len = c.e - c.s || 1;
      if (c.st === 'd') { st += 'd'; f += String.fromCharCode(148); return; }
      const got = (Number(c.got) || 0) + (live.get(i) || 0);
      st += c.st === 'r' ? 'r' : c.st === 'w' || (c.retryAt && c.retryAt > now) ? 'w' : 'p';
      f += String.fromCharCode(48 + Math.max(0, Math.min(100, Math.floor((got / len) * 100))));
    });
    return { n: ch.length, segSize: ch.length > 1 ? ch[0].e - ch[0].s : (ch[0] ? ch[0].e : 0), size: it.seg.size || it.size, st, f };
  }

  remove(ids) {
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it) continue;
      if (this._unitsOf(it).length) { it.removed = true; this._abortItem(it); continue; }
      if (it.status !== 'done' && it.status !== 'skipped' && it.type === 'file') dropPart(it, null);
      this.items.delete(id);
    }
    this.order = this.order.filter(id => this.items.has(id));
    this._changed();
  }

  clear(tab) {
    const drop = [];
    for (const it of this.items.values()) {
      if (tab === 'done' && (it.status === 'done' || it.status === 'skipped')) drop.push(it.id);
      if (tab === 'failed' && (it.status === 'failed' || it.status === 'stopped')) drop.push(it.id);
      if (tab === 'queue' && (PENDING.has(it.status) || ACTIVE.has(it.status) || HELD.has(it.status))) drop.push(it.id);
    }
    this.remove(drop);
  }

  // mode 'restart': the partial file is not continued; the file starts again
  // from zero (the partial one is overwritten). Otherwise a retry resumes.
  retry(ids, mode) {
    const list = ids && ids.length ? ids : [...this.items.values()].filter(i => i.status === 'failed' || i.status === 'stopped').map(i => i.id);
    for (const id of list) {
      const it = this.items.get(id);
      if (!it || !['failed', 'skipped', 'stopped', 'paused'].includes(it.status)) continue;
      // Some of its connections are still letting go (a segmented file that
      // just failed): retried as soon as the last one has ended, so the old
      // units never write into the new attempt.
      if (this._unitsOf(it).length) { it._pendingRetry = mode || 'resume'; continue; }
      // Failed during the run still going on: no longer counted as failed (the
      // end summary would say "1 failed" and skip the end action for nothing).
      if (it.status === 'failed' && it.type === 'file' && this.state === 'running' && this.run && (it.finishedAt || 0) >= this.run.startedAt) this.run.failed = Math.max(0, this.run.failed - 1);
      it._hold = null;
      it.status = 'queued'; it.error = ''; it.attempts = 0; it.retryAt = 0;
      if (it.seg) for (const c of it.seg.chunks) { c.attempts = 0; c.retryAt = 0; if (c.st === 'r') c.st = 'p'; }
      if (it.mismatchCount) it.restartFromZero = true;
      // Only a file that had started: its "already there" question was answered
      // then. One that never started goes through it as usual.
      const started = (it.done || 0) > 0 || (it.offset || 0) > 0 || !!it.seg;
      if (mode === 'restart' && it.type === 'file' && started) { it.restartFromZero = true; it.seg = null; it.offset = 0; it.done = 0; }
    }
    this._changed();
    if (this.state === 'running') this._pump();
  }

  // ── One item at a time: pause, resume, stop ────────────────────────────
  // What is running is aborted; the partial file stays, so Resume / Retry
  // continue from where it was (finished segments included).
  _hold(ids, status) {
    for (const id of ids || []) {
      const it = this.items.get(id);
      if (!it) continue;
      const live = ACTIVE.has(it.status) || this._unitsOf(it).length;
      if (!live && !PENDING.has(it.status) && !(status === 'stopped' && it.status === 'paused')) continue;
      if (live && this._unitsOf(it).length) { it._hold = status; this._abortItem(it); }
      else { it.status = status; it.phase = ''; it._hold = null; }
      if (status === 'stopped') { it.error = 'Stopped'; it.finishedAt = Date.now(); }
    }
    this._changed();
    setImmediate(() => { this._pump(); this._checkFinished(); });
  }
  pauseItems(ids) { this._hold(ids, 'paused'); }
  stopItems(ids) { this._hold(ids, 'stopped'); }
  resumeItems(ids) {
    let any = false;
    for (const id of ids || []) {
      const it = this.items.get(id);
      if (!it || it.status !== 'paused') continue;
      it.status = 'queued'; it._hold = null; any = true;
    }
    this._changed();
    if (any) this.start();
  }
  // The whole queue: everything still to do is stopped (to the Failed tab,
  // retryable), and the queue stops.
  stopAll() {
    const ids = [...this.items.values()].filter(it => PENDING.has(it.status) || ACTIVE.has(it.status) || HELD.has(it.status) || this._unitsOf(it).length).map(it => it.id);
    this._hold(ids, 'stopped');
    this.pause();
  }

  // ── Running ─────────────────────────────────────────────────────────────
  start() {
    this.blocked = null;
    if (this.state === 'running') { this._pump(); return; }
    this.state = 'running';
    this.learnedCap = null;                       // each Start asks the server again
    const s = this.settings();
    if (!this.tuner || this.tuner.max !== this._maxLanes()) this.tuner = new AutoTuner({ max: this._maxLanes(), start: 2 });
    else this.tuner.newRun();
    this.run = { startedAt: Date.now(), done: 0, failed: 0, skipped: 0, bytes: 0, verified: 0 };
    this.sessionRules = {};
    this._startProgress();
    this.emit('state', this.state);
    this.log('info', `Queue started (${s.concurrency === 'auto' ? 'Auto' : s.concurrency} simultaneous transfers)`);
    this._pump();
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'stopped';
    for (const u of [...this.units]) this._abortUnit(u);
    // A segmented file between two segments has no unit to abort: it simply
    // goes back to the queue, its finished segments kept.
    for (const it of this.items.values()) if (it.status === 'running' && !this._unitsOf(it).length) { it.status = it._hold || 'queued'; it._hold = null; it.phase = ''; }
    for (const [id, a] of this.asks) { a.reject(Object.assign(new Error('Stopped.'), { aborted: true })); this.emit('ask-closed', id); }
    this.asks.clear();
    this._stopProgress();
    this.emit('state', this.state);
    this.log('info', 'Queue paused — partial files are kept and resumed at the next Start');
    this._changed();
  }

  // The segment this unit is working on, if it is still the one in charge.
  // A unit aborted by Pause can end after the next Start has rebuilt the
  // segment list or given the segment to another unit: it must not touch it.
  _ownSeg(u) {
    const c = u.it.seg && u.it.seg.chunks[u.idx];
    return c && c.by === u.id ? c : null;
  }

  _unitsOf(it) { return [...this.units].filter(u => u.it === it); }

  _abortUnit(u) {
    u.aborted = true;
    // u.lane is the pool's record; the connection itself is u.lane.impl.
    if (u.lane) { try { u.lane.impl.abort(); } catch (_) {} u.lane.dead = true; }
    this._dropAsk(u);
  }

  // The question of a unit that is going away: answered "stopped", and the
  // window closed in the interface (an answer to it would go nowhere).
  _dropAsk(u) {
    if (!u.askId || !this.asks.has(u.askId)) return;
    const id = u.askId, a = this.asks.get(id);
    this.asks.delete(id);
    u.askId = null;
    a.reject(Object.assign(new Error('Stopped.'), { aborted: true }));
    this.emit('ask-closed', id);
  }

  // When the last unit of a file is gone: apply what the user asked for
  // (pause / stop of that file), or put it back in the queue after a Pause.
  // Several units of one file end at the same moment, so this cannot be
  // decided inside each unit's own failure handler.
  _settle(it) {
    if (!it || this._unitsOf(it).length) return;
    // Removed while it ran: whatever its last unit answered (even "done" or
    // "segmented", when the removal came after the last network call), it goes.
    if (it.removed) {
      if (this.items.has(it.id)) {
        this.items.delete(it.id);
        this.order = this.order.filter(x => x !== it.id);
        if (it.type === 'file' && it.status !== 'done' && it.status !== 'skipped') dropPart(it, null);
      }
      return;
    }
    if (it.status !== 'running') return;
    if (it._hold) {
      it.status = it._hold; it.phase = '';
      if (it._hold === 'stopped') { it.error = 'Stopped'; it.finishedAt = Date.now(); }
      it._hold = null;
    } else if (this.state !== 'running') { it.status = 'queued'; it.phase = ''; }
  }

  _abortItem(it) { for (const u of this._unitsOf(it)) this._abortUnit(u); }

  _maxLanes() {
    const s = this.settings();
    return s.concurrency === 'auto' ? Math.max(1, Math.min(10, Number(s.autoMax) || 10)) : Math.max(1, Math.min(10, Number(s.concurrency) || 2));
  }

  limit() {
    const s = this.settings();
    if (s.concurrency === 'auto') {
      if (!this.tuner) this.tuner = new AutoTuner({ max: this._maxLanes(), start: 2 });
      this.tuner.setMax(this._maxLanes());
      return this.tuner.limit();
    }
    return this._maxLanes();
  }

  _activeFor(endpointId) { let n = 0; for (const u of this.units) if (u.it.endpointId === endpointId) n++; return n; }

  _capFor(endpointId) {
    const c = this.opts.endpointCap ? Number(this.opts.endpointCap(endpointId)) || 0 : 0;
    // What the server itself refused during this run counts too, in Auto and
    // in a fixed setting alike: asking again at once would only be refused
    // again, in a loop (and some servers ban an address that does that).
    const learned = this.learnedCap && this.learnedCap.get(endpointId);
    return Math.min(c > 0 ? c : Infinity, learned || Infinity);
  }

  // What to start next. Segments of files already started come first: a file
  // finishes sooner, and its finished part is safe sooner.
  _nextUnit() {
    const now = Date.now();
    const full = new Map();
    const isFull = ep => { let f = full.get(ep); if (f === undefined) { f = this._activeFor(ep) >= this._capFor(ep); full.set(ep, f); } return f; };
    for (const id of this.order) {
      const it = this.items.get(id);
      if (!it || it.status !== 'running' || !it.seg || it.removed || it._hold || isFull(it.endpointId)) continue;
      // While the file itself is being (re)prepared, its segment list is
      // about to be replaced: nothing from it starts yet.
      if (this._unitsOf(it).some(x => x.kind === 'item')) continue;
      const ch = it.seg.chunks;
      const idx = ch.findIndex(c => c.st === 'p' && (!c.retryAt || c.retryAt <= now));
      if (idx >= 0) {
        if (this.tuner && !this.tuner.boosted && this.settings().concurrency === 'auto') {
          if (it.dir === 'up' ? this.tuner.startLow(SEGMENT_UP_START) : this.tuner.boost(SEGMENT_START)) {
            this.log('info', it.dir === 'up'
              ? `Auto: ${this.tuner.limit()} transfer at a time (a file sent in segments: more only if it is faster)`
              : `Auto: ${this.tuner.limit()} simultaneous transfers (a file in segments)`);
          }
        }
        return { kind: 'seg', it, idx };
      }
      // A relayed file is only finished once the sender has given it its name.
      if (!it._finalizing && ch.every(c => c.st === 'd') && (!it.relay || it.relay.final) && !this._unitsOf(it).length) return { kind: 'final', it };
    }
    for (const id of this.order) {
      const it = this.items.get(id);
      if (!it) continue;
      if (it.status !== 'queued' && !(it.status === 'waiting' && it.retryAt <= now)) continue;
      if (it._hold || isFull(it.endpointId)) continue;
      return { kind: 'item', it };
    }
    return null;
  }

  _pump() {
    if (this.state !== 'running' || this._pumping) return;
    this._pumping = true;
    try {
      while (this.state === 'running' && this.units.size < this.limit()) {
        const next = this._nextUnit();
        if (!next) break;
        const u = Object.assign({ id: newId(), bytes: 0, phase: 'connect', lane: null, aborted: false }, next);
        this.units.add(u);
        if (u.kind === 'item') { u.it.status = 'running'; u.it.phase = 'connect'; }
        if (u.kind === 'seg') { const c = u.it.seg.chunks[u.idx]; c.st = 'r'; c.by = u.id; }
        if (u.kind === 'final') u.it._finalizing = true;
        this._runUnit(u).catch(e => this.log('error', `Internal error: ${e && e.stack || e}`)).finally(() => {
          this.units.delete(u);
          this._settle(u.it);
          if (u.it._pendingRetry && !this._unitsOf(u.it).length) {
            const m = u.it._pendingRetry;
            u.it._pendingRetry = null;
            this.retry([u.it.id], m);
          }
          this._rebalanceRates();
          this._changed();
          setImmediate(() => { this._pump(); this._checkFinished(); });
        });
      }
    } finally { this._pumping = false; }
    this._scheduleWaiting();
    this._checkFinished();
  }

  // One timer for the soonest retry; a sooner one brings it forward.
  _scheduleWaiting() {
    let soonest = Infinity;
    for (const it of this.items.values()) {
      if (it.status === 'waiting') soonest = Math.min(soonest, it.retryAt);
      if (it.status === 'running' && it.seg) for (const c of it.seg.chunks) if (c.st === 'p' && c.retryAt) soonest = Math.min(soonest, c.retryAt);
    }
    if (soonest === Infinity) return;
    if (this._waitTimer && this._waitAt <= soonest) return;
    if (this._waitTimer) clearTimeout(this._waitTimer);
    this._waitAt = soonest;
    this._waitTimer = setTimeout(() => { this._waitTimer = null; this._pump(); }, Math.max(200, soonest - Date.now()));
  }

  _checkFinished() {
    if (this.state !== 'running') return;
    if (this.units.size > 0) return;
    for (const it of this.items.values()) if (PENDING.has(it.status) || ACTIVE.has(it.status)) return;
    this.state = 'stopped';
    this._stopProgress();
    const r = this.run || {};
    const summary = {
      done: r.done || 0, failed: r.failed || 0, skipped: r.skipped || 0, bytes: r.bytes || 0,
      verified: r.verified || 0, durationMs: Date.now() - (r.startedAt || Date.now()),
      paused: [...this.items.values()].filter(i => i.status === 'paused').length,
      stopped: [...this.items.values()].filter(i => i.status === 'stopped' && (i.finishedAt || 0) >= (r.startedAt || 0)).length,
      errors: [...this.items.values()].filter(i => i.status === 'failed' && (i.finishedAt || 0) >= (r.startedAt || 0)).slice(0, 20).map(i => ({ name: displayName(i), message: i.error })),
      endpointLabel: [...new Set([...this.items.values()].filter(i => i.finishedAt >= (r.startedAt || 0)).map(i => i.endpointLabel))].filter(Boolean).join(', '),
    };
    // A run made only of LIVE SYNC copies: no "queue finished" notice and no
    // end action (a sync every few minutes must not shut the machine down).
    summary.syncOnly = ![...this.items.values()].some(i => i.type === 'file' && !i.sync && (i.finishedAt || 0) >= (r.startedAt || 0));
    this.log(summary.failed ? 'warn' : 'info', `Queue finished: ${summary.done} done, ${summary.failed} failed, ${summary.skipped} skipped`);
    this.emit('state', this.state);
    this.emit('finished', summary);
    this._changed();
  }

  // ── Lanes ───────────────────────────────────────────────────────────────
  async _acquireLane(endpointId) {
    let lane = this.lanes.find(l => !l.busy && !l.dead && l.endpointId === endpointId && l.impl && l.impl.alive);
    if (lane) { lane.busy = true; return lane; }
    const open = this.lanes.filter(l => !l.dead);
    if (open.length >= this.limit()) {
      const idle = open.find(l => !l.busy);
      if (idle) this._closeLane(idle);
    }
    const ep = await this.opts.getEndpoint(endpointId);
    lane = { id: newId(), endpointId, impl: createLane(ep, (lv, m) => this.log(lv, m), this.opts.laneMode), busy: true, dead: false, idleSince: 0 };
    this.lanes.push(lane);
    const sameServer = this.lanes.filter(l => l !== lane && !l.dead && l.endpointId === endpointId && l.impl.alive).length;
    try {
      await lane.impl.connect(this.opts.remember);
    } catch (e) {
      const err = RemoteError.from(e, ep.protocol);
      // One connection too many: the others to this server are fine, this one
      // was turned away. That is a limit, not a fault.
      if (sameServer > 0 && !['TRUST_NEEDED', 'NEEDS_PASSWORD', 'HOST_KEY_CHANGED'].includes(err.code) && !(err.fatal && /login|password|authentication/i.test(err.message)) && (err.network || /too many|421|max(imum)? (number of )?(connections|sessions|users)/i.test(err.raw || err.message))) {
        err.serverLimit = sameServer;
      }
      this._closeLane(lane);
      throw err;
    }
    return lane;
  }

  _releaseLane(lane) {
    if (!lane) return;
    lane.busy = false;
    lane.idleSince = Date.now();
    if (lane.dead || !lane.impl.alive) { this._closeLane(lane); return; }
    const open = this.lanes.filter(l => !l.dead);
    if (open.length > this.limit()) this._closeLane(lane);
  }

  _closeLane(lane) {
    lane.dead = true;
    try { lane.impl.close(); } catch (_) {}
    this.lanes = this.lanes.filter(l => l !== lane);
  }

  _closeIdle() {
    const now = Date.now();
    for (const l of [...this.lanes]) if (!l.busy && now - l.idleSince > IDLE_CLOSE_MS) this._closeLane(l);
  }

  closeAll() {
    for (const l of [...this.lanes]) this._closeLane(l);
    clearInterval(this._idleTimer);
    this._flushSave();
  }

  // Speed limits are per direction, shared by the lanes going that way.
  _rebalanceRates() {
    const st = this.settings();
    for (const dir of ['up', 'down']) {
      const total = (Number(dir === 'up' ? st.limitUp : st.limitDown) || 0) * 1e6;
      const us = [...this.units].filter(u => u.it.dir === dir && u.lane);
      for (const u of us) u.lane.impl.setRate(total ? total / us.length : 0);
    }
  }
  applyLimits() { this._rebalanceRates(); }

  // ── One unit ────────────────────────────────────────────────────────────
  async _runUnit(u) {
    const it = u.it;
    if (u.kind === 'item') { it.error = ''; it.vdone = 0; it.startedAt = Date.now(); }
    if (u.kind === 'item' || !it.startedAt) it.startedAt = it.startedAt || Date.now();
    this._changed();
    let lane = null;
    try {
      lane = await this._acquireLane(it.endpointId);
      u.lane = lane;
      this._rebalanceRates();
      if (u.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true });
      u.phase = 'transfer';
      if (u.kind === 'item') it.phase = 'transfer';
      const unit = { kind: u.kind, idx: u.idx, settings: this.settings(), item: plainItem(it) };
      const hooks = {
        onBytes: (n, ph) => this._onBytes(it, u, n, ph),
        ask: (src, dst) => this._ask(it, u, src, dst),
        log: (lv, m) => this.log(lv, m),
      };
      const { res, patch } = await lane.impl.run(unit, hooks);
      Object.assign(it, patch || {});
      this._unitDone(u, res);
    } catch (e) {
      const err = RemoteError.from(e);
      if (e && e.patch) Object.assign(it, e.patch);
      if (lane && (err.network || err.aborted || u.aborted)) lane.dead = true;
      this._unitFailed(u, err);
    } finally {
      this._dropAsk(u);
      this._releaseLane(lane);
      u.lane = null;
    }
  }

  _unitDone(u, res) {
    const it = u.it;
    if (u.kind === 'seg') {
      // Only the unit that owns the segment marks it (see _ownSeg).
      const c = this._ownSeg(u);
      if (c) c.st = 'd';
      if (this.tuner) this.tuner.addFile();       // a segment counts as a unit of work done
      return;
    }
    if (res.status === 'segmented') {
      // Stays "running": the segments are scheduled by _nextUnit.
      it.phase = 'transfer';
      it._finalizing = false;
      return;
    }
    it.status = res.status;
    it.note = res.note || '';
    it.verify = res.verify || null;
    it.finishedAt = Date.now();
    it.phase = '';
    it._finalizing = false;
    if (it.type === 'file') {
      if (this.tuner && u.kind === 'item') this.tuner.addFile();
      if (this.run) {
        if (res.status === 'done') { this.run.done++; if (res.verify && res.verify.level !== 'size') this.run.verified++; }
        else this.run.skipped++;
      }
      this.emit('item-done', it, res.status);
      if (res.status === 'done') {
        const v = res.verify;
        this.log('info', `✓ ${it.dir === 'up' ? 'Uploaded' : 'Downloaded'} ${it.dir === 'up' ? it.remote : it.local}${v ? ' — ' + verifyText(v) : ''}`);
      }
    }
  }

  _unitFailed(u, err) {
    const it = u.it;
    const s = this.settings();
    const retries = Math.max(0, Math.min(20, Number(s.retries == null ? 5 : s.retries)));
    const own = u.kind === 'seg' ? this._ownSeg(u) : null;
    if (u.kind === 'seg' && !own) return;                    // a late unit from before a Pause: nothing of it is current
    if (own) {
      own.st = 'p';
      // What of the segment is in place (reported by the segment as it
      // stopped) stays; the rest is sent again. A wrong checksum starts the
      // whole segment over.
      // A segment that failed before it could say what it holds (during its
      // connection, say) keeps what was known to be in place before.
      const before = Number(own.got) || 0;
      const kept = err.mismatch ? 0 : u.keep == null ? before : Math.max(before, Math.min(own.e - own.s, u.keep));
      own.got = kept;
      it.done = Math.max(0, (it.done || 0) - u.bytes + (kept - before));
    }
    if (u.kind === 'final') it._finalizing = false;
    if (it.status === 'failed') return;                      // another unit of the item already failed it

    // Stopped by Pause, or by removal.
    if (u.aborted || err.aborted) {
      if (!this._unitsOf(it).filter(x => x !== u).length) {
        it.phase = '';
        if (it.removed) {
          this.items.delete(it.id); this.order = this.order.filter(x => x !== it.id);
          if (it.type === 'file') dropPart(it, null);
          return;
        }
        if (it._hold) {
          it.status = it._hold;
          if (it._hold === 'stopped') { it.error = 'Stopped'; it.finishedAt = Date.now(); }
          it._hold = null;
        } else if (this.state !== 'running' || u.kind !== 'seg') it.status = 'queued';
      }
      return;
    }

    // Nothing for this server can work until someone acts.
    if (err.code === 'TRUST_NEEDED' || err.code === 'NEEDS_PASSWORD' || err.code === 'HOST_KEY_CHANGED' || (err.fatal && /login|password|authentication/i.test(err.message) && u.phase === 'connect')) {
      if (u.kind === 'item') { it.status = 'queued'; it.phase = ''; }
      this.blocked = { endpointId: it.endpointId, endpointLabel: it.endpointLabel, code: err.code || 'AUTH', message: err.message, trust: err.trust || null };
      this.log('error', `${it.endpointLabel}: ${err.message}`);
      this.pause();
      this.emit('blocked', this.blocked);
      return;
    }

    if (err.serverLimit) {
      if (u.kind === 'item') { it.status = 'queued'; it.phase = ''; }
      if (this.tuner) this.tuner.serverRefused(err.serverLimit);
      if (!this.learnedCap) this.learnedCap = new Map();
      this.learnedCap.set(it.endpointId, Math.min(err.serverLimit, this.learnedCap.get(it.endpointId) || Infinity));
      this.log('warn', `${it.endpointLabel} refused connection #${err.serverLimit + 1}: staying at ${err.serverLimit}.`);
      return;
    }

    const retryable = !err.fatal && (err.network || err.mismatch);

    // One segment failed: that segment waits and goes again; the file goes on.
    if (u.kind === 'seg' && retryable) {
      const c = own;
      c.attempts = (c.attempts || 0) + 1;
      if (err.mismatch) it.mismatchCount = (it.mismatchCount || 0) + 1;
      if (c.attempts <= retries) {
        const delay = RETRY_DELAYS_S[Math.min(c.attempts - 1, RETRY_DELAYS_S.length - 1)];
        c.retryAt = Date.now() + delay * 1000;
        this.log('warn', `${displayName(it)}, segment ${u.idx + 1}: ${err.message} — again in ${delay} s (${c.attempts}/${retries})`);
        return;
      }
    }

    // The whole item.
    if (u.kind === 'seg') this._abortItem(it);
    it.attempts = (it.attempts || 0) + 1;
    if (err.mismatch) {
      it.mismatchCount = (it.mismatchCount || 0) + 1;
      // A whole-file mismatch after segments, or after a resume: from zero.
      if (u.kind !== 'seg' && (err.resumed || !it.seg)) { it.restartFromZero = true; if (it.seg && err.resumed) it.seg = null; }
    }
    if (retryable && it.attempts <= retries && u.kind !== 'seg') {
      const delay = RETRY_DELAYS_S[Math.min(it.attempts - 1, RETRY_DELAYS_S.length - 1)];
      it.status = 'waiting';
      it.retryAt = Date.now() + delay * 1000;
      it.error = err.message;
      it.phase = '';
      this.log('warn', `${displayName(it)}: ${err.message} — new attempt in ${delay} s (${it.attempts}/${retries})`);
    } else {
      it.status = 'failed';
      it.error = err.message;
      it.phase = '';
      it.finishedAt = Date.now();
      if (this.run && it.type === 'file') this.run.failed++;
      this.log('error', `✗ ${displayName(it)}: ${err.message}`);
    }
  }

  _onBytes(it, u, n, phase) {
    if (phase === 'resume') { it.done = n; return; }
    if (phase === 'segkeep') { u.keep = n; return; }
    if (phase === 'transfer') {
      it.done = (it.done || 0) + n;
      u.bytes += n;
      const now = Date.now();
      this.speedSamples.push([now, n]);
      if (this.tuner) this.tuner.addBytes(n, now);
      if (this.run) this.run.bytes += n;
      it._samples = it._samples || [];
      it._samples.push([now, n]);
      return;
    }
    if (phase === 'verify-start') { it.phase = 'verify'; u.phase = 'verify'; it.vdone = 0; this._changed(); return; }
    if (phase === 'verify' || phase === 'verify-local') it.vdone = (it.vdone || 0) + n;
  }

  // ── "The file is already there" ─────────────────────────────────────────
  _ask(it, u, src, dst) {
    const rule = this.sessionRules[it.dir];
    if (rule) return Promise.resolve(rule);
    return new Promise((resolve, reject) => {
      const askId = newId();
      it.status = 'asking';
      u.askId = askId;
      this.asks.set(askId, { resolve, reject, dir: it.dir, itemId: it.id });
      this._changed();
      this.emit('ask', {
        askId, dir: it.dir,
        name: displayName(it),
        target: it.dir === 'up' ? it.remote : it.local,
        src: { size: src.size, mtime: src.mtime },
        dst: { size: dst.size, mtime: dst.mtime },
      });
    }).then(r => {
      // A late answer (the unit already ended: worker crash, stop) changes nothing.
      if (it.status === 'asking' && this.units.has(u)) it.status = 'running';
      u.askId = null; this._changed(); return r;
    });
  }

  answer(askId, rule, applyToAll) {
    const a = this.asks.get(askId);
    if (!a) return false;
    this.asks.delete(askId);
    if (applyToAll) {
      this.sessionRules[a.dir] = rule;
      for (const [id, other] of [...this.asks]) {
        if (other.dir === a.dir) { this.asks.delete(id); other.resolve(rule); this.emit('ask-closed', id); }
      }
    }
    a.resolve(rule);
    return true;
  }

  // ── Progress ────────────────────────────────────────────────────────────
  _startProgress() {
    this._stopProgress();
    this._progressTimer = setInterval(() => this._progress(), PROGRESS_MS);
  }

  _stopProgress() {
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = null;
    this._progress();
  }

  speed(windowMs) {
    const now = Date.now();
    const w = windowMs || 3000;
    this.speedSamples = this.speedSamples.filter(s => now - s[0] <= w);
    const bytes = this.speedSamples.reduce((a, s) => a + s[1], 0);
    return bytes / (w / 1000);
  }

  _progress() {
    const now = Date.now();
    const busy = [...this.units].filter(u => u.phase === 'transfer').length;
    let queuedLeft = 0;
    for (const it of this.items.values()) {
      if (PENDING.has(it.status)) queuedLeft++;
      else if (it.status === 'running' && it.seg) queuedLeft += it.seg.chunks.filter(c => c.st === 'p').length;
    }
    if (this.state === 'running' && this.tuner && this.settings().concurrency === 'auto') {
      const before = this.tuner.limit();
      if (this.tuner.tick(busy, queuedLeft, now)) {
        const after = this.tuner.limit();
        this.log('info', `Auto: ${after} simultaneous transfer${after > 1 ? 's' : ''} (${this.tuner.note})`);
        if (after > before) this._pump();
      }
    }
    const active = [];
    for (const it of this.items.values()) {
      if (!ACTIVE.has(it.status)) continue;
      if (it._samples) {
        it._samples = it._samples.filter(s => now - s[0] <= 3000);
        const el = Math.min(3, Math.max(0.3, (now - (it.startedAt || now)) / 1000));
        it.speed = it._samples.reduce((a, s) => a + s[1], 0) / el;
      }
      active.push(this._public(it));
    }
    const c = this.counts();
    const sp = this.speed();
    this.emit('progress', {
      state: this.state,
      active,
      counts: c,
      speed: sp,
      eta: sp > 0 ? c.bytesLeft / sp : 0,
      run: this.run ? { bytes: this.run.bytes, done: this.run.done, failed: this.run.failed, startedAt: this.run.startedAt } : null,
      auto: this.settings().concurrency === 'auto' && this.tuner ? { level: this.tuner.limit(), note: this.tuner.note } : null,
      lanes: this.lanes.filter(l => !l.dead).length,
      units: this.units.size,
    });
    // Segment progress is worth saving while it runs: a crash then loses at
    // most the segments in flight.
    if (this.state === 'running' && now - (this._lastSave || 0) > 5000) this._changed();
  }

  // ── Persistence ─────────────────────────────────────────────────────────
  _changed() {
    this.emit('changed', this.counts());
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, 1000);
  }

  _flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._save();
  }

  _save() {
    this._lastSave = Date.now();
    if (!this.opts.store) return;
    // offset and done: how much of a stopped file is already in place,
    // so that after a relaunch "resume or start again?" is still asked, and
    // START AGAIN still applies.
    const keep = ['id', 'dir', 'type', 'local', 'remote', 'size', 'endpointId', 'endpointLabel', 'existing', 'status', 'attempts', 'error', 'note', 'verify', 'resume', 'restartFromZero', 'mismatchCount', 'addedAt', 'finishedAt', 'seg', 'ownTarget', 'offset', 'done', 'sync', 'relayOut', 'relay'];
    let list = this.order.map(id => this.items.get(id)).filter(Boolean);
    const finished = list.filter(i => i.status === 'done' || i.status === 'skipped');
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map(i => i.id));
      list = list.filter(i => !drop.has(i.id));
    }
    const out = list.map(it => {
      const o = {};
      for (const k of keep) if (it[k] !== undefined && it[k] !== null) o[k] = it[k];
      if (o.seg) o.seg = Object.assign({}, o.seg, { chunks: o.seg.chunks.map(c => Object.assign(c.st === 'd' ? { s: c.s, e: c.e, st: 'd' } : { s: c.s, e: c.e, st: c.st === 'w' ? 'w' : 'p', got: c.got || 0 }, c.hash ? { hash: c.hash } : {})) });
      if (ACTIVE.has(o.status) || o.status === 'waiting') o.status = 'queued';
      return o;
    });
    try { this.opts.store.save(out); } catch (e) { this.log('error', 'Could not save the queue: ' + e.message); }
  }

  _load() {
    if (!this.opts.store) return;
    let list = null;
    try { list = this.opts.store.load(); } catch (_) { list = null; }
    if (!Array.isArray(list)) return;
    for (const o of list) {
      if (!o || !o.id || !o.local || !o.remote) continue;
      const it = Object.assign({ done: 0, attempts: 0 }, o);
      if (ACTIVE.has(it.status) || it.status === 'waiting') it.status = 'queued';
      if (it.seg && it.seg.chunks) it.done = it.seg.chunks.reduce((a, c) => a + (c.st === 'd' ? c.e - c.s : (c.got || 0)), 0);
      this.items.set(it.id, it);
      this.order.push(it.id);
    }
  }
}

function cleanRelay(r) {
  const hashes = {};
  for (const [k, v] of Object.entries((r && r.hashes) || {})) if (/^\d+$/.test(k) && /^[0-9a-f]{8,64}$/.test(String(v))) hashes[k] = String(v);
  return {
    id: String(r.id || '').slice(0, 32), size: Math.max(0, Number(r.size) || 0), mtime: Number(r.mtime) || 0,
    segSize: Math.max(1, Number(r.segSize) || 1), count: Math.max(0, Number(r.count) || 0),
    part: String(r.part || ''), hashes, final: !!r.final,
  };
}

// What a lane needs to know about an item: plain data, no timers or samples.
function plainItem(it) {
  const o = {};
  for (const k of ['id', 'dir', 'type', 'local', 'remote', 'size', 'existing', 'resume', 'restartFromZero', 'offset', 'seg', 'ownTarget', 'relayOut', 'relay']) if (it[k] !== undefined) o[k] = it[k];
  if (o.relay) o.relay = JSON.parse(JSON.stringify(o.relay));
  if (o.seg) o.seg = JSON.parse(JSON.stringify(o.seg));
  return o;
}

function displayName(it) {
  return posix.basename(it.dir === 'up' ? it.remote : String(it.local).replace(/\\/g, '/'));
}

function verifyText(v) {
  const L = { xxh64: 'xxHash64', sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5', crc32: 'CRC32' };
  if (v.level === 'server') return `verified (${L[v.algo]} computed by the server)`;
  if (v.level === 'readback') return 'verified (read back, xxHash64)';
  if (v.level === 'received') return 'verified (copy = bytes received, xxHash64)';
  if (v.level === 'relay') return "verified (each segment = the sender's file, xxHash64)";
  return 'size checked';
}

module.exports = { TransferQueue, verifyText, RETRY_DELAYS_S };
