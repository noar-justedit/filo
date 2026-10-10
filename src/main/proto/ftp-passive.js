/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Passive-mode FTP, connecting to the control host whatever PASV says.
//
// A PASV reply carries an address and a port. Behind a NAT router many
// servers announce their private address (192.168.x.x), which the client
// cannot reach. basic-ftp 6 refuses such a reply outright ("PASV returned
// another host"), which would break those servers. Following the announced
// address blindly is worse: a hostile server could make filo connect (and
// send an upload's bytes) to any machine ("FTP bounce").
//
// filo does what FileZilla does: it keeps only the PORT from the reply and
// always connects to the address of the control connection. NAT-proof, and
// a server can never send the data connection elsewhere.
//
// EPSV (which only gives a port, by design) is tried first; if the server
// does not know it, PASV is used, and the choice is kept for this connection.

const { parseEpsvResponse, parsePasvResponse, connectForPassiveTransfer } = require('basic-ftp/dist/transfer');

function controlHost(ftp) {
  const h = ftp.socket && ftp.socket.remoteAddress;
  if (!h) throw new Error("Control socket is disconnected, can't get remote address.");
  return h.replace(/^::ffff:/i, '');
}

async function enterPassiveEpsv(ftp) {
  const res = await ftp.request('EPSV');
  const port = parseEpsvResponse(res.message);
  await connectForPassiveTransfer(controlHost(ftp), port, ftp);
  return res;
}

async function enterPassivePasv(ftp) {
  const res = await ftp.request('PASV');
  const target = parsePasvResponse(res.message);
  await connectForPassiveTransfer(controlHost(ftp), target.port, ftp);
  return res;
}

// Returns a prepareTransfer function for one Client. The first transfer finds
// the mode that works; later ones go straight to it.
function makePassive() {
  let chosen = null;
  return async function preparePassive(ftp) {
    if (chosen) return chosen(ftp);
    try {
      const res = await enterPassiveEpsv(ftp);
      chosen = enterPassiveEpsv;
      return res;
    } catch (e) {
      if (ftp.closed) throw e;
      const res = await enterPassivePasv(ftp);
      chosen = enterPassivePasv;
      return res;
    }
  };
}

module.exports = { makePassive, enterPassiveEpsv, enterPassivePasv, _controlHost: controlHost };
