/*
 * filo — FTP, FTPS and SFTP client (test suite)
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 *
 * Taken from filo 0.8.7 (test/sftp-server.js), with: opening a file for
 * writing WITHOUT truncating it (what a resumed or segmented upload does),
 * and an optional ceiling on simultaneous sessions (servers that refuse a
 * connection too many).
 */

// A real SFTP server, in this process, serving a real folder — with a
// configurable delay on every reply.
//
// It exists because the thing that had to be measured cannot be measured on a
// LAN: the transfers were bounded by the number of requests in flight, and
// on a link with no latency that bound is invisible. Two users reported 1.5 and
// 0.3 MB/s from opposite ends of Europe; a server that answers 100 ms late
// reproduces that on a laptop, exactly, and lets the fix be proved rather than
// hoped for.
//
//   const srv = await startSftpServer({ root: '/tmp/x', latencyMs: 50 });
//   … connect to srv.port …
//   await srv.close();

const fs = require('fs');
const path = require('path');
const { Server, utils } = require('ssh2');

const { STATUS_CODE, OPEN_MODE } = require('ssh2').utils.sftp;

function startSftpServer(opts) {
  const root = opts.root;
  const latencyMs = opts.latencyMs || 0;
  // Some servers answer a READ with fewer bytes than were asked for, without
  // the file being over — NAS firmwares capping at 16 KB are common. A client
  // that reads a short reply as "end of file" truncates silently.
  const readCap = opts.readCap || 0;
  const user = opts.username || 'tester';
  const pass = opts.password || 'secret';

  // Generated per run: nothing here is a credential anyone could reuse.
  //
  // ssh2's own generator produces a key its own parser rejects about four
  // times in a thousand ("Malformed OpenSSH private key"). The suite starts
  // eight servers, so one run in thirty died on it — the intermittent failure
  // that went unnamed until each section got its own try. Generated again
  // until it parses; the product never generates keys, only this test does.
  let key = opts.hostKey ? { private: opts.hostKey } : null;
  for (let tries = 0; !key && tries < 20; tries++) {
    const k = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(k.private) instanceof Error)) { key = k; break; }
  }
  if (!key) throw new Error('could not generate a usable host key for the test server');

  // Every reply is delayed by the same amount, which is what a round trip is.
  const later = fn => (latencyMs ? setTimeout(fn, latencyMs) : setImmediate(fn));

  const handles = new Map();
  let nextHandle = 1;

  function resolve(p) {
    const clean = path.posix.normalize('/' + String(p || '')).replace(/^\/+/, '');
    return path.join(root, clean);
  }

  return new Promise((resolve_, reject) => {
    let sessions = 0;
    const maxSessions = opts.maxSessions || 0;
    const srv = new Server({ hostKeys: [key.private] }, client => {
      // A server that allows only so many connections per account: the one
      // over the limit is cut right after it logs in, as many hosts do.
      let counted = false;
      client.on('close', () => { if (counted) sessions--; });
      client.on('authentication', ctx => {
        if (maxSessions && ctx.method === 'password' && ctx.username === user && ctx.password === pass && sessions >= maxSessions) {
          ctx.accept();
          setImmediate(() => client.end());
          return;
        }
        if (ctx.method === 'password' && ctx.username === user && ctx.password === pass) { sessions++; counted = true; }
        if (ctx.method === 'password' && ctx.username === user && ctx.password === pass) return ctx.accept();
        // A key login, when the test gives the client's public key.
        if (opts.clientKey && ctx.method === 'publickey' && ctx.username === user) {
          const pub = utils.parseKey(opts.clientKey);
          const same = ctx.key.algo === pub.type && Buffer.compare(ctx.key.data, pub.getPublicSSH()) === 0;
          if (!same) return ctx.reject();
          if (!ctx.signature) return ctx.accept();          // "would this key do?"
          return pub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
        }
        if (ctx.method === 'none') return ctx.reject(opts.clientKey ? ['password', 'publickey'] : ['password']);
        ctx.reject();
      });
      client.on('ready', () => {
        client.on('session', accept => {
          const session = accept();
          session.on('sftp', accept2 => {
            const sftp = accept2();

            const ok = (id) => later(() => sftp.status(id, STATUS_CODE.OK));
            const fail = (id, code) => later(() => sftp.status(id, code || STATUS_CODE.FAILURE));

            sftp.on('REALPATH', (id, p) => later(() => {
              sftp.name(id, [{ filename: '/', longname: '/', attrs: {} }]);
            }));

            sftp.on('STAT', onStat); sftp.on('LSTAT', onStat);
            function onStat(id, p) {
              later(() => {
                let st;
                try { st = fs.statSync(resolve(p)); }
                catch (_) { return sftp.status(id, STATUS_CODE.NO_SUCH_FILE); }
                sftp.attrs(id, {
                  mode: st.mode, uid: 0, gid: 0, size: st.size,
                  atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000,
                });
              });
            }

            sftp.on('FSTAT', (id, h) => {
              const e = handles.get(String(h));
              later(() => {
                if (!e) return sftp.status(id, STATUS_CODE.FAILURE);
                const st = fs.fstatSync(e.fd);
                sftp.attrs(id, { mode: st.mode, uid: 0, gid: 0, size: st.size,
                  atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000 });
              });
            });

            sftp.on('OPENDIR', (id, p) => later(() => {
              const dir = resolve(p);
              let names;
              try { names = fs.readdirSync(dir); }
              catch (_) { return sftp.status(id, STATUS_CODE.NO_SUCH_FILE); }
              const h = Buffer.from('d' + (nextHandle++));
              handles.set(String(h), { dir, names, i: 0 });
              sftp.handle(id, h);
            }));

            sftp.on('READDIR', (id, h) => later(() => {
              const e = handles.get(String(h));
              if (!e || !e.names) return sftp.status(id, STATUS_CODE.FAILURE);
              if (e.i >= e.names.length) return sftp.status(id, STATUS_CODE.EOF);
              const out = [];
              for (; e.i < e.names.length; e.i++) {
                const name = e.names[e.i];
                let st; try { st = fs.lstatSync(path.join(e.dir, name)); } catch (_) { continue; }
                out.push({
                  filename: name,
                  longname: `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 u u ${st.size} x ${name}`,
                  attrs: { mode: st.mode, uid: 0, gid: 0, size: st.size,
                           atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000 },
                });
              }
              sftp.name(id, out);
            }));

            sftp.on('OPEN', (id, p, flags) => later(() => {
              const file = resolve(p);
              let mode = 'r';
              if (flags & OPEN_MODE.WRITE) {
                if (flags & OPEN_MODE.EXCL) mode = 'wx';
                else if (flags & OPEN_MODE.APPEND) mode = 'a';
                else if (flags & OPEN_MODE.TRUNC) mode = 'w';
                // Write without truncating: keep what is there (resume,
                // segments); create the file if it does not exist.
                else mode = fs.existsSync(file) ? 'r+' : 'w';
              }
              let fd;
              try { fd = fs.openSync(file, mode); }
              catch (err) {
                return sftp.status(id, err.code === 'EEXIST' ? STATUS_CODE.FAILURE
                  : err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
              }
              const h = Buffer.from('f' + (nextHandle++));
              handles.set(String(h), { fd, file });
              sftp.handle(id, h);
            }));

            sftp.on('READ', (id, h, offset, len) => later(() => {
              const e = handles.get(String(h));
              if (!e || e.fd == null) return sftp.status(id, STATUS_CODE.FAILURE);
              const buf = Buffer.alloc(len);
              let n = 0;
              const ask = readCap ? Math.min(len, readCap) : len;
              try { n = fs.readSync(e.fd, buf, 0, ask, offset); } catch (_) { n = 0; }
              if (n <= 0) return sftp.status(id, STATUS_CODE.EOF);
              sftp.data(id, buf.slice(0, n));
            }));

            sftp.on('WRITE', (id, h, offset, data) => later(() => {
              const e = handles.get(String(h));
              if (!e || e.fd == null) return sftp.status(id, STATUS_CODE.FAILURE);
              try { fs.writeSync(e.fd, data, 0, data.length, offset); }
              catch (_) { return sftp.status(id, STATUS_CODE.FAILURE); }
              sftp.status(id, STATUS_CODE.OK);
            }));

            sftp.on('CLOSE', (id, h) => {
              const e = handles.get(String(h));
              handles.delete(String(h));
              if (e && e.fd != null) { try { fs.closeSync(e.fd); } catch (_) {} }
              ok(id);
            });

            sftp.on('REMOVE', (id, p) => later(() => {
              try { fs.unlinkSync(resolve(p)); sftp.status(id, STATUS_CODE.OK); }
              catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('MKDIR', (id, p) => later(() => {
              try { fs.mkdirSync(resolve(p)); sftp.status(id, STATUS_CODE.OK); }
              catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('RMDIR', (id, p) => later(() => {
              try { fs.rmdirSync(resolve(p)); sftp.status(id, STATUS_CODE.OK); }
              catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('RENAME', (id, from, to) => later(() => {
              try {
                if (fs.existsSync(resolve(to))) return sftp.status(id, STATUS_CODE.FAILURE);
                fs.renameSync(resolve(from), resolve(to));
                sftp.status(id, STATUS_CODE.OK);
              } catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('SETSTAT', (id) => ok(id));
            sftp.on('FSETSTAT', (id) => ok(id));
          });
        });
      });
      client.on('error', () => {});
    });

    // Every TCP connection, so a test can cut them all at once (a network
    // that drops, a Wi-Fi that goes away).
    const socks = new Set();
    srv.on('connection', sk => { socks.add(sk); sk.on('close', () => socks.delete(sk)); });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve_({
        port: srv.address().port,
        host: '127.0.0.1',
        username: user,
        password: pass,
        latencyMs,
        close: () => new Promise(r => { try { srv.close(r); } catch (_) { r(); } }),
        cutAll: () => { for (const sk of socks) { try { sk.destroy(); } catch (_) {} } },
      });
    });
  });
}

module.exports = { startSftpServer };
