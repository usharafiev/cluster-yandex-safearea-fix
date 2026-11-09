#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 cluster-yandex-safearea-fix contributors
/* safearead.js — root entry points for cluster-yandex-safearea-fix.
 *
 * This is a thin wrapper around waze-on-cluster's own carplay patcher: it does
 * NOT edit carplay itself. It asks `carplay_patch.js status` whether the
 * cluster map is on, and, if it is, runs `carplay_patch.js apply --panel high
 * --safe <WxH+X+Y>` to set the Yandex Maps safe area — the same 16 bytes
 * waze-on-cluster would write, with waze-on-cluster's own locator and backup
 * (carplay.woc-orig). So this tool keeps no backup and no locator of its own.
 *
 * waze-on-cluster's Enable map writes its default safe area, which it resets on
 * every Enable map and update, so a boot service re-applies the Yandex offset
 * once after each start (reconcile). It wraps the apply with waze-on-cluster's
 * care: the shared remount lock, / read-write only for the write and read-only
 * again after, the running binary kept hard-linked. It NEVER stops, kills,
 * restarts or reboots carplay; the change takes effect at the next head-unit
 * start. It never enables a map the owner turned off: with the map off it does
 * nothing.
 *
 *   safearead.js activate     install/update hook: set the Yandex safe area
 *   safearead.js deactivate   removal hook: restore waze-on-cluster's default
 *   safearead.js reconcile    boot service: re-apply if the map reset it
 *
 * The offset comes from safearea.local.conf (a `safe=WxH+X+Y` line) if present,
 * else the shipped safearea.conf, else the built-in Yandex default. Node 8 on
 * the unit, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var lock = require('./remount_lock.js');

var HERE = __dirname;
var SHIPPED_CONF = path.join(HERE, 'safearea.conf');
var LOCAL_CONF = path.join(HERE, '..', 'safearea.local.conf');
var TARGET = process.env.WOC_CARPLAY || '/usr/bin/carplay';
var RUNNING = TARGET + '.woc-safearea-running';
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';
var RUNDIR = process.env.WOC_RUNDIR || '/dev/shm/waze-on-cluster';
var PENDING = path.join(RUNDIR, 'safearea-pending');
/* waze-on-cluster's installed carplay patcher (its files sit beside it). */
var WOC_DIR = process.env.WOC_DIR || '/var/opt/waze-on-cluster/current';
var CP = process.env.WOC_CARPLAY_PATCH || path.join(WOC_DIR, 'carplay_patch.js');
var DEFAULT_SAFE = '504x368+433+72';
/* waze-on-cluster's own default safe area, restored on removal. */
var WOC_DEFAULT_SAFE = process.env.WOC_DEFAULT_SAFE || '504x368+286+72';

function log(line) { process.stdout.write('[' + new Date().toISOString() + '] safearea: ' + line + '\n'); }

/* The wanted safe area: the conf's `safe=` line, else the Yandex default. */
function wantSafe() {
    var file = fs.existsSync(LOCAL_CONF) ? LOCAL_CONF : SHIPPED_CONF, text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {}
    var m = text && /^[ \t]*safe[ \t]*=[ \t]*(\S+)/m.exec(text);
    var v = m ? m[1] : DEFAULT_SAFE;
    return /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/.test(v) ? v : DEFAULT_SAFE;
}

/* carplay_patch.js status, parsed. Read-only, no remount. cb({ readable,
 * panel: 'HIGH'|'MID'|null, resPatched, safe: 'WxH+X+Y'|null, sink: url|null }). */
function cpStatus(cb) {
    cp.execFile(process.execPath, [CP, 'status', '--target', TARGET], { timeout: 30000 }, function (err, out) {
        var t = (out || '') + '';
        var variant = /variant:\s+PATCHED -> IC_(HIGH|MID)/.exec(t);
        var safeM = /res:\s+PATCHED \(IC_HIGH advertises [^,\n]*, safe (\d+x\d+) at (\d+),(\d+)\)/.exec(t);
        var redirect = /sink:\s+REDIRECTED -> (\S+)/.exec(t);
        cb({ readable: !!t.trim(), panel: variant ? variant[1] : null, resPatched: /res:\s+PATCHED/.test(t),
             safe: safeM ? safeM[1] + '+' + safeM[2] + '+' + safeM[3] : null, sink: redirect ? redirect[1] : null });
    });
}

function rootIsReadOnly() {
    try {
        var lines = fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n'), opts = null;
        for (var i = 0; i < lines.length; i++) { var p = lines[i].split(' '); if (p[1] === '/') opts = p[3]; }
        if (opts !== null) return /(^|,)ro(,|$)/.test(opts);
    } catch (e) {}
    return false;
}
function remount(rw, cb) { cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: 15000 }, function (err) { cb(err); }); }
function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 0) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}
function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (e) {} }
function dropUnusedRunning() { if (fs.existsSync(RUNNING) && !lock.holds(RUNNING, TARGET)) unlinkQuiet(RUNNING); }

/* Run `carplay_patch.js <args>` with / read-write only for the write, under the
 * shared lock, keeping the running binary hard-linked so / can go read-only
 * again. cb(err, changed). */
function runCp(args, cb) {
    var got = lock.tryAcquire();
    if (!got) log('remount lock busy; proceeding');
    dropUnusedRunning();
    remount(true, function (mErr) {
        if (mErr) { finishRo(new Error('remount rw: ' + mErr.message), false, got, cb); return; }
        var linked = false;
        if (!fs.existsSync(RUNNING)) { try { fs.linkSync(TARGET, RUNNING); linked = true; } catch (e) { log('keeping the running carplay linked failed: ' + e.message); } }
        cp.execFile(process.execPath, [CP].concat(args), { timeout: 60000 }, function (pErr, out, errOut) {
            ((out || '') + '').split('\n').forEach(function (l) { if (l.trim()) log('carplay_patch: ' + l.trim()); });
            if (errOut) (errOut + '').split('\n').forEach(function (l) { if (l.trim()) log('carplay_patch: ' + l.trim()); });
            var text = (out || '') + '';
            var changed = !pErr && !/nothing to do|already in the requested state/i.test(text);
            if (linked && !changed && !lock.holds(RUNNING, TARGET)) unlinkQuiet(RUNNING);
            finishRo(pErr || null, changed, got, cb);
        });
    });
}
function finishRo(err, changed, haveLock, cb) {
    remountRo(3, function (roErr) {
        if (roErr) log('WARNING: ' + roErr.message + ' — the next head-unit start mounts / read-only again');
        if (haveLock) lock.release();
        cb(err, changed);
    });
}
function ensureRunDir() { try { fs.mkdirSync(RUNDIR, 0o755); } catch (e) {} }
function writePending(action) { ensureRunDir(); try { fs.writeFileSync(PENDING, JSON.stringify({ action: action }) + '\n', { mode: 0o644 }); } catch (e) {} }
function finish(result, code) { process.stdout.write(JSON.stringify(result) + '\n'); process.exit(code); }

/* The apply args for the high panel with the wanted safe area, preserving a
 * redirected capture sink so the HUD/capture setup is not reset. */
function applyArgs(safe, st) {
    var args = ['apply', '--panel', 'high', '--target', TARGET, '--yes'];
    if (safe) args.push('--safe', safe);
    if (st.sink) args.push('--sink', st.sink);
    return args;
}

/* Guard shared by activate/reconcile/deactivate: carplay_patch must exist and
 * the cluster map must be enabled on the high panel. onReady(st) when it is;
 * otherwise reports why and exits 0 (never fails the hook / enables the map). */
function withEnabledMap(what, onReady) {
    if (!fs.existsSync(CP)) { finish({ status: 'waze-on-cluster not installed (' + CP + '); nothing to do' }, 0); return; }
    cpStatus(function (st) {
        if (!st.readable) { finish({ status: 'carplay status unreadable; nothing to do' }, 0); return; }
        if (st.panel !== 'HIGH' || !st.resPatched) { finish({ status: 'the cluster map is not enabled; ' + what + ' skipped (it takes effect once the map is on)' }, 0); return; }
        onReady(st);
    });
}

/* Install/update hook: set the Yandex safe area via waze-on-cluster's patcher.
 * Always exits 0 so a failure never rolls the Store update back. */
function activate() {
    var want = wantSafe();
    withEnabledMap('apply', function (st) {
        if (st.safe === want) { finish({ status: 'already set (' + want + ')' }, 0); return; }
        runCp(applyArgs(want, st), function (err, changed) {
            var result = {};
            if (err) result.status = 'not applied now (reconciled at the next boot): ' + err.message;
            else if (changed) { writePending('apply'); result.reboot = 'Yandex safe area ' + want + ' written; takes effect at the next head-unit start'; result.status = 'safe area written'; }
            else result.status = 'already set';
            finish(result, 0);
        });
    });
}

/* Removal hook: restore waze-on-cluster's own default safe area (apply without
 * --safe), keeping the map on. Always exits 0 so removal is never refused. It
 * keeps no backup, so there is nothing of its own to drop. */
function deactivate() {
    if (!fs.existsSync(CP)) { finish({ status: 'waze-on-cluster not installed; nothing to restore' }, 0); return; }
    cpStatus(function (st) {
        if (st.panel !== 'HIGH' || !st.resPatched) {
            if (fs.existsSync(RUNNING)) finish({ status: 'the cluster map is not enabled; nothing to restore', removeWhenUnused: [RUNNING] }, 0);
            else finish({ status: 'the cluster map is not enabled; nothing to restore' }, 0);
            return;
        }
        runCp(applyArgs(WOC_DEFAULT_SAFE, st), function (err, changed) {
            var result = {};
            if (err) result.status = 'left as is (could not restore): ' + err.message;
            else if (changed) { writePending('revert'); result.reboot = 'safe area restored to waze-on-cluster\'s default ' + WOC_DEFAULT_SAFE + '; takes effect at the next head-unit start'; result.status = 'safe area restored'; }
            else result.status = 'already at waze-on-cluster\'s default';
            if (fs.existsSync(RUNNING)) result.removeWhenUnused = [RUNNING];
            finish(result, 0);
        });
    });
}

/* Boot service: re-apply the Yandex safe area if Enable map reset it. Exits 0
 * whatever the state (map off, unreadable, write failed): the next boot tries
 * again. */
function reconcile() {
    var want = wantSafe();
    if (!fs.existsSync(CP)) { log('reconcile: waze-on-cluster not installed'); process.exit(0); }
    cpStatus(function (st) {
        function done() { dropUnusedRunning(); process.exit(0); }
        if (!st.readable || st.panel !== 'HIGH' || !st.resPatched) { log('reconcile: the cluster map is not enabled; nothing to do'); done(); return; }
        if (st.safe === want) { log('reconcile: already set (' + want + ')'); done(); return; }
        runCp(applyArgs(want, st), function (err, changed) {
            if (err) log('reconcile: ' + err.message);
            else if (changed) { writePending('apply'); log('reconcile: re-applied ' + want + '; takes effect at the next head-unit start'); }
            else log('reconcile: nothing to do');
            done();
        });
    });
}

function main() {
    var cmd = process.argv[2];
    if (cmd === 'activate') activate();
    else if (cmd === 'deactivate') deactivate();
    else if (cmd === 'reconcile') reconcile();
    else { process.stderr.write('usage: safearead.js activate|deactivate|reconcile\n'); process.exit(2); }
}
main();
