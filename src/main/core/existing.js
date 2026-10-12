/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// What to do when the target already exists. FileZilla's list, minus the
// entries nobody could tell apart, plus "resume", which is the one that
// matters for a 60 GB file cut at 80 %.

const ACTIONS = ['ask', 'overwrite', 'newer', 'sizeDiffers', 'resume', 'rename', 'skip'];

const LABELS = {
  ask: 'Ask',
  overwrite: 'Overwrite',
  newer: 'Overwrite if the source is newer',
  sizeDiffers: 'Overwrite if the size differs',
  resume: 'Resume (continue a smaller target)',
  rename: 'Keep both (rename the new one)',
  skip: 'Skip',
};

// Dates compared with two seconds of slack: FTP gives minutes at best, some
// servers round, FAT keeps even seconds.
const SLACK_MS = 2000;

// rule + the two sides → 'overwrite' | 'skip' | 'resume' | 'rename'.
// Never 'ask': the caller has already asked when the rule was 'ask'.
function resolve(rule, src, dst) {
  switch (rule) {
    case 'overwrite': return 'overwrite';
    case 'skip': return 'skip';
    case 'rename': return 'rename';
    case 'newer':
      if (!src.mtime || !dst.mtime) return 'overwrite';   // cannot tell: the safer bet is the fresh copy
      return src.mtime > dst.mtime + SLACK_MS ? 'overwrite' : 'skip';
    case 'sizeDiffers': return src.size !== dst.size ? 'overwrite' : 'skip';
    case 'resume':
      if (dst.size < src.size) return 'resume';
      if (dst.size === src.size) return 'skip';
      return 'overwrite';                                 // bigger than the source: not a partial copy of it
    default: return 'skip';                               // unknown rule: never overwrite by mistake
  }
}

// "clip.mov" → "clip (1).mov", "clip (2).mov"… until `exists` says no.
async function freeName(name, exists) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!(await exists(cand))) return cand;
  }
  throw new Error('No free name found for ' + name);
}

module.exports = { ACTIONS, LABELS, resolve, freeName, SLACK_MS };
