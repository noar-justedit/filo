/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Taken from syncto 0.8.7.

// Phone notification through ntfy — same mechanism as ingesto, deliberately.
//
// A POST of plain text to <server>/<topic>. No account, no SDK, no dependency.
// Whatever the user has subscribed to that topic — the ntfy app on a phone, a
// browser tab — receives it.
//
// The one thing that is easy to get wrong, and that ingesto got bitten by:
// Title, Tags and Priority are HTTP HEADER values. A single accent or emoji in
// them throws ERR_INVALID_CHAR and loses the WHOLE notification, body
// included. So they are stripped to printable ASCII here, while the message
// body — which travels as UTF-8 in the request body — keeps everything.

const https = require('https');
const http  = require('http');

const TIMEOUT_MS = 8000;

// Printable ASCII only. Anything else is dropped rather than escaped: these
// are labels, and a mangled label is better than a lost notification.
function headerSafe(s) {
  return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '').trim();
}

// ntfy tags are emoji short codes or plain words, comma separated.
function tagsSafe(s) {
  return headerSafe(s).replace(/[^a-zA-Z0-9_,\-]/g, '').replace(/^,+|,+$/g, '');
}

// opts: { server, topic, token, title, message, tags, priority }
// Never throws and never rejects: a notification is the last thing that should
// be able to fail a transfer.
function send(opts) {
  return new Promise(resolve => {
    try {
      const topic = String((opts && opts.topic) || '').trim();
      if (!topic) return resolve({ ok: false, error: 'No topic set.' });

      const server = String((opts.server || 'https://ntfy.sh')).trim().replace(/\/+$/, '');
      const url = new URL(server + '/' + encodeURIComponent(topic));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return resolve({ ok: false, error: 'The server address must start with http:// or https://' });
      }

      const body = Buffer.from(String(opts.message || ''), 'utf8');
      const headers = {
        'Content-Type'  : 'text/plain; charset=utf-8',
        'Content-Length': body.length,
      };
      const title = headerSafe(opts.title);
      if (title) headers['Title'] = title;
      const tags = tagsSafe(opts.tags);
      if (tags) headers['Tags'] = tags;
      const p = parseInt(opts.priority, 10);
      if (Number.isFinite(p) && p >= 1 && p <= 5) headers['Priority'] = String(p);
      // Self-hosted servers can require a token. NOT passed through
      // headerSafe: stripping a secret to printable ASCII silently mangles it
      // and the server answers 401. A token that cannot travel as a header is
      // reported, not quietly truncated.
      const token = String(opts.token == null ? '' : opts.token).trim();
      if (token) {
        if (/[^\x20-\x7E]/.test(token)) {
          return resolve({ ok: false, error: 'The access token contains characters that cannot be sent in an HTTP header.' });
        }
        headers['Authorization'] = 'Bearer ' + token;
      }

      const mod = url.protocol === 'http:' ? http : https;
      const req = mod.request(url, { method: 'POST', headers, timeout: TIMEOUT_MS }, res => {
        res.resume();
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve(ok
          ? { ok: true, status: res.statusCode }
          : { ok: false, status: res.statusCode, error: `The server answered ${res.statusCode}.` });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'The server did not answer within 8 s.' }); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// One retry, two seconds later — a laptop that has just woken a Wi-Fi radio
// misses the first attempt often enough to be worth it. Still never blocking:
// the run is already finished by the time this is called.
async function sendWithRetry(opts) {
  const first = await send(opts);
  if (first.ok) return first;
  await new Promise(r => setTimeout(r, 2000));
  return send(opts);
}

// Builds the notification for a finished queue.
//   s: the 'finished' summary from core/queue.js
// Says what was checked, not just that it ended: "done" tells someone waiting
// on a two-hour delivery nothing they can act on.
function forQueue(s) {
  const files = s.done || 0;
  const bytes = s.bytes || 0;
  // ASCII only: the title travels as an HTTP header (see headerSafe).
  const name = 'filo' + (s.endpointLabel ? ' - ' + s.endpointLabel : '');
  const size = bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB'
             : bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB'
             : bytes + ' B';
  const secs = Math.round((s.durationMs || 0) / 1000);
  const dur = secs >= 3600 ? `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`
            : secs >= 60   ? `${Math.floor(secs / 60)}m ${secs % 60}s`
            : `${secs}s`;
  const lines = [`${files} file${files === 1 ? '' : 's'} · ${size} · ${dur}`];
  if (s.skipped) lines.push(`${s.skipped} skipped (already there)`);
  let title, tags, priority;
  if (s.failed) {
    title = `${name}: ${s.failed} failed`;
    const first = (s.errors || [])[0];
    if (first) lines.push(`First: ${first.name} — ${first.message}`);
    tags = 'warning'; priority = 4;
  } else {
    title = `${name}: done`;
    if (s.verified) lines.push(`✓ ${s.verified} verified by checksum`);
    tags = 'white_check_mark'; priority = 3;
  }
  return { title, message: lines.join('\n'), tags, priority };
}

module.exports = { send, sendWithRetry, forQueue, headerSafe, tagsSafe };
