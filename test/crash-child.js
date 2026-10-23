/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// A filo that the resume tests kill with SIGKILL in the middle of a transfer
// (0.9.7): a queue with its store on disk, as the app has it. Nothing is
// cleaned up when it dies, exactly as after a crash or a power cut.
//   node test/crash-child.js '<json: { ep, fp, store, items, settings }>'
const fs = require('fs');
const { TransferQueue } = require('../src/main/core/queue');
const { setHostKeyPolicy } = require('../src/main/proto/sftp');
const { setCertPolicy } = require('../src/main/proto/ftp');
const a = JSON.parse(process.argv[2]);
setHostKeyPolicy({ known: () => a.fp, remember: () => {} });
setCertPolicy({ known: () => a.fp, remember: () => {} });
const store = {
  load() { try { return JSON.parse(fs.readFileSync(a.store, 'utf8')); } catch (_) { return null; } },
  save(list) { const t = a.store + '.tmp'; fs.writeFileSync(t, JSON.stringify(list)); fs.renameSync(t, a.store); },
};
const q = new TransferQueue({
  laneMode: 'worker',
  getEndpoint: async () => Object.assign({}, a.ep, { known: { sftp: a.fp, ftps: a.fp } }),
  settings: () => a.settings,
  log: () => {},
  store,
});
if (!q.order.length) q.add(a.items);
q.start();
setInterval(() => {}, 1000);
