// filo — FTP, FTPS and SFTP client
// Copyright (C) 2026 Just Edit (Arnaud Augst)
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
//
// filo-engine: the SFTP data path of filo, in Rust (see ETAT_PROJET.md,
// "Moteur Rust"). filo keeps everything else (browsing, the queue, renames,
// checks); this program only moves bytes between a local file and a remote
// file, as fast as the link and the server allow.
//
// Why a program of its own: Node's SSH library (ssh2, in JavaScript) was the
// limit — on Noar's DS920+, one connection received 45 to 170 MB/s where
// OpenSSH got 185. Here SSH is russh (Rust, AES-GCM from `ring`) and SFTP is
// written below: a small protocol, so the requests in flight, their size and
// the order of the work are ours to decide.
//
// Two ways to run it:
//
//   filo-engine serve
//       What filo uses: one process per connection of the queue. Orders come
//       on stdin, one JSON object per line; events go to stdout, one per
//       line. Nothing secret is ever on the command line.
//         {"op":"hello","host","port","user","password"?,"key"?,"passphrase"?,"fingerprint"}
//             -> {"ev":"ready","cipher"} | {"ev":"fatal","error","kind"}
//         {"op":"get","id","remote","local","start","end"?,"segment","hash"}
//         {"op":"put","id","local","remote","start","end","segment","hash"}
//             -> {"ev":"bytes","id","n","kept"} (every 100 ms: bytes since the last one,
//                and what is surely in place from `start`)
//             -> {"ev":"done","id","bytes","hash"} | {"ev":"error","id","error","kind","kept",...}
//         {"op":"abort","id"}      stops that job as soon as possible
//         {"op":"rate","id","bps"} changes its speed limit (also "rate" in get/put)
//       stdin closed = everything stops.
//
//   filo-engine get|put --host H --port P --user U --remote R --local L
//       For measuring (scripts/bench-engine.command): the password from
//       FILO_PW, --conns N splits the file in N parts on N connections,
//       --local - receives to nowhere. One JSON line at the end.
//
// The rules the rest of filo relies on:
//   - a download is written IN ORDER (the replies, which arrive in any order,
//     wait in memory for their turn): the local file is always an exact
//     prefix, so "resume from its size" stays true, and the fingerprint
//     (xxHash64) is of the bytes in order;
//   - an upload reports, when it stops, how much from its start the server
//     has acknowledged without a gap ("kept");
//   - the server's identity must be the one filo already checked
//     ("fingerprint"), or nothing is sent.

use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use russh::client;
use russh::keys::HashAlg;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc};
use xxhash_rust::xxh64::Xxh64;

// ── SFTP v3 (draft-ietf-secsh-filexfer-02) ────────────────────────────────
const FXP_INIT: u8 = 1;
const FXP_VERSION: u8 = 2;
const FXP_OPEN: u8 = 3;
const FXP_CLOSE: u8 = 4;
const FXP_READ: u8 = 5;
const FXP_WRITE: u8 = 6;
const FXP_FSTAT: u8 = 8;
const FXP_STATUS: u8 = 101;
const FXP_HANDLE: u8 = 102;
const FXP_DATA: u8 = 103;
const FXP_ATTRS: u8 = 105;
const FXP_EXTENDED: u8 = 200;
const FXP_EXTENDED_REPLY: u8 = 201;

const FXF_READ: u32 = 0x01;
const FXF_WRITE: u32 = 0x02;
const FXF_CREAT: u32 = 0x08;
const FXF_TRUNC: u32 = 0x10;

const FX_OK: u32 = 0;
const FX_EOF: u32 = 1;

// Reading: 32 KB requests (larger ones were up to 3 times slower on Noar's
// NAS reading a big file from its disks), a depth that follows the round
// trip, from 64 up to 32 MB in flight.
const READ_CHUNK: u64 = 32 * 1024;
const READ_DEPTH_MIN: usize = 64;
const READ_BYTES_MAX: u64 = 32 * 1024 * 1024;
// Writing: as large as the server takes (OpenSSH: ~255 KB), 64 in flight.
// filo's resume margin for uploads is exactly this (64 × the write size):
// keep the two equal.
const WRITE_CHUNK_MAX: u64 = 256 * 1024;
const WRITE_DEPTH: usize = 64;
// No reply at all for this long, with requests out: the connection is dead.
const STALL: Duration = Duration::from_secs(60);

// ── Errors that filo needs to tell apart ──────────────────────────────────
#[derive(Debug)]
struct Fail { kind: &'static str, msg: String, code: Option<&'static str>, path: Option<String> }
impl std::fmt::Display for Fail { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.msg) } }
impl std::error::Error for Fail {}
fn fail(kind: &'static str, msg: impl Into<String>) -> anyhow::Error { Fail { kind, msg: msg.into(), code: None, path: None }.into() }
// A file error on THIS computer, with the code filo turns into plain words.
fn local_fail(e: std::io::Error, path: &str) -> anyhow::Error {
    use std::io::ErrorKind as K;
    let code = match e.kind() {
        K::PermissionDenied => Some("EACCES"),
        K::NotFound => Some("ENOENT"),
        K::StorageFull => Some("ENOSPC"),
        K::ReadOnlyFilesystem => Some("EROFS"),
        K::ResourceBusy => Some("EBUSY"),
        _ => None,
    };
    Fail { kind: "local", msg: format!("{e} ({path})"), code, path: Some(path.to_string()) }.into()
}
fn kind_of(e: &anyhow::Error) -> &'static str {
    e.downcast_ref::<Fail>().map(|f| f.kind).unwrap_or("network")
}

// ── SSH ───────────────────────────────────────────────────────────────────
#[derive(Clone, Default)]
struct Creds {
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key: Option<String>,
    passphrase: Option<String>,
    fingerprint: Option<String>,
}

struct Client { expected: Option<String>, seen: Arc<Mutex<String>>, cipher: Arc<Mutex<String>> }

impl client::Handler for Client {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            // A certificate is never asked for (Preferred::host_key_certificates is empty).
            _ => return Ok(false),
        };
        *self.seen.lock().unwrap() = fp.clone();
        Ok(match &self.expected { Some(e) => *e == fp, None => true })
    }

    async fn kex_done(&mut self, _s: Option<&[u8]>, names: &russh::Names, _session: &mut client::Session) -> Result<(), Self::Error> {
        *self.cipher.lock().unwrap() = names.cipher.as_ref().to_string();
        Ok(())
    }
}

// ── SFTP packets ──────────────────────────────────────────────────────────
enum Reply {
    Version(Vec<(String, Vec<u8>)>),
    Status { id: u32, code: u32, msg: String },
    Handle { handle: Vec<u8> },
    Data { id: u32, data: Vec<u8> },
    Attrs { size: Option<u64> },
    Ext { data: Vec<u8> },
}

struct Cur<'a> { b: &'a [u8], p: usize }
impl<'a> Cur<'a> {
    fn u32(&mut self) -> Result<u32> { let s = self.b.get(self.p..self.p + 4).ok_or_else(|| anyhow!("short SFTP packet"))?; self.p += 4; Ok(u32::from_be_bytes(s.try_into().unwrap())) }
    fn u64(&mut self) -> Result<u64> { let s = self.b.get(self.p..self.p + 8).ok_or_else(|| anyhow!("short SFTP packet"))?; self.p += 8; Ok(u64::from_be_bytes(s.try_into().unwrap())) }
    fn bytes(&mut self) -> Result<&'a [u8]> { let n = self.u32()? as usize; let s = self.b.get(self.p..self.p + n).ok_or_else(|| anyhow!("short SFTP packet"))?; self.p += n; Ok(s) }
    fn left(&self) -> usize { self.b.len() - self.p }
}

fn put_u32(v: &mut Vec<u8>, x: u32) { v.extend_from_slice(&x.to_be_bytes()); }
fn put_u64(v: &mut Vec<u8>, x: u64) { v.extend_from_slice(&x.to_be_bytes()); }
fn put_str(v: &mut Vec<u8>, s: &[u8]) { put_u32(v, s.len() as u32); v.extend_from_slice(s); }

fn packet(kind: u8, f: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut v = Vec::with_capacity(64);
    v.extend_from_slice(&[0, 0, 0, 0, kind]);
    f(&mut v);
    let n = (v.len() - 4) as u32;
    v[..4].copy_from_slice(&n.to_be_bytes());
    v
}

// The SFTP status codes, in the words filo already turns into plain ones.
fn status_text(code: u32, msg: &str) -> String {
    let base = match code { 2 => "No such file", 3 => "Permission denied", 4 => "Failure", 5 => "Bad message", 8 => "Operation unsupported", _ => "" };
    if msg.is_empty() { base.to_string() } else if base.is_empty() || msg.to_lowercase().contains(&base.to_lowercase()) { msg.to_string() } else { format!("{base}: {msg}") }
}

// Reads every reply of the server and hands it over, in arrival order.
async fn reader<R: tokio::io::AsyncRead + Unpin>(rd: R, tx: mpsc::Sender<Result<Reply>>) {
    let mut rd = BufReader::with_capacity(1 << 20, rd);
    loop {
        let r: Result<Reply> = async {
            let n = rd.read_u32().await? as usize;
            if n == 0 || n > 64 << 20 { bail!("bad SFTP packet length {n}"); }
            let kind = rd.read_u8().await?;
            if kind == FXP_DATA {
                let id = rd.read_u32().await?;
                let len = rd.read_u32().await? as usize;
                if len + 9 != n { bail!("bad SFTP DATA packet"); }
                let mut data = vec![0u8; len];
                rd.read_exact(&mut data).await?;
                return Ok(Reply::Data { id, data });
            }
            let mut body = vec![0u8; n - 1];
            rd.read_exact(&mut body).await?;
            let mut c = Cur { b: &body, p: 0 };
            Ok(match kind {
                FXP_VERSION => {
                    let _v = c.u32()?;
                    let mut ext = vec![];
                    while c.left() > 0 { let k = String::from_utf8_lossy(c.bytes()?).into_owned(); let v = c.bytes()?.to_vec(); ext.push((k, v)); }
                    Reply::Version(ext)
                }
                FXP_STATUS => { let id = c.u32()?; let code = c.u32()?; let msg = if c.left() >= 4 { String::from_utf8_lossy(c.bytes()?).into_owned() } else { String::new() }; Reply::Status { id, code, msg } }
                FXP_HANDLE => { let _id = c.u32()?; Reply::Handle { handle: c.bytes()?.to_vec() } }
                FXP_ATTRS => { let _id = c.u32()?; let flags = c.u32()?; let size = if flags & 1 != 0 { Some(c.u64()?) } else { None }; Reply::Attrs { size } }
                FXP_EXTENDED_REPLY => Reply::Ext { data: body[4..].to_vec() },
                k => bail!("unexpected SFTP reply type {k}"),
            })
        }.await;
        let stop = r.is_err();
        if tx.send(r).await.is_err() || stop { return; }
    }
}

type Wr = tokio::io::WriteHalf<russh::ChannelStream<client::Msg>>;

struct Sftp {
    ssh: client::Handle<Client>,
    wr: Wr,
    rx: mpsc::Receiver<Result<Reply>>,
    next_id: u32,
    max_read: u64,
    max_write: u64,
    depth: usize,           // the read depth reached by the last download
}

struct Info { cipher: String, fingerprint: String }

async fn connect(c: &Creds) -> Result<(Sftp, Info)> {
    let mut cfg = client::Config::default();
    // The window the server may fill before we acknowledge: the most a read
    // keeps in flight (32 MB), so the depth is never held back by it.
    cfg.window_size = READ_BYTES_MAX as u32;
    cfg.maximum_packet_size = 32768;
    cfg.nodelay = true;
    cfg.channel_buffer_size = 1024;
    cfg.keepalive_interval = Some(Duration::from_secs(10));
    cfg.keepalive_max = 3;
    cfg.preferred.cipher = std::borrow::Cow::Owned(vec![
        russh::cipher::AES_128_GCM, russh::cipher::AES_256_GCM, russh::cipher::CHACHA20_POLY1305,
        russh::cipher::AES_128_CTR, russh::cipher::AES_256_CTR,
    ]);
    let seen = Arc::new(Mutex::new(String::new()));
    let cipher = Arc::new(Mutex::new(String::new()));
    let handler = Client { expected: c.fingerprint.clone(), seen: seen.clone(), cipher: cipher.clone() };
    let connecting = client::connect(Arc::new(cfg), (c.host.as_str(), c.port), handler);
    let mut ssh = match tokio::time::timeout(Duration::from_secs(20), connecting).await {
        Err(_) => return Err(fail("network", "The server did not answer in time.")),
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let fp = seen.lock().unwrap().clone();
            if let Some(x) = &c.fingerprint { if !fp.is_empty() && *x != fp { return Err(fail("hostkey", format!("The server's identity is not the one filo checked: {fp}, expected {x}."))); } }
            return Err(fail("network", format!("{e:#}")));
        }
    };

    // Login: the key if there is one; otherwise the password, then
    // keyboard-interactive with the same password (every Synology offers it).
    let mut ok = false;
    if let Some(k) = &c.key {
        let key = russh::keys::decode_secret_key(k, c.passphrase.as_deref()).map_err(|e| fail("auth", format!("The private key cannot be read here: {e}")))?;
        let hash = ssh.best_supported_rsa_hash().await.ok().flatten().flatten();
        ok = ssh.authenticate_publickey(&c.user, russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await?.success();
    }
    if !ok { if let Some(pw) = &c.password {
        ok = ssh.authenticate_password(&c.user, pw).await?.success();
        if !ok {
            let mut r = ssh.authenticate_keyboard_interactive_start(&c.user, None::<String>).await?;
            for _ in 0..5 {
                match r {
                    client::KeyboardInteractiveAuthResponse::Success => { ok = true; break; }
                    client::KeyboardInteractiveAuthResponse::Failure { .. } => break,
                    client::KeyboardInteractiveAuthResponse::InfoRequest { ref prompts, .. } => {
                        let answers = prompts.iter().map(|_| pw.clone()).collect();
                        r = ssh.authenticate_keyboard_interactive_respond(answers).await?;
                    }
                }
            }
        }
    } }
    if !ok { return Err(fail("auth", "The server refused the login: wrong user name, password or key.")); }

    let ch = ssh.channel_open_session().await?;
    ch.request_subsystem(true, "sftp").await?;
    let (rd, wr) = tokio::io::split(ch.into_stream());
    let (tx, rx) = mpsc::channel(4096);
    tokio::spawn(reader(rd, tx));
    let mut s = Sftp { ssh, wr, rx, next_id: 0, max_read: 0, max_write: 0, depth: READ_DEPTH_MIN };
    s.init().await?;
    let info = Info { cipher: cipher.lock().unwrap().clone(), fingerprint: seen.lock().unwrap().clone() };
    Ok((s, info))
}

impl Sftp {
    fn id(&mut self) -> u32 { self.next_id = self.next_id.wrapping_add(1); self.next_id }

    // The next reply; a stop, or a long silence, ends the wait.
    async fn recv(&mut self, stop: &Stop) -> Result<Reply> {
        tokio::select! {
            r = self.rx.recv() => r.ok_or_else(|| fail("network", "The connection was cut."))?,
            _ = stop.wait() => Err(fail("aborted", "Stopped.")),
            _ = tokio::time::sleep(STALL) => Err(fail("network", "The server stopped answering.")),
        }
    }

    async fn init(&mut self) -> Result<()> {
        let none = Stop::new();
        self.wr.write_all(&packet(FXP_INIT, |v| put_u32(v, 3))).await?;
        let ext = match self.recv(&none).await? { Reply::Version(e) => e, _ => bail!("no SFTP VERSION") };
        if ext.iter().any(|(k, _)| k == "limits@openssh.com") {
            let id = self.id();
            self.wr.write_all(&packet(FXP_EXTENDED, |v| { put_u32(v, id); put_str(v, b"limits@openssh.com"); })).await?;
            if let Reply::Ext { data } = self.recv(&none).await? {
                let mut c = Cur { b: &data, p: 0 };
                let _pkt = c.u64()?; self.max_read = c.u64()?; self.max_write = c.u64()?;
            }
        }
        Ok(())
    }

    async fn open(&mut self, path: &str, flags: u32, stop: &Stop) -> Result<Vec<u8>> {
        let id = self.id();
        self.wr.write_all(&packet(FXP_OPEN, |v| { put_u32(v, id); put_str(v, path.as_bytes()); put_u32(v, flags); put_u32(v, 0); })).await?;
        match self.recv(stop).await? {
            Reply::Handle { handle } => Ok(handle),
            Reply::Status { code, msg, .. } => Err(fail("remote", status_text(code, &msg))),
            _ => bail!("unexpected reply to OPEN"),
        }
    }

    async fn fstat_size(&mut self, h: &[u8], stop: &Stop) -> Result<u64> {
        let id = self.id();
        self.wr.write_all(&packet(FXP_FSTAT, |v| { put_u32(v, id); put_str(v, h); })).await?;
        match self.recv(stop).await? { Reply::Attrs { size: Some(s) } => Ok(s), _ => bail!("the server did not give the size") }
    }

    async fn close(&mut self, h: &[u8], stop: &Stop) -> Result<()> {
        let id = self.id();
        self.wr.write_all(&packet(FXP_CLOSE, |v| { put_u32(v, id); put_str(v, h); })).await?;
        match self.recv(stop).await? {
            Reply::Status { code: FX_OK, .. } => Ok(()),
            Reply::Status { code, msg, .. } => Err(fail("remote", status_text(code, &msg))),
            _ => bail!("unexpected reply to CLOSE"),
        }
    }

    async fn bye(mut self) { let _ = self.wr.shutdown().await; let _ = self.ssh.disconnect(russh::Disconnect::ByApplication, "", "en").await; }
}

// ── Stopping a job ────────────────────────────────────────────────────────
#[derive(Clone)]
struct Stop { flag: Arc<AtomicBool>, n: Arc<Notify> }
impl Stop {
    fn new() -> Self { Stop { flag: Arc::new(AtomicBool::new(false)), n: Arc::new(Notify::new()) } }
    fn fire(&self) { self.flag.store(true, Ordering::SeqCst); self.n.notify_waiters(); }
    fn is(&self) -> bool { self.flag.load(Ordering::SeqCst) }
    async fn wait(&self) {
        loop {
            let f = self.n.notified();
            if self.is() { return; }
            f.await;
            if self.is() { return; }
        }
    }
}

// ── Jobs ──────────────────────────────────────────────────────────────────
struct Job {
    remote: String,
    local: String,           // "-" (get): nowhere
    start: u64,
    end: Option<u64>,        // exclusive; None (get) = the end of the remote file
    segment: bool,           // a part of a file other parts are written into
    hash: bool,              // xxHash64 of the bytes of [start, end), in order
    depth: Option<usize>,    // fixed depth (measuring), None = adaptive
    rate: Arc<AtomicU64>,    // speed limit in bytes per second, 0 = none (filo may change it during the job)
}

// The speed limit: a token bucket (as filo's core/throttle.js). Tokens come
// at `rate` bytes per second; a request takes as many as it carries. The
// bucket holds half a second, or one request when that is more.
struct Bucket { tokens: f64, last: Instant }
impl Bucket {
    fn new() -> Self { Bucket { tokens: 0.0, last: Instant::now() } }
    // None: `n` bytes may go now. Some(d): not before `d`.
    fn take(&mut self, n: u64, rate: u64) -> Option<Duration> {
        if rate == 0 { return None; }
        let now = Instant::now();
        let cap = (rate as f64 / 2.0).max(n as f64);
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * rate as f64).min(cap);
        self.last = now;
        if self.tokens >= n as f64 { self.tokens -= n as f64; return None; }
        Some(Duration::from_secs_f64((n as f64 - self.tokens) / rate as f64))
    }
}

struct Outcome { bytes: u64, hash: Option<String> }

// A job that failed: why, and how much from its start is surely in place.
struct JobFail { err: anyhow::Error, kept: u64 }

fn hex(h: u64) -> String { format!("{h:016x}") }

#[cfg(unix)]
fn write_at(f: &std::fs::File, data: &[u8], off: u64) -> std::io::Result<()> { use std::os::unix::fs::FileExt; f.write_all_at(data, off) }
#[cfg(unix)]
fn read_at(f: &std::fs::File, buf: &mut [u8], off: u64) -> std::io::Result<()> { use std::os::unix::fs::FileExt; f.read_exact_at(buf, off) }
#[cfg(windows)]
fn write_at(f: &std::fs::File, mut data: &[u8], mut off: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !data.is_empty() { let n = f.seek_write(data, off)?; data = &data[n..]; off += n as u64; }
    Ok(())
}
#[cfg(windows)]
fn read_at(f: &std::fs::File, mut buf: &mut [u8], mut off: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        let n = f.seek_read(buf, off)?;
        if n == 0 { return Err(std::io::ErrorKind::UnexpectedEof.into()); }
        buf = &mut buf[n..]; off += n as u64;
    }
    Ok(())
}

// On the disk before the file is called complete. On macOS, Rust's sync_all()
// is fcntl(F_FULLFSYNC), which a network share (SMB on a Synology, say)
// refuses: "Operation not supported (os error 45)" failed every download to
// /Volumes/prod (Noar's colleague, 27/10/2026). Go (1.23, issue 64215), Java
// (JDK-8232861) and libuv do the same thing here: fall back to a plain fsync,
// which on SMB asks the server to flush. A plain fsync that fails is a real
// error, reported as such.
fn flush_to_disk(f: &std::fs::File) -> std::io::Result<()> {
    match f.sync_all() {
        Err(e) if cfg!(target_vendor = "apple") && e.raw_os_error() == Some(libc::ENOTSUP) => plain_fsync(f),
        r => r,
    }
}
#[cfg(unix)]
fn plain_fsync(f: &std::fs::File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::fsync(f.as_raw_fd()) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}
#[cfg(not(unix))]
fn plain_fsync(f: &std::fs::File) -> std::io::Result<()> { f.sync_all() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flush_works_on_a_plain_file() {
        let f = std::fs::File::create(std::env::temp_dir().join("filo-flush-test")).unwrap();
        assert!(flush_to_disk(&f).is_ok());
        assert!(plain_fsync(&f).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn a_real_error_stays_an_error() {
        // A closed descriptor: fsync fails with EBADF, and nothing hides it.
        use std::os::fd::FromRawFd;
        let f = unsafe { std::fs::File::from_raw_fd(libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY)) };
        let raw = { use std::os::fd::AsRawFd; f.as_raw_fd() };
        unsafe { libc::close(raw); }
        assert!(plain_fsync(&f).is_err());
        std::mem::forget(f);
    }
}

// ── Download ──────────────────────────────────────────────────────────────
async fn get(s: &mut Sftp, j: &Job, done: &AtomicU64, stop: &Stop, written: &Arc<AtomicU64>) -> Result<Outcome, JobFail> {
    let r = get_inner(s, j, done, stop, written).await;
    r.map_err(|err| JobFail { err, kept: written.load(Ordering::SeqCst) })
}

async fn get_inner(s: &mut Sftp, j: &Job, done: &AtomicU64, stop: &Stop, written: &Arc<AtomicU64>) -> Result<Outcome> {
    let h = s.open(&j.remote, FXF_READ, stop).await?;
    let end = match j.end { Some(e) => e, None => s.fstat_size(&h, stop).await? };
    let chunk = if s.max_read > 0 { READ_CHUNK.min(s.max_read) } else { READ_CHUNK };

    // The disk side, in a thread: replies wait in `ahead` until every byte
    // before them is written, then go to the disk (and the hasher) in order.
    let (dtx, mut drx) = mpsc::channel::<(u64, Vec<u8>)>(1024);
    let to_null = j.local == "-";
    let file = if to_null { None } else {
        let mut o = std::fs::OpenOptions::new();
        o.write(true);
        if j.start == 0 && !j.segment { o.create(true).truncate(true); }
        Some(o.open(&j.local).map_err(|e| local_fail(e, &j.local))?)
    };
    let (start, segment, want_hash, path) = (j.start, j.segment, j.hash, j.local.clone());
    let w = written.clone();
    let disk = std::thread::spawn(move || -> Result<(u64, Option<String>)> {
        let mut hasher = if want_hash { Some(Xxh64::new(0)) } else { None };
        let mut ahead: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
        let mut pos = start;
        while let Some((off, data)) = drx.blocking_recv() {
            ahead.insert(off, data);
            while let Some(d) = ahead.remove(&pos) {
                if let Some(f) = &file { write_at(f, &d, pos).map_err(|e| local_fail(e, &path))?; }
                if let Some(x) = hasher.as_mut() { x.update(&d); }
                pos += d.len() as u64;
                w.store(pos - start, Ordering::SeqCst);
            }
        }
        if let Some(f) = &file {
            // Complete: cut anything past the end (a resumed file that was
            // longer), then make sure it is on the disk.
            if !segment && pos == end { f.set_len(end).map_err(|e| local_fail(e, &path))?; }
            flush_to_disk(f).map_err(|e| local_fail(e, &path))?;
        }
        Ok((pos - start, hasher.map(|x| hex(x.digest()))))
    });

    let net: Result<()> = async {
        let mut pending: HashMap<u32, (u64, u32, Instant)> = HashMap::with_capacity(2048);
        let mut next_off = j.start;
        let mut out = Vec::with_capacity(64 * 1024);
        // Adaptive depth (as filo's JavaScript reader): every second, twice what
        // the measured rate × the SHORTEST round trip needs. The shortest one is
        // the link without the queue of requests ahead of a reply.
        let cap = ((READ_BYTES_MAX / chunk) as usize).max(READ_DEPTH_MIN);
        let mut depth = j.depth.unwrap_or(s.depth.clamp(READ_DEPTH_MIN, cap));
        let (mut rtt, mut rtt_prev) = (f64::INFINITY, f64::INFINITY);
        let (mut win_t, mut win_b, mut rtt_t) = (Instant::now(), 0u64, Instant::now());
        let mut bucket = Bucket::new();
        loop {
            out.clear();
            while pending.len() < depth && next_off < end {
                let len = chunk.min(end - next_off) as u32;
                if let Some(wait) = bucket.take(len as u64, j.rate.load(Ordering::Relaxed)) {
                    // Over the speed limit: let the replies come in; with none
                    // to wait for, wait for the tokens.
                    if !pending.is_empty() || !out.is_empty() { break; }
                    tokio::select! { _ = tokio::time::sleep(wait) => {}, _ = stop.wait() => return Err(fail("aborted", "Stopped.")) }
                    continue;
                }
                let id = s.id();
                out.extend_from_slice(&packet(FXP_READ, |v| { put_u32(v, id); put_str(v, &h); put_u64(v, next_off); put_u32(v, len); }));
                pending.insert(id, (next_off, len, Instant::now()));
                next_off += len as u64;
            }
            if !out.is_empty() { s.wr.write_all(&out).await?; }
            if pending.is_empty() { break; }
            match s.recv(stop).await? {
                Reply::Data { id, data } => {
                    let (off, len, t0) = pending.remove(&id).ok_or_else(|| anyhow!("reply to an unknown request"))?;
                    rtt = rtt.min(t0.elapsed().as_secs_f64());
                    let got = data.len() as u32;
                    if got == 0 || got > len { bail!("bad read reply"); }
                    if got < len {
                        // Less than asked without the file being over: ask for the rest.
                        let id2 = s.id();
                        let (o2, l2) = (off + got as u64, len - got);
                        s.wr.write_all(&packet(FXP_READ, |v| { put_u32(v, id2); put_str(v, &h); put_u64(v, o2); put_u32(v, l2); })).await?;
                        pending.insert(id2, (o2, l2, Instant::now()));
                    }
                    done.fetch_add(got as u64, Ordering::Relaxed);
                    win_b += got as u64;
                    if dtx.send((off, data)).await.is_err() { bail!("the disk writer stopped"); }
                }
                Reply::Status { code: FX_EOF, .. } => return Err(fail("network", "The file got shorter on the server during the transfer.")),
                Reply::Status { code, msg, .. } => return Err(fail("remote", status_text(code, &msg))),
                _ => bail!("unexpected reply to READ"),
            }
            if j.depth.is_none() && win_t.elapsed() >= Duration::from_secs(1) {
                let rate = win_b as f64 / win_t.elapsed().as_secs_f64();
                let base = rtt.min(rtt_prev);
                if rtt_t.elapsed() >= Duration::from_secs(10) { rtt_prev = rtt; rtt = f64::INFINITY; rtt_t = Instant::now(); }
                if base.is_finite() {
                    let need = ((rate * base * 2.0) / chunk as f64).ceil() as usize;
                    let next = need.min(cap).min(depth * 2).max(READ_DEPTH_MIN);
                    if need as f64 >= depth as f64 * 0.8 || next < depth { depth = next; }
                }
                s.depth = depth;
                win_t = Instant::now(); win_b = 0;
            }
        }
        s.close(&h, stop).await
    }.await;

    drop(dtx);
    let disk_r = disk.join().map_err(|_| anyhow!("the disk writer crashed"))?;
    // "The disk writer stopped" is the network side noticing the disk's failure:
    // the disk's own error (full, denied) is the real one, not a retryable cut.
    let net = match (net, &disk_r) {
        (Err(ne), Err(_)) if ne.to_string().contains("disk writer stopped") => Ok(()),
        (r, _) => r,
    };
    net?;
    let (n, hash) = disk_r?;
    if n != end - j.start { bail!("{n} bytes written of {}", end - j.start); }
    Ok(Outcome { bytes: n, hash })
}

// ── Upload ────────────────────────────────────────────────────────────────
async fn put(s: &mut Sftp, j: &Job, done: &AtomicU64, stop: &Stop, kept: &Arc<AtomicU64>) -> Result<Outcome, JobFail> {
    let r = put_inner(s, j, done, stop, kept).await;
    r.map_err(|err| JobFail { err, kept: kept.load(Ordering::SeqCst) })
}

async fn put_inner(s: &mut Sftp, j: &Job, done: &AtomicU64, stop: &Stop, kept: &Arc<AtomicU64>) -> Result<Outcome> {
    let f = std::fs::File::open(&j.local).map_err(|e| local_fail(e, &j.local))?;
    let end = match j.end { Some(e) => e, None => f.metadata().map_err(|e| local_fail(e, &j.local))?.len() };
    let chunk = if s.max_write > 0 { WRITE_CHUNK_MAX.min(s.max_write) } else { READ_CHUNK };
    // As filo's JavaScript writer: 'w' (create, empty) for a new whole file,
    // otherwise write into what is there without cutting it.
    let flags = if j.start == 0 && !j.segment { FXF_WRITE | FXF_CREAT | FXF_TRUNC } else { FXF_WRITE };
    let h = s.open(&j.remote, flags, stop).await?;

    // The file read ahead, in order, by a thread (which also fingerprints it).
    let (ftx, mut frx) = mpsc::channel::<Result<(u64, Vec<u8>)>>(WRITE_DEPTH * 2);
    let (start, want_hash, path) = (j.start, j.hash, j.local.clone());
    let rd = std::thread::spawn(move || -> Option<String> {
        let mut hasher = if want_hash { Some(Xxh64::new(0)) } else { None };
        let mut off = start;
        while off < end {
            let n = chunk.min(end - off) as usize;
            let mut buf = vec![0u8; n];
            if let Err(e) = read_at(&f, &mut buf, off) { let _ = ftx.blocking_send(Err(local_fail(e, &path))); return None; }
            if let Some(x) = hasher.as_mut() { x.update(&buf); }
            if ftx.blocking_send(Ok((off, buf))).is_err() { return None; }
            off += n as u64;
        }
        hasher.map(|x| hex(x.digest()))
    });

    let depth = j.depth.unwrap_or(WRITE_DEPTH);
    let mut inflight: HashMap<u32, (u64, u32)> = HashMap::with_capacity(depth * 2);
    let mut acked: BTreeMap<u64, u64> = BTreeMap::new();     // acknowledged, beyond the gap-free prefix
    let mut contig = j.start;
    let mut eof = false;
    let mut hd = Vec::with_capacity(64);
    let mut bucket = Bucket::new();
    let mut held: Option<(u64, Vec<u8>)> = None;      // read, waiting for the speed limit
    loop {
        while inflight.len() < depth && !eof {
            let next = match held.take() {
                Some(x) => Some(Ok(x)),
                None => tokio::select! { r = frx.recv() => r, _ = stop.wait() => return Err(fail("aborted", "Stopped.")) },
            };
            match next {
                Some(Ok((off, buf))) => {
                    if let Some(wait) = bucket.take(buf.len() as u64, j.rate.load(Ordering::Relaxed)) {
                        held = Some((off, buf));
                        if !inflight.is_empty() { break; }
                        tokio::select! { _ = tokio::time::sleep(wait) => {}, _ = stop.wait() => return Err(fail("aborted", "Stopped.")) }
                        continue;
                    }
                    let id = s.id();
                    hd.clear();
                    hd.extend_from_slice(&[0, 0, 0, 0, FXP_WRITE]);
                    put_u32(&mut hd, id); put_str(&mut hd, &h); put_u64(&mut hd, off); put_u32(&mut hd, buf.len() as u32);
                    let n = (hd.len() - 4 + buf.len()) as u32;
                    hd[..4].copy_from_slice(&n.to_be_bytes());
                    s.wr.write_all(&hd).await?;
                    s.wr.write_all(&buf).await?;
                    inflight.insert(id, (off, buf.len() as u32));
                }
                Some(Err(e)) => return Err(e),
                None => eof = true,
            }
        }
        if inflight.is_empty() { break; }
        match s.recv(stop).await? {
            Reply::Status { id, code: FX_OK, .. } => {
                let (off, n) = inflight.remove(&id).ok_or_else(|| anyhow!("reply to an unknown request"))?;
                done.fetch_add(n as u64, Ordering::Relaxed);
                acked.insert(off, n as u64);
                while let Some(n) = acked.remove(&contig) { contig += n; }
                kept.store(contig - j.start, Ordering::SeqCst);
            }
            Reply::Status { code, msg, .. } => return Err(fail("remote", status_text(code, &msg))),
            _ => bail!("unexpected reply to WRITE"),
        }
    }
    s.close(&h, stop).await?;
    let hash = rd.join().map_err(|_| anyhow!("the file reader crashed"))?;
    if contig != end { bail!("{} bytes acknowledged of {}", contig - j.start, end - j.start); }
    Ok(Outcome { bytes: end - j.start, hash })
}

// ── Output (one JSON object per line) ─────────────────────────────────────
fn emit(v: Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

fn fail_json(id: &Value, f: &JobFail) -> Value {
    let mut v = json!({ "ev": "error", "id": id, "error": format!("{:#}", f.err), "kind": kind_of(&f.err), "kept": f.kept });
    if let Some(x) = f.err.downcast_ref::<Fail>() {
        v["error"] = json!(x.msg);
        if let Some(c) = x.code { v["code"] = json!(c); }
        if let Some(p) = &x.path { v["path"] = json!(p); }
    }
    v
}

// ── serve: what filo uses ─────────────────────────────────────────────────
async fn serve() -> Result<()> {
    // stdin is read by a task of its own, so "abort" arrives during a job.
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let current = Arc::new(Mutex::new((Value::Null, Stop::new(), Arc::new(AtomicU64::new(0)))));
    let gone = Stop::new();
    {
        let (current, gone) = (current.clone(), gone.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
                if v["op"] == "abort" || v["op"] == "rate" {
                    let c = current.lock().unwrap();
                    if c.0 == v["id"] {
                        if v["op"] == "abort" { c.1.fire(); } else { c.2.store(v["bps"].as_f64().unwrap_or(0.0).max(0.0) as u64, Ordering::Relaxed); }
                    }
                    continue;
                }
                if tx.send(v).is_err() { break; }
            }
            // filo went away: stop whatever runs, and leave.
            gone.fire();
            current.lock().unwrap().1.fire();
        });
    }

    let mut creds: Option<Creds> = None;
    let mut conn: Option<Sftp> = None;
    loop {
        let cmd = tokio::select! { c = rx.recv() => c, _ = gone.wait() => None };
        let Some(cmd) = cmd else { break };
        let op = cmd["op"].as_str().unwrap_or("");
        let id = cmd["id"].clone();
        let st = |k: &str| cmd[k].as_str().map(|s| s.to_string());
        match op {
            "hello" => {
                let c = Creds {
                    host: st("host").unwrap_or_default(),
                    port: cmd["port"].as_u64().unwrap_or(22) as u16,
                    user: st("user").unwrap_or_default(),
                    password: st("password").filter(|s| !s.is_empty()),
                    key: st("key").filter(|s| !s.is_empty()),
                    passphrase: st("passphrase").filter(|s| !s.is_empty()),
                    fingerprint: st("fingerprint").filter(|s| !s.is_empty()),
                };
                if let Some(old) = conn.take() { old.bye().await; }
                match connect(&c).await {
                    Ok((s, info)) => { conn = Some(s); creds = Some(c); emit(json!({ "ev": "ready", "cipher": info.cipher, "fingerprint": info.fingerprint })); }
                    Err(e) => emit(json!({ "ev": "fatal", "error": format!("{e:#}"), "kind": kind_of(&e) })),
                }
            }
            "get" | "put" => {
                let job = Job {
                    remote: st("remote").unwrap_or_default(),
                    local: st("local").unwrap_or_default(),
                    start: cmd["start"].as_u64().unwrap_or(0),
                    end: cmd["end"].as_u64(),
                    segment: cmd["segment"].as_bool().unwrap_or(false),
                    hash: cmd["hash"].as_bool().unwrap_or(false),
                    depth: None,
                    rate: Arc::new(AtomicU64::new(cmd["rate"].as_f64().unwrap_or(0.0).max(0.0) as u64)),
                };
                let stop = Stop::new();
                *current.lock().unwrap() = (id.clone(), stop.clone(), job.rate.clone());
                let Some(c) = creds.clone() else { emit(json!({ "ev": "error", "id": id, "error": "no hello yet", "kind": "fatal", "kept": 0 })); continue };
                // (Re)connect when needed: a job that failed or was stopped
                // leaves its connection behind, with replies still on the way.
                if conn.is_none() {
                    match connect(&c).await {
                        Ok((s, _)) => conn = Some(s),
                        Err(e) => { emit(fail_json(&id, &JobFail { err: e, kept: 0 })); continue; }
                    }
                }
                let s = conn.as_mut().unwrap();
                let done = Arc::new(AtomicU64::new(0));
                // What is surely in place so far (written in order / acknowledged
                // without a gap), sent with the progress (filo 0.9.7): saved by
                // filo while it runs, so a crash keeps the progress of a segment.
                let kept = Arc::new(AtomicU64::new(0));
                let ticker = {
                    let (done, kept, id) = (done.clone(), kept.clone(), id.clone());
                    tokio::spawn(async move {
                        let mut last = 0;
                        loop {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            let n = done.load(Ordering::Relaxed);
                            if n > last { emit(json!({ "ev": "bytes", "id": id, "n": n - last, "kept": kept.load(Ordering::SeqCst) })); last = n; }
                        }
                    })
                };
                let r = if op == "get" { get(s, &job, &done, &stop, &kept).await } else { put(s, &job, &done, &stop, &kept).await };
                ticker.abort();
                let _ = ticker.await;
                // Whatever the ticker did not report yet.
                match r {
                    Ok(o) => emit(json!({ "ev": "done", "id": id, "bytes": o.bytes, "hash": o.hash })),
                    Err(f) => {
                        if let Some(old) = conn.take() { tokio::spawn(old.bye()); }
                        emit(fail_json(&id, &f));
                    }
                }
                *current.lock().unwrap() = (Value::Null, Stop::new(), Arc::new(AtomicU64::new(0)));
            }
            "bye" => break,
            _ => {}
        }
    }
    if let Some(s) = conn.take() { s.bye().await; }
    Ok(())
}

// ── get / put from the command line: measuring ────────────────────────────
fn parse_cli() -> Result<(String, Creds, Job, u64)> {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_default();
    let mut m: HashMap<String, String> = HashMap::new();
    while let Some(k) = it.next() {
        let k = k.strip_prefix("--").ok_or_else(|| anyhow!("unexpected argument {k}"))?.to_string();
        let v = it.next().ok_or_else(|| anyhow!("--{k} needs a value"))?;
        m.insert(k, v);
    }
    let need = |k: &str| m.get(k).cloned().ok_or_else(|| anyhow!("--{k} is missing"));
    let num = |k: &str| -> Result<Option<u64>> { m.get(k).map(|v| v.parse::<u64>().context(format!("--{k}"))).transpose() };
    let creds = Creds {
        host: need("host")?,
        port: num("port")?.unwrap_or(22) as u16,
        user: need("user")?,
        password: Some(std::env::var("FILO_PW").map_err(|_| anyhow!("FILO_PW (the password) is not set"))?),
        key: None,
        passphrase: None,
        fingerprint: m.get("fingerprint").cloned().filter(|s| !s.is_empty()),
    };
    let job = Job { remote: need("remote")?, local: need("local")?, start: 0, end: None, segment: false, hash: m.get("hash").is_some_and(|v| v == "1"), depth: num("depth")?.map(|d| d.clamp(1, 4096) as usize), rate: Arc::new(AtomicU64::new(num("rate")?.unwrap_or(0))) };
    Ok((cmd, creds, job, num("conns")?.unwrap_or(1).clamp(1, 32)))
}

async fn cli() -> Result<()> {
    let (cmd, creds, job, conns) = parse_cli()?;
    let (mut first, info) = connect(&creds).await?;
    let none = Stop::new();
    let t0 = Instant::now();
    let size = if cmd == "get" {
        let h = first.open(&job.remote, FXF_READ, &none).await?;
        let s = first.fstat_size(&h, &none).await?;
        first.close(&h, &none).await?;
        if job.local != "-" { let f = std::fs::File::create(&job.local).map_err(|e| local_fail(e, &job.local))?; f.set_len(0)?; }
        s
    } else {
        let s = std::fs::metadata(&job.local).map_err(|e| local_fail(e, &job.local))?.len();
        let h = first.open(&job.remote, FXF_WRITE | FXF_CREAT | FXF_TRUNC, &none).await?;
        first.close(&h, &none).await?;
        s
    };
    let done = Arc::new(AtomicU64::new(0));
    let mut tasks = Vec::new();
    let mut first = Some(first);
    for i in 0..conns {
        let (a, b) = (size * i / conns, size * (i + 1) / conns);
        let part = Job { remote: job.remote.clone(), local: job.local.clone(), start: a, end: Some(b), segment: true, hash: job.hash, depth: job.depth, rate: job.rate.clone() };
        let (creds, done, cmd, reuse) = (creds.clone(), done.clone(), cmd.clone(), first.take());
        tasks.push(tokio::spawn(async move {
            let mut s = match reuse { Some(s) => s, None => connect(&creds).await?.0 };
            let stop = Stop::new();
            let kept = Arc::new(AtomicU64::new(0));
            let r = if cmd == "get" { get(&mut s, &part, &done, &stop, &kept).await } else { put(&mut s, &part, &done, &stop, &kept).await };
            s.bye().await;
            r.map_err(|f| f.err)
        }));
    }
    let mut hashes = vec![];
    for t in tasks { hashes.push(t.await??.hash); }
    let secs = t0.elapsed().as_secs_f64();
    let bytes = done.load(Ordering::Relaxed);
    if bytes != size { bail!("{bytes} bytes moved, {size} expected"); }
    emit(json!({ "ok": true, "cmd": cmd, "bytes": bytes, "seconds": secs, "mbps": bytes as f64 / 1e6 / secs, "cipher": info.cipher, "fingerprint": info.fingerprint, "conns": conns, "hashes": hashes }));
    Ok(())
}

#[tokio::main]
async fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let r = match cmd.as_str() {
        "serve" => serve().await,
        "get" | "put" => cli().await,
        "version" => { emit(json!({ "version": env!("CARGO_PKG_VERSION") })); Ok(()) }
        _ => Err(anyhow!("usage: filo-engine serve | get | put | version (see the top of main.rs)")),
    };
    if let Err(e) = r {
        emit(json!({ "ok": false, "error": format!("{e:#}") }));
        std::process::exit(1);
    }
}
