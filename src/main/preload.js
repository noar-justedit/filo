/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The only door between the window and the rest. EVERY argument is passed
// through explicitly: a bridge that drops one makes no noise at all (syncto's
// automatic shutdown never worked until 0.7.3 because of exactly that). The
// test suite compares the arity of each entry with its handler.
//
// No method here ever returns a password.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

const api = {
  platform: process.platform,
  init        : ()            => inv('init'),
  saveUi      : (ui)          => inv('save-ui', ui),
  settingsSave: (patch)       => inv('settings-save', patch),
  afterSet    : (v)           => inv('after-action-set', v),
  afterRun    : (action, clean) => inv('after-action-run', action, clean),
  openExternal: (u)           => inv('open-external', u),
  copyText    : (t)           => inv('copy-text', t),
  cliInfo     : ()            => inv('cli-info'),
  cliInstall  : ()            => inv('cli-install'),
  cliHelp     : ()            => inv('cli-help'),

  ntfySave    : (patch)       => inv('ntfy-save', patch),
  ntfyTest    : (patch)       => inv('ntfy-test', patch),

  knownList   : ()            => inv('known-list'),
  knownForget : (key)         => inv('known-forget', key),
  trust       : (t)           => inv('trust', t),

  localList   : (dir)         => inv('local-list', dir),
  localRoots  : ()            => inv('local-roots'),
  localPlaces : ()            => inv('local-places'),
  winMini     : (on)          => inv('win-mini', !!on),
  winPin      : (on)          => inv('win-pin', !!on),
  winToTray   : ()            => inv('win-to-tray'),
  localMkdir  : (dir, name)   => inv('local-mkdir', dir, name),
  localRename : (from, name)  => inv('local-rename', from, name),
  localMove   : (paths, target) => inv('local-move', paths, target),
  localDelete : (paths)       => inv('local-delete', paths),
  localReveal : (p)           => inv('local-reveal', p),
  localOpen   : (p)           => inv('local-open', p),
  pickFolder  : (start)       => inv('local-pick-folder', start),
  pickKey     : ()            => inv('local-pick-key'),
  localStatMany: (paths)      => inv('local-stat-many', paths),

  connect     : (req)         => inv('connect', req),
  disconnect  : ()            => inv('disconnect'),
  connectCancel: ()           => inv('connect-cancel'),
  speedtestRun: (req)         => inv('speedtest-run', req),
  speedtestCancel: ()         => inv('speedtest-cancel'),
  speedtestList: (req)        => inv('speedtest-list', req),
  speedtestSave: (siteId)     => inv('speedtest-save', siteId),
  quickClear  : ()            => inv('quick-clear'),
  endpointPassword: (id, pw)  => inv('endpoint-password', id, pw),

  remoteList  : (dir)         => inv('remote-list', dir),
  remoteMkdir : (dir, name)   => inv('remote-mkdir', dir, name),
  remoteRename: (from, name)  => inv('remote-rename', from, name),
  remoteMove  : (paths, target) => inv('remote-move', paths, target),
  syncList    : ()            => inv('sync-list'),
  syncSave    : (pair)        => inv('sync-save', pair),
  syncDelete  : (id)          => inv('sync-delete', id),
  syncRun     : (id)          => inv('sync-run', id),
  syncShare   : (id)          => inv('sync-share', id),
  syncShareSave: (id)         => inv('sync-share-save', id),
  syncShareReveal: (p)        => inv('sync-share-reveal', p),
  syncShareNative: (p)        => inv('sync-share-native', p),
  syncImportRead: (text)      => inv('sync-import-read', text),
  syncImportApply: (req)      => inv('sync-import-apply', req),
  directInfo  : (start)       => inv('direct-info', !!start),
  directAccept: (dev, share)  => inv('direct-accept', dev, share),
  directRefuse: (dev)         => inv('direct-refuse', dev),
  directForget: (id)          => inv('direct-forget', id),
  directOfferAccept: (req)    => inv('direct-offer-accept', req),
  directOfferDismiss: (req)   => inv('direct-offer-dismiss', req),
  directJoin  : (text)        => inv('direct-join', text),
  directSessionId: (id)       => inv('direct-session-id', id),
  directJoinState: (id, f)    => inv('direct-join-state', id, f),
  directJoinSession: (req)    => inv('direct-join-session', req),
  directFast  : (on)          => inv('direct-fast', !!on),
  directHold  : (id, on)      => inv('direct-hold', id, !!on),
  hookTest    : (cmd)         => inv('hook-test', cmd),
  queueSchedule: (at)         => inv('queue-schedule', at || 0),
  compare     : (req)         => inv('compare', req),
  compareCancel: ()           => inv('compare-cancel'),
  localPreview: (p)           => inv('local-preview', p),
  syncConnect : (id, on, which) => inv('sync-connect', id, !!on, which),
  trashInfo   : (id)          => inv('trash-info', id),
  trashOpen   : (id)          => inv('trash-open', id),
  syncRemoteSession: (siteId, dir) => inv('sync-remote-session', siteId, dir),
  syncRemoteList: (siteId, dir) => inv('sync-remote-list', siteId, dir),
  liveInfo    : ()            => inv('live-info'),
  directIdShare: (req)        => inv('direct-id-share', req),
  remoteDelete: (items)       => inv('remote-delete', items),
  remoteDeleteCancel: ()      => inv('remote-delete-cancel'),
  remoteUrl   : (p)           => inv('remote-url', p),

  queueAdd    : (req)         => inv('queue-add', req),
  scanCancel  : ()            => inv('scan-cancel'),
  queueStart  : ()            => inv('queue-start'),
  queuePause  : ()            => inv('queue-pause'),
  queueStopAll: ()            => inv('queue-stop-all'),
  itemPause   : (ids)         => inv('queue-item-pause', ids),
  itemResume  : (ids)         => inv('queue-item-resume', ids),
  itemStop    : (ids)         => inv('queue-item-stop', ids),
  queueRemove : (ids)         => inv('queue-remove', ids),
  queueRetry  : (ids, mode)   => inv('queue-retry', ids, mode),
  queueClear  : (tab)         => inv('queue-clear', tab),
  queuePage   : (tab, offset, limit) => inv('queue-page', tab, offset, limit),
  queueAnswer : (askId, rule, all)   => inv('queue-answer', askId, rule, all),
  queueReveal : (id)          => inv('queue-reveal', id),

  sitesList   : ()            => inv('sites-list'),
  sitesSave   : (site, password, passphrase) => inv('sites-save', site, password, passphrase),
  sitesDelete : (id)          => inv('sites-delete', id),
  sitesArrange: (list, folderOrder) => inv('sites-arrange', list, folderOrder),
  sitesDuplicate: (id)        => inv('sites-duplicate', id),
  sitesDeleteFolder: (path)   => inv('sites-delete-folder', path),
  sitesDuplicateFolder: (from, to) => inv('sites-duplicate-folder', from, to),
  sitesFromQuick: (q, name)   => inv('sites-from-quick', q, name),
  sitesImport : (withPasswords, opts) => inv('sites-import', withPasswords, opts),
  sitesExport : (opts, ids) => inv('sites-export', opts, ids),

  on: (channel, cb) => {
    const allowed = ['queue-progress', 'queue-changed', 'queue-state', 'queue-ask', 'queue-ask-closed', 'queue-blocked',
      'queue-finished', 'log', 'scan-progress', 'delete-progress', 'menu', 'update-available', 'sync-status', 'sync-pairs', 'direct-pending', 'live-queue', 'hook-start', 'queue-scheduled', 'compare-progress', 'connect-step', 'speedtest-event'];
    if (!allowed.includes(channel)) throw new Error('Unknown channel ' + channel);
    const h = (_, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },

  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose   : () => ipcRenderer.send('win-close'),

  // Files dropped from the Finder / Explorer onto the window.
  pathForFile: (file) => {
    try { return webUtils ? webUtils.getPathForFile(file) : (file.path || ''); }
    catch (_) { return file.path || ''; }
  },
};

if (process.contextIsolated) contextBridge.exposeInMainWorld('filo', api);
else window.filo = api;
