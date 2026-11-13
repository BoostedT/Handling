(function () {
    'use strict';

    function resourceName() {
        return (window.GetParentResourceName && window.GetParentResourceName()) || 'handling_editor';
    }

    function postNui(name, data) {
        return fetch('https://' + resourceName() + '/' + name, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(data || {}),
        }).catch(function () { /* NUI callback endpoint not reachable outside the game */ });
    }

    // ---- small persisted UI preferences (per game client) -------------------

    function loadPref(key, fallback) {
        try {
            var v = localStorage.getItem('handling_editor.' + key);
            return v === null ? fallback : JSON.parse(v);
        } catch (e) { return fallback; }
    }

    function savePref(key, value) {
        try { localStorage.setItem('handling_editor.' + key, JSON.stringify(value)); } catch (e) { /* no storage */ }
    }

    var state = {
        groups: [],
        byName: {},
        groupOf: {}, // fieldName -> group index
        handlingName: '',
        displayName: '',
        values: {}, // fieldName -> current value (what's applied live / to be saved)
        baseline: {}, // fieldName -> value in handling.meta (once the file lookup answers)
        car: {}, // fieldName -> what the car is really running (the client sends it every second)
        adopted: {}, // fieldName -> name of a running script that adjusts it on top of your value
        lastEdit: {}, // fieldName -> Date.now() of your last edit (the car needs a moment to report it)
        guideHidden: loadPref('guideHidden', false),
        toldLive: false, // shown the "that's on your car now" hint this session
        view: 'group', // 'group' | 'changes' | 'presets' | 'bulk' | 'tools' | 'history' | 'access' | 'offroad' | 'crawl' | ...
        activeGroup: 0,
        filter: '',
        changedOnly: false,
        showDesc: loadPref('showDesc', true),
        showTelemetry: loadPref('showTelemetry', true),
        speedUnit: loadPref('speedUnit', 'kmh'), // 'kmh' | 'mph'
        flagsOpen: {}, // fieldName -> true while that flags field's bit list is expanded
        touched: {}, // fieldName -> true once you've edited it; these are what bulk apply uses
        access: { perms: {} }, // { role, roleLabel, via, discord, perms: { open, save, ... } } from the server
        lock: null, // { by, t, reason } when the loaded vehicle is locked
        handling: '', // the <handlingName> the file lookup resolved to (locks and history use this)
        fileNow: 0, // server clock (unix seconds) when the file lookup answered
        saving: false,
        sharedPresets: null, // null = not fetched yet; else [{ id, name, values, by, t, mine, canDelete }]
        sharedNow: 0,
        history: null, // { entries, now, handling } once fetched
        historyAll: false, // History tab: every vehicle instead of just this one
        accessData: null, // Access tab: { users, online, roles, assignable, me, now }
        locksData: null, // Access tab: [{ handling, by, t, reason }]
        classes: [], // [{ id, name, count }] game vehicle classes that have models
        classId: null, // class of the vehicle you're sitting in
        resource: '', // resource the current vehicle's handling.meta lives in (once found)
        scopeModels: [], // [{ name, label }] models the server confirmed for the class/resource being applied
        excluded: {}, // model name -> true for vehicles the user unticked
        scopeWhere: '', // " in <resource>" / " across ALL resources", for the summary text
        scopeClassName: '',
        presets: loadPresets(), // [{ id, name, values }] saved locally in this browser profile
        targetModel: '', // Copy Handling target: '' = none picked; else another model's name from `resource`
        presetTarget: '', // Presets tab target: '' = the vehicle you're in; else another model's name
        resourceTargets: [], // [{ name, label }] other vehicles found in `resource`, for the Copy Handling dropdown
        targetsResource: null, // which resource resourceTargets was fetched for
        targetsLoading: false,
        telemetry: null, // last telemetry message, re-rendered when the unit changes
    };

    var root = document.getElementById('root');
    var panel = document.getElementById('panel');
    var handlingNameInput = document.getElementById('handling-name');
    var vehicleSub = document.getElementById('vehicle-sub');
    var sourceLine = document.getElementById('source-line');
    var filterInput = document.getElementById('filter');
    var changedOnlyBtn = document.getElementById('changed-only-btn');
    var descBtn = document.getElementById('desc-btn');
    var groupNav = document.getElementById('group-nav');
    var fieldsScroll = document.getElementById('fields-scroll');
    var fieldsEl = document.getElementById('fields');
    var bulkPanel = document.getElementById('bulk-panel');
    var toast = document.getElementById('toast');
    var saveBtn = document.getElementById('save-btn');
    var saveCount = document.getElementById('save-count');
    var undoBtn = document.getElementById('undo-btn');
    var redoBtn = document.getElementById('redo-btn');
    var shortcutHint = document.getElementById('shortcut-hint');
    var SHORTCUTS_TEXT = shortcutHint.textContent;
    var classBar = document.getElementById('class-bar');
    var classSelect = document.getElementById('class-select');
    var scopeSelect = document.getElementById('scope-select');
    var classConfirm = document.getElementById('class-confirm');
    var classSummary = document.getElementById('class-summary');
    var classSaveBtn = document.getElementById('class-save-btn');
    var classModels = document.getElementById('class-models');
    var classModelFilter = document.getElementById('class-model-filter');
    var classHead = null; // headline element inside #class-summary
    var copyTargetSelect = document.getElementById('copy-target-select');
    var copyBtn = document.getElementById('copy-btn');
    var copyHint = document.getElementById('copy-hint');
    var modal = document.getElementById('modal');
    var modalTitle = document.getElementById('modal-title');
    var modalText = document.getElementById('modal-text');
    var modalArea = document.getElementById('modal-area');
    var modalActions = document.getElementById('modal-actions');

    var fieldEls = {}; // fieldName -> rendered .field element (current view only)

    // ---- permissions ------------------------------------------------------
    // What the server says this player's role can do. The server checks every
    // request on its own; this only decides which tabs and buttons to show.

    function can(perm) {
        return !!(state.access && state.access.perms && state.access.perms[perm]);
    }

    var DENIED_TEXT = 'Your handling editor role doesn\'t allow this.';

    // ---- requests to the server (History, Access, shared presets, locks) ---

    var rpcSeq = 0;
    var rpcWaiting = {};

    function rpc(name, args) {
        return new Promise(function (resolve) {
            var id = ++rpcSeq;
            rpcWaiting[id] = resolve;
            postNui('rpc', { id: id, name: name, args: args || {} });
            setTimeout(function () {
                if (rpcWaiting[id]) {
                    delete rpcWaiting[id];
                    resolve({ ok: false, message: 'The server didn\'t answer. Try again.' });
                }
            }, 20000);
        });
    }

    // "5m ago" from two unix-second timestamps on the server's clock.
    function ago(t, now) {
        if (!t) return '';
        var s = Math.max(0, (now || t) - t);
        if (s < 45) return 'just now';
        if (s < 3600) return Math.round(s / 60) + 'm ago';
        if (s < 86400) return Math.round(s / 3600) + 'h ago';
        if (s < 86400 * 14) return Math.round(s / 86400) + 'd ago';
        return new Date(t * 1000).toLocaleDateString();
    }

    function fullDate(t) {
        return t ? new Date(t * 1000).toLocaleString() : '';
    }

    var lastSent = {};
    function sendLive(fieldName, value) {
        var now = performance.now();
        state.lastEdit[fieldName] = Date.now();
        if (lastSent[fieldName] !== undefined && now - lastSent[fieldName] < 16) return;
        lastSent[fieldName] = now;
        postNui('live', { field: fieldName, value: value });
    }

    function forceSendLive(fieldName, value) {
        lastSent[fieldName] = performance.now();
        state.lastEdit[fieldName] = Date.now();
        postNui('live', { field: fieldName, value: value });
    }

    var KMH_PER_MPH = 1.609344;

    function fmt(n) {
        if (typeof n !== 'number' || isNaN(n)) return '';
        var r = Math.round(n * 1000) / 1000;
        return String(r);
    }

    // The game reports handling values as float32 (3.1 -> 3.0999999046...); strip that noise
    // so inputs stay readable and saved values match what the user sees.
    function clean(v) {
        if (typeof v === 'number') return isFinite(v) ? Math.round(v * 100000) / 100000 : v;
        if (v && typeof v === 'object') {
            var out = {};
            Object.keys(v).forEach(function (k) { out[k] = clean(v[k]); });
            return out;
        }
        return v;
    }

    function cleanValues(values) {
        return clean(values || {});
    }

    function clone(v) {
        return (v && typeof v === 'object') ? { x: v.x, y: v.y, z: v.z } : v;
    }

    function clampNum(n, min, max) {
        if (min !== undefined && n < min) n = min;
        if (max !== undefined && n > max) n = max;
        return n;
    }

    // Rounds to the precision of the field's step so wheel nudges don't drift
    // into 0.30000000004 territory.
    function roundToStep(v, step) {
        var s = String(step || 0.01);
        var decimals = s.indexOf('.') === -1 ? 0 : s.length - s.indexOf('.') - 1;
        return parseFloat(v.toFixed(Math.min(decimals + 1, 6)));
    }

    function isNumeric(field) {
        return field.type === 'float' || field.type === 'int' || field.type === 'vector';
    }

    function parseHex(s) {
        if (typeof s !== 'string' || !/^[0-9a-fA-F]+$/.test(s.trim())) return null;
        return parseInt(s.trim(), 16) >>> 0;
    }

    function numEq(a, b) {
        return Math.abs(a - b) <= 1e-4 + Math.abs(b) * 1e-5;
    }

    function sameValue(field, a, b) {
        if (a === undefined || a === null || b === undefined || b === null) return a === b;
        if (field.type === 'vector') {
            return numEq(a.x, b.x) && numEq(a.y, b.y) && numEq(a.z, b.z);
        }
        if (field.type === 'float' || field.type === 'int') return numEq(a, b);
        if (field.type === 'flags') {
            var ha = parseHex(String(a)), hb = parseHex(String(b));
            if (ha !== null && hb !== null) return ha === hb;
        }
        return String(a).trim() === String(b).trim();
    }

    // Differs from what's in handling.meta (only once the file values are known).
    function isChanged(name) {
        var field = state.byName[name];
        var base = state.baseline[name];
        if (!field || base === undefined || base === null) return false;
        var cur = state.values[name];
        if (cur === undefined || cur === null) return false;
        return !sameValue(field, cur, base);
    }

    function changedNames() {
        return Object.keys(state.byName).filter(isChanged);
    }

    function valueText(v) {
        if (v && typeof v === 'object') return fmt(v.x) + ', ' + fmt(v.y) + ', ' + fmt(v.z);
        return typeof v === 'number' ? fmt(v) : String(v);
    }

    function baselineText(field) {
        var b = state.baseline[field.name];
        if (b === undefined || b === null) return '';
        if (field.type === 'vector') {
            return 'file: ' + fmt(b.x) + ', ' + fmt(b.y) + ', ' + fmt(b.z);
        }
        if (field.mph && typeof b === 'number') {
            return 'file: ' + fmt(b) + ' (' + fmt(Math.round(b / KMH_PER_MPH * 10) / 10) + ' mph)';
        }
        return 'file: ' + (typeof b === 'number' ? fmt(b) : b);
    }

    // Short "how far from the file value" badge.
    function deltaInfo(field) {
        if (!isChanged(field.name)) return null;
        var cur = state.values[field.name];
        var base = state.baseline[field.name];
        if (field.type === 'float' || field.type === 'int') {
            var d = cur - base;
            var pct = base !== 0 ? (d / Math.abs(base)) * 100 : null;
            return {
                text: (d > 0 ? '+' : '') + fmt(d),
                cls: d > 0 ? 'up' : 'down',
                title: pct !== null ? ((pct > 0 ? '+' : '') + pct.toFixed(1) + '% vs file') : 'vs file',
            };
        }
        if (field.type === 'flags') {
            var a = parseHex(String(cur)), b = parseHex(String(base));
            if (a !== null && b !== null) {
                var x = (a ^ b) >>> 0, n = 0;
                while (x) { n += x & 1; x >>>= 1; }
                return { text: n + ' bit' + (n === 1 ? '' : 's'), cls: 'neutral', title: 'Bits that differ from the file' };
            }
        }
        return { text: 'changed', cls: 'neutral', title: 'Differs from the file' };
    }

    // ---- undo / redo ------------------------------------------------------
    // Each entry is a list of { name, before, after }. Wheel nudges on the same
    // field within a short window are merged into one entry.

    var undoStack = [];
    var redoStack = [];
    var MAX_HISTORY = 200;

    function record(changes, coalesce) {
        changes = changes.filter(function (c) {
            var field = state.byName[c.name];
            return field && !sameValue(field, c.before, c.after);
        });
        if (!changes.length) return;
        var now = Date.now();
        var last = undoStack[undoStack.length - 1];
        if (coalesce && last && last.coalesce && last.changes.length === 1 && changes.length === 1 &&
            last.changes[0].name === changes[0].name && now - last.time < 800) {
            last.changes[0].after = clone(changes[0].after);
            last.time = now;
        } else {
            undoStack.push({
                changes: changes.map(function (c) { return { name: c.name, before: clone(c.before), after: clone(c.after) }; }),
                time: now,
                coalesce: !!coalesce,
            });
            if (undoStack.length > MAX_HISTORY) undoStack.shift();
        }
        redoStack = [];
        scheduleIndicators();
    }

    function applyHistory(entry, useBefore) {
        entry.changes.forEach(function (c) {
            var field = state.byName[c.name];
            if (!field) return;
            var v = clone(useBefore ? c.before : c.after);
            state.values[c.name] = v;
            state.touched[c.name] = true;
            if (isNumeric(field) && v !== undefined && v !== null) forceSendLive(c.name, v);
        });
        renderContent();
        scheduleIndicators();
    }

    function undo() {
        var entry = undoStack.pop();
        if (!entry) return;
        redoStack.push(entry);
        applyHistory(entry, true);
        setToast('Undid ' + describeEntry(entry) + '.');
    }

    function redo() {
        var entry = redoStack.pop();
        if (!entry) return;
        undoStack.push(entry);
        applyHistory(entry, false);
        setToast('Redid ' + describeEntry(entry) + '.');
    }

    function describeEntry(entry) {
        if (entry.changes.length === 1) {
            var f = state.byName[entry.changes[0].name];
            return f ? (f.label || f.name) : entry.changes[0].name;
        }
        return entry.changes.length + ' fields';
    }

    // Applies a value from the UI: state, touched mark, live preview.
    function setValue(field, value, live) {
        state.values[field.name] = value;
        state.touched[field.name] = true;
        state.lastEdit[field.name] = Date.now();
        if (isNumeric(field)) {
            if (live === 'throttle') sendLive(field.name, value);
            else forceSendLive(field.name, value);
            if (live !== 'throttle') explainEdit(field);
        }
    }

    // ---- when an edit reaches the car ----------------------------------------
    // `apply` comes from shared/fields.lua. Live fields need no tag.

    var APPLY_TAGS = {
        spawn: {
            text: 'on respawn',
            title: 'The game reads this when the car spawns, so a live change may do little or nothing until the car is respawned. ' +
                'To feel it for sure: Save to file, restart the vehicle\'s pack, then spawn the car again.',
        },
        file: {
            text: 'save + restart',
            title: 'Can\'t be tried live. Save to file, restart the vehicle\'s pack, then respawn the car.',
        },
        none: {
            text: 'info only',
            title: 'Doesn\'t change how the car drives.',
        },
    };

    var ADOPTED_TEXT = {
        'Boosted-Offroad': 'Boosted-Offroad raises this on loose ground, starting from your value, so the car can read higher off-road.',
        'RealisticVehicleFailure': 'RealisticVehicleFailure scales this with how hard you press the brake, up to your value.',
    };

    // A short hint after an edit: the first one of the session, or one that
    // won't show on the car until it respawns.
    function explainEdit(field) {
        var label = field.label || field.name;
        if (field.apply === 'spawn') {
            setToast(label + ' is read when the car spawns, so you may not feel it until you Save, restart ' +
                (state.resource || 'the vehicle\'s pack') + ' and respawn the car.');
            return;
        }
        if (!state.toldLive) {
            state.toldLive = true;
            setToast('That\'s on your car now. Press Drive (or F6) to test it, then Save to file to keep it.', 'ok');
        }
    }

    // The car runs something other than the panel shows, e.g. another script
    // changed it, or the file was saved but the pack hasn't restarted yet.
    function carDiff(field) {
        if (!isNumeric(field) || field.apply === 'file' || field.apply === 'none') return null;
        if (state.adopted[field.name]) return null;
        var car = state.car[field.name];
        var cur = state.values[field.name];
        if (car === undefined || car === null || cur === undefined || cur === null) return null;
        if (state.lastEdit[field.name] && Date.now() - state.lastEdit[field.name] < 2500) return null;
        if (sameValue(field, car, cur)) return null;
        return {
            text: valueText(car),
            title: state.touched[field.name]
                ? 'Your car reads ' + valueText(car) + ' instead of your value. Another script keeps changing it, so you may not feel your edit.'
                : 'Your car is running ' + valueText(car) + ' right now, not the value shown. An op-mechanic tuning kit or another script (damage settings) may have changed it, ' +
                  'or the file was saved and the pack hasn\'t restarted yet.\n\nChange the value here or press Reset to file to put the shown value on the car. ' +
                  'Saving writes the shown value, not the car\'s.',
        };
    }

    // ---- indicators: nav badges, save count, undo buttons -----------------

    var indicatorsQueued = false;
    function scheduleIndicators() {
        if (indicatorsQueued) return;
        indicatorsQueued = true;
        requestAnimationFrame(function () {
            indicatorsQueued = false;
            updateIndicators();
        });
    }

    function updateIndicators() {
        var changed = changedNames();
        saveCount.hidden = !changed.length;
        saveCount.textContent = changed.length;
        saveBtn.title = changed.length
            ? ('Write to handling.meta (Ctrl+S) - ' + changed.length + ' field' + (changed.length === 1 ? '' : 's') + ' differ from the file')
            : 'Write to handling.meta (Ctrl+S)';
        // Footer line: unsaved changes when there are any, the shortcuts otherwise.
        shortcutHint.classList.toggle('pending', changed.length > 0);
        shortcutHint.textContent = changed.length
            ? changed.length + ' change' + (changed.length === 1 ? '' : 's') + ' on your car, not saved yet'
            : SHORTCUTS_TEXT;
        undoBtn.disabled = !undoStack.length;
        redoBtn.disabled = !redoStack.length;
        undoBtn.title = undoStack.length ? ('Undo ' + describeEntry(undoStack[undoStack.length - 1]) + ' (Ctrl+Z)') : 'Undo (Ctrl+Z)';
        redoBtn.title = redoStack.length ? ('Redo ' + describeEntry(redoStack[redoStack.length - 1]) + ' (Ctrl+Y)') : 'Redo (Ctrl+Y)';
        renderGroupNav(changed);
        refreshSetupReadout();
    }

    // ---- navigation ---------------------------------------------------------

    function navButton(text, active, badge, extraClass, onClick) {
        var btn = document.createElement('button');
        btn.className = 'group-btn' + (extraClass ? ' ' + extraClass : '') + (active ? ' active' : '');
        var label = document.createElement('span');
        label.className = 'nav-label';
        label.textContent = text;
        btn.appendChild(label);
        if (badge) {
            var b = document.createElement('span');
            b.className = 'nav-badge';
            b.textContent = badge;
            btn.appendChild(b);
        }
        btn.addEventListener('click', onClick);
        groupNav.appendChild(btn);
        return btn;
    }

    function navSection(text) {
        var s = document.createElement('div');
        s.className = 'nav-section';
        s.textContent = text;
        groupNav.appendChild(s);
    }

    function setView(view, groupIdx) {
        state.view = view;
        if (groupIdx !== undefined) state.activeGroup = groupIdx;
        if (view !== 'group' || groupIdx !== undefined) {
            filterInput.value = '';
            state.filter = '';
        }
        fieldsScroll.scrollTop = 0;
        render();
    }

    function renderGroupNav(changed) {
        changed = changed || changedNames();
        var perGroup = {};
        changed.forEach(function (name) {
            var g = state.groupOf[name];
            perGroup[g] = (perGroup[g] || 0) + 1;
        });
        var searching = !!(state.filter || state.changedOnly);

        groupNav.innerHTML = '';
        navSection('Fields');
        state.groups.forEach(function (group, idx) {
            navButton(group.name, state.view === 'group' && !searching && idx === state.activeGroup,
                perGroup[idx], '', function () {
                    if (state.changedOnly) setChangedOnly(false);
                    setView('group', idx);
                });
        });

        var sep = document.createElement('div');
        sep.className = 'group-nav-sep';
        groupNav.appendChild(sep);
        navSection('Tune for');
        navButton('Police', state.view === 'police', null, '', function () { setView('police'); });
        navButton('Street & track', state.view === 'street', null, '', function () { setView('street'); });
        navButton('Drift', state.view === 'drift', null, '', function () { setView('drift'); });
        navButton('Pickups & trucks', state.view === 'pickup', payload.kg ? 'load' : null, '', function () { setView('pickup'); });
        navButton('Off-road setup', state.view === 'offroad', null, '', function () { setView('offroad'); });
        navButton('Crawling', state.view === 'crawl', anyAidOn() ? 'on' : null, '', function () { setView('crawl'); });

        var sep2 = document.createElement('div');
        sep2.className = 'group-nav-sep';
        groupNav.appendChild(sep2);
        navSection('Workspace');
        navButton('Changes', state.view === 'changes', changed.length, '', function () { setView('changes'); });
        navButton('★ Presets', state.view === 'presets', state.presets.length || null, 'preset-tab-btn', function () { setView('presets'); });
        if (can('bulk')) navButton('Bulk & copy', state.view === 'bulk', null, '', function () { setView('bulk'); });
        navButton('Tools', state.view === 'tools', state.lock ? 'lock' : null, '', function () { setView('tools'); });
        if (can('history')) navButton('History', state.view === 'history', null, '', function () { setView('history'); });
        if (can('manage') || can('lock')) navButton('Access', state.view === 'access', null, 'access-tab-btn', function () { setView('access'); });
    }

    // ---- field cards ------------------------------------------------------

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function buildFieldEl(field) {
        var wrap = el('div', 'field' + (field.type === 'vector' ? ' vector' : '') +
            ((field.type === 'string' || field.type === 'flags') ? ' wide-text' : '') +
            (state.touched[field.name] ? ' touched' : ''));

        var top = el('div', 'field-top');
        var left = el('div', 'field-left');
        var label = el('span', 'field-label', field.label || field.name);
        label.title = field.name + (field.desc ? '\n' + field.desc : '');
        if (state.showDesc) label.appendChild(el('span', 'fname', field.name));
        left.appendChild(label);
        var tagInfo = APPLY_TAGS[field.apply];
        if (tagInfo) {
            var tag = el('span', 'apply-tag ' + field.apply, tagInfo.text);
            tag.title = tagInfo.title;
            left.appendChild(tag);
        }
        var meta = el('div', 'field-meta');
        var carTag = el('span', 'car-tag');
        carTag.hidden = true;
        var delta = el('span', 'field-delta');
        var base = el('span', 'field-baseline');
        var revert = el('button', 'revert-btn', '↺');
        revert.addEventListener('click', function () { revertField(field.name); });
        meta.appendChild(carTag);
        meta.appendChild(delta);
        meta.appendChild(base);
        meta.appendChild(revert);
        top.appendChild(left);
        top.appendChild(meta);
        wrap.appendChild(top);

        if (state.showDesc && field.desc) wrap.appendChild(el('div', 'field-desc', field.desc));
        if (state.showDesc && state.adopted[field.name] && ADOPTED_TEXT[state.adopted[field.name]]) {
            wrap.appendChild(el('div', 'field-desc adopted', ADOPTED_TEXT[state.adopted[field.name]]));
        }

        var controls = el('div', 'field-controls');
        var current = state.values[field.name];
        var extraRefresh = null; // control-specific refresh (file marker, bit highlights)

        function touch() { wrap.classList.add('touched'); }

        if (field.type === 'float' || field.type === 'int') {
            var num = typeof current === 'number' ? current : (field.min || 0);
            var step = field.step || (field.type === 'int' ? 1 : 0.01);

            var rangeWrap = el('div', 'range-wrap');
            var range = document.createElement('input');
            range.type = 'range';
            range.min = field.min;
            range.max = field.max;
            range.step = step;
            range.value = num;
            var mark = el('div', 'file-mark');
            rangeWrap.appendChild(range);
            rangeWrap.appendChild(mark);

            var numberInput = document.createElement('input');
            numberInput.type = 'number';
            numberInput.step = step;
            numberInput.value = num;

            function pct(v) {
                var span = field.max - field.min;
                return span > 0 ? Math.max(0, Math.min(1, (v - field.min) / span)) : 0;
            }
            function setFill(v) {
                range.style.setProperty('--fill', 'calc(7px + (100% - 14px) * ' + pct(v) + ')');
            }
            extraRefresh = function () {
                var b = state.baseline[field.name];
                mark.hidden = typeof b !== 'number';
                if (typeof b === 'number') {
                    mark.style.setProperty('--p', pct(b));
                    mark.title = 'File value: ' + fmt(b);
                }
            };
            setFill(num);

            // Fields flagged `mph` (km/h values) get a second, editable mph box.
            var mphInput = null;
            function syncMph(kmh) {
                if (mphInput) mphInput.value = Math.round(kmh / KMH_PER_MPH * 10) / 10;
            }

            // Every way of changing the value funnels through here.
            function commit(v, before, coalesce) {
                v = clampNum(v, field.min, field.max);
                if (field.type === 'int') v = Math.round(v);
                numberInput.value = v;
                range.value = v;
                setFill(v);
                syncMph(v);
                setValue(field, v);
                touch();
                record([{ name: field.name, before: before, after: v }], coalesce);
                refresh();
            }

            var dragBefore;
            range.addEventListener('input', function () {
                if (dragBefore === undefined) dragBefore = state.values[field.name];
                var v = parseFloat(range.value);
                numberInput.value = v;
                setFill(v);
                syncMph(v);
                setValue(field, v, 'throttle');
                touch();
                refresh();
            });
            range.addEventListener('change', function () {
                var before = dragBefore !== undefined ? dragBefore : state.values[field.name];
                dragBefore = undefined;
                commit(parseFloat(range.value), before);
            });
            numberInput.addEventListener('change', function () {
                var v = parseFloat(numberInput.value);
                if (isNaN(v)) { numberInput.value = state.values[field.name]; return; }
                commit(v, state.values[field.name]);
            });
            // Scroll over the focused box to nudge by one step (Shift = x10, Alt = x0.1).
            // Unfocused boxes leave the wheel alone so scrolling the list never edits values.
            numberInput.addEventListener('wheel', function (e) {
                if (document.activeElement !== numberInput) return;
                e.preventDefault();
                var cur = typeof state.values[field.name] === 'number' ? state.values[field.name] : num;
                var mult = e.shiftKey ? 10 : (e.altKey ? 0.1 : 1);
                var dir = e.deltaY < 0 ? 1 : -1;
                commit(roundToStep(cur + dir * step * mult, step * (e.altKey ? 0.1 : 1)), cur, true);
            }, { passive: false });

            // With help on, the slider's ends say what each direction does.
            if (state.showDesc && (field.lo || field.hi)) {
                var rangeCol = el('div', 'range-col');
                rangeCol.appendChild(rangeWrap);
                var caps = el('div', 'range-caps');
                caps.appendChild(el('span', '', field.lo ? '◂ ' + field.lo : ''));
                caps.appendChild(el('span', '', field.hi ? field.hi + ' ▸' : ''));
                rangeCol.appendChild(caps);
                controls.appendChild(rangeCol);
            } else {
                controls.appendChild(rangeWrap);
            }
            controls.appendChild(numberInput);

            if (field.mph) {
                controls.appendChild(el('span', 'unit', 'km/h'));
                mphInput = document.createElement('input');
                mphInput.type = 'number';
                mphInput.step = 0.1;
                mphInput.title = 'Same value in mph - edit to set km/h';
                syncMph(num);
                mphInput.addEventListener('change', function () {
                    var mph = parseFloat(mphInput.value);
                    if (isNaN(mph)) return;
                    commit(Math.round(mph * KMH_PER_MPH * 100) / 100, state.values[field.name]);
                });
                controls.appendChild(mphInput);
                controls.appendChild(el('span', 'unit', 'mph'));
            }
        } else if (field.type === 'vector') {
            var vec = (current && typeof current === 'object') ? current : { x: 0, y: 0, z: 0 };
            ['x', 'y', 'z'].forEach(function (axis) {
                var cell = el('div', 'vec-axis ' + axis);
                cell.appendChild(el('span', '', axis.toUpperCase()));
                var input = document.createElement('input');
                input.type = 'number';
                input.step = field.step || 0.01;
                input.value = vec[axis];
                function commitAxis(v, coalesce) {
                    v = clampNum(v, field.min, field.max);
                    input.value = v;
                    var before = state.values[field.name] || { x: 0, y: 0, z: 0 };
                    var next = { x: before.x, y: before.y, z: before.z };
                    next[axis] = v;
                    setValue(field, next);
                    touch();
                    record([{ name: field.name, before: before, after: next }], coalesce);
                    refresh();
                }
                input.addEventListener('change', function () {
                    var v = parseFloat(input.value);
                    commitAxis(isNaN(v) ? 0 : v);
                });
                input.addEventListener('wheel', function (e) {
                    if (document.activeElement !== input) return;
                    e.preventDefault();
                    var s = field.step || 0.01;
                    var cur = (state.values[field.name] || vec)[axis] || 0;
                    commitAxis(roundToStep(cur + (e.deltaY < 0 ? 1 : -1) * s * (e.shiftKey ? 10 : 1), s), true);
                }, { passive: false });
                cell.appendChild(input);
                controls.appendChild(cell);
            });
        } else {
            // flags / string: file-only, no live preview
            var text = document.createElement('input');
            text.type = 'text';
            text.value = current !== undefined && current !== null ? current : '';
            text.spellcheck = false;
            controls.appendChild(text);

            if (field.type === 'string' && field.options && field.options.length) {
                var listId = 'opts-' + field.name;
                var dl = document.createElement('datalist');
                dl.id = listId;
                field.options.forEach(function (o) {
                    var opt = document.createElement('option');
                    opt.value = o;
                    dl.appendChild(opt);
                });
                text.setAttribute('list', listId);
                controls.appendChild(dl);
            }

            var bitsEl = null;
            function commitText(v) {
                var before = state.values[field.name];
                setValue(field, v);
                touch();
                record([{ name: field.name, before: before, after: v }]);
                refresh();
            }

            text.addEventListener('input', function () {
                text.classList.toggle('invalid', field.type === 'flags' && text.value !== '' && parseHex(text.value) === null);
            });
            text.addEventListener('change', function () {
                var v = text.value.trim();
                if (field.type === 'flags') {
                    if (parseHex(v) === null) {
                        setToast('Flags must be a hex number, e.g. 440010.', 'err');
                        text.value = state.values[field.name] || '';
                        text.classList.remove('invalid');
                        return;
                    }
                }
                commitText(v);
            });

            if (field.type === 'flags' && field.bits && field.bits.length) {
                var toggle = el('button', 'secondary small bits-toggle', state.flagsOpen[field.name] ? 'Bits ▴' : 'Bits ▾');
                toggle.title = 'Edit the individual flags';
                controls.appendChild(toggle);

                bitsEl = el('div', 'bits');
                bitsEl.hidden = !state.flagsOpen[field.name];
                var boxes = [];
                field.bits.forEach(function (bitName, i) {
                    var row = el('label', 'bit');
                    var box = document.createElement('input');
                    box.type = 'checkbox';
                    row.appendChild(box);
                    row.appendChild(el('span', 'bit-idx', String(i)));
                    var nm = el('span', 'bit-name', bitName);
                    row.title = bitName + ' (bit ' + i + ', 0x' + ((1 << i) >>> 0).toString(16).toUpperCase() + ')';
                    row.appendChild(nm);
                    box.addEventListener('change', function () {
                        var cur = parseHex(String(state.values[field.name] || '0'));
                        if (cur === null) cur = 0;
                        var mask = (1 << i) >>> 0;
                        var next = box.checked ? ((cur | mask) >>> 0) : ((cur & ~mask) >>> 0);
                        var useLower = /[a-f]/.test(String(state.baseline[field.name] || state.values[field.name] || ''));
                        var hex = next.toString(16);
                        hex = useLower ? hex : hex.toUpperCase();
                        text.value = hex;
                        text.classList.remove('invalid');
                        commitText(hex);
                    });
                    boxes.push({ box: box, row: row });
                    bitsEl.appendChild(row);
                });

                toggle.addEventListener('click', function () {
                    state.flagsOpen[field.name] = !state.flagsOpen[field.name];
                    bitsEl.hidden = !state.flagsOpen[field.name];
                    toggle.textContent = state.flagsOpen[field.name] ? 'Bits ▴' : 'Bits ▾';
                });

                extraRefresh = function () {
                    var cur = parseHex(String(state.values[field.name] || '0'));
                    var b = parseHex(String(state.baseline[field.name] || ''));
                    boxes.forEach(function (item, i) {
                        var mask = (1 << i) >>> 0;
                        var on = cur !== null && (cur & mask) !== 0;
                        item.box.checked = on;
                        item.row.classList.toggle('on', on);
                        item.row.classList.toggle('diff', b !== null && cur !== null && ((b & mask) !== 0) !== on);
                    });
                };
            }

            if (bitsEl) {
                wrap.appendChild(controls);
                wrap.appendChild(bitsEl);
                controls = null;
            }
        }

        if (controls) wrap.appendChild(controls);

        function refreshCar() {
            var car = carDiff(field);
            carTag.hidden = !car;
            if (car) {
                carTag.textContent = 'car: ' + car.text;
                carTag.title = car.title;
                carTag.classList.toggle('fighting', !!state.touched[field.name]);
            }
        }

        function refresh() {
            var info = deltaInfo(field);
            wrap.classList.toggle('changed', !!info);
            delta.hidden = !info;
            if (info) {
                delta.className = 'field-delta ' + info.cls;
                delta.textContent = info.text;
                delta.title = info.title;
            }
            base.textContent = baselineText(field);
            revert.hidden = !info;
            revert.title = 'Put back the file value (' + valueText(state.baseline[field.name]) + ')';
            refreshCar();
            if (extraRefresh) extraRefresh();
            scheduleIndicators();
        }
        wrap._refresh = refresh;
        wrap._refreshCar = refreshCar;
        refresh();

        fieldEls[field.name] = wrap;
        return wrap;
    }

    function revertField(name) {
        var field = state.byName[name];
        var base = state.baseline[name];
        if (!field || base === undefined || base === null) return;
        var before = state.values[name];
        var after = clone(base);
        state.values[name] = after;
        delete state.touched[name];
        if (isNumeric(field)) forceSendLive(name, after);
        record([{ name: name, before: before, after: after }]);
        renderContent();
        setToast('Reverted ' + (field.label || name) + ' to the file value.');
    }

    function matchesFilter(field) {
        if (!state.filter) return true;
        var needle = state.filter.toLowerCase();
        return field.name.toLowerCase().indexOf(needle) !== -1 ||
            (field.label || '').toLowerCase().indexOf(needle) !== -1 ||
            (field.desc || '').toLowerCase().indexOf(needle) !== -1;
    }

    function emptyMessage(text) {
        fieldsEl.appendChild(el('div', 'empty', text));
    }

    function renderFieldsView() {
        if (state.filter || state.changedOnly) {
            var any = false;
            state.groups.forEach(function (group) {
                var matches = group.fields.filter(function (f) {
                    return matchesFilter(f) && (!state.changedOnly || isChanged(f.name));
                });
                if (!matches.length) return;
                any = true;
                fieldsEl.appendChild(el('div', 'field-group-label', group.name));
                matches.forEach(function (field) { fieldsEl.appendChild(buildFieldEl(field)); });
            });
            if (!any) {
                emptyMessage(state.changedOnly && !state.filter
                    ? 'Nothing differs from handling.meta yet.'
                    : 'No fields match "' + state.filter + '"' + (state.changedOnly ? ' among the changed ones.' : '.'));
            }
            return;
        }

        var group = state.groups[state.activeGroup];
        if (!group) return;
        if (!state.guideHidden) renderGuide();
        if (state.showDesc && group.intro) fieldsEl.appendChild(el('p', 'group-intro', group.intro));
        group.fields.forEach(function (field) {
            fieldsEl.appendChild(buildFieldEl(field));
        });
    }

    // ---- getting-started guide ----------------------------------------------
    // Shown above the fields until you press "Got it"; the ? button brings it back.

    function setGuideHidden(hidden) {
        state.guideHidden = hidden;
        savePref('guideHidden', hidden);
    }

    function renderGuide() {
        var c = el('section', 'card guide');
        var head = el('div', 'guide-head');
        head.appendChild(el('h2', '', 'How the editor works'));
        var gotIt = el('button', 'secondary small', 'Got it');
        gotIt.title = 'Hide this guide. The ? button at the top brings it back.';
        gotIt.addEventListener('click', function () {
            setGuideHidden(true);
            renderContent();
        });
        head.appendChild(gotIt);
        c.appendChild(head);

        var steps = el('ol', 'guide-steps');
        [
            ['Change a value.', 'It goes onto the car you\'re sitting in straight away. Other cars of this model aren\'t touched.'],
            ['Test it.', 'Press Drive (or F6) to get the mouse back and drive. Press F6 again to keep editing.'],
            ['Save to file when you\'re happy.', 'Until then it\'s only on your car. Everyone gets it once the vehicle\'s pack restarts.'],
        ].forEach(function (s) {
            var li = el('li');
            li.appendChild(el('b', '', s[0] + ' '));
            li.appendChild(document.createTextNode(s[1]));
            steps.appendChild(li);
        });
        c.appendChild(steps);

        var legend = el('div', 'guide-legend');
        [
            ['sw-touched', 'Blue outline: you changed it'],
            ['sw-changed', 'Amber edge: differs from the file'],
            ['sw-mark', 'Amber tick on a slider: the file value'],
            ['sw-car', '"car:" what your car is running right now'],
        ].forEach(function (item) {
            var row = el('span', 'legend-item');
            row.appendChild(el('span', 'swatch ' + item[0]));
            row.appendChild(document.createTextNode(item[1]));
            legend.appendChild(row);
        });
        c.appendChild(legend);

        c.appendChild(el('p', 'card-hint guide-foot',
            'Hover any name for an explanation. ↺ puts one field back to the file value, Ctrl+Z undoes. ' +
            'Fields tagged "on respawn" are read when the car spawns, so you only feel them after saving, restarting the pack and respawning. ' +
            'The "Tune for" tabs on the left have ready-made setups if you\'d rather not touch single numbers.'));
        fieldsEl.appendChild(c);
    }

    // A tab the role lost (or never had) falls back to the field groups.
    function viewAllowed(view) {
        if (view === 'bulk') return can('bulk');
        if (view === 'history') return can('history');
        if (view === 'access') return can('manage') || can('lock');
        return true;
    }

    function renderContent() {
        fieldEls = {};
        fieldsEl.innerHTML = '';
        if (!viewAllowed(state.view)) state.view = 'group';
        bulkPanel.hidden = state.view !== 'bulk';
        fieldsEl.hidden = state.view === 'bulk';

        terrainEls = null;
        dynEls = null;
        readouts = [];
        switch (state.view) {
            case 'changes': renderChangesPanel(); break;
            case 'presets': renderPresetsPanel(); break;
            case 'tools': renderToolsPanel(); break;
            case 'history': renderHistoryPanel(); break;
            case 'access': renderAccessPanel(); break;
            case 'bulk': renderCopyBar(); break;
            case 'offroad': renderOffroadPanel(); break;
            case 'crawl': renderCrawlPanel(); break;
            case 'pickup': renderPickupPanel(); break;
            case 'street': renderStreetPanel(); break;
            case 'police': renderPolicePanel(); break;
            case 'drift': renderDriftPanel(); break;
            default: renderFieldsView();
        }
        setLiveWatch(state.view === 'offroad' || state.view === 'crawl',
            state.view === 'street' || state.view === 'drift' || state.view === 'pickup' || state.view === 'police');
        scheduleIndicators();
    }

    function render() {
        renderGroupNav();
        renderContent();
    }

    // Jump from the Changes tab to a field in its group and flash it.
    function revealField(name) {
        var g = state.groupOf[name];
        if (g === undefined) return;
        if (state.changedOnly) setChangedOnly(false);
        setView('group', g);
        var target = fieldEls[name];
        if (target) {
            target.scrollIntoView({ block: 'center' });
            target.classList.add('flash');
            setTimeout(function () { target.classList.remove('flash'); }, 1300);
        }
    }

    // ---- Changes tab ------------------------------------------------------

    function tabHead(title, sub) {
        var head = el('div', 'tab-head');
        head.appendChild(el('h2', '', title));
        if (sub) head.appendChild(el('span', 'sub', sub));
        fieldsEl.appendChild(head);
    }

    function renderChangesPanel() {
        var names = changedNames();
        var hasBaseline = Object.keys(state.baseline).length > 0;
        var touchedCount = Object.keys(state.touched).length;
        tabHead('Changes vs file', hasBaseline ? (names.length + ' field' + (names.length === 1 ? '' : 's') + ' differ') : '');

        if (!hasBaseline) {
            emptyMessage('The file values aren\'t loaded, so there is nothing to compare against. Check the line under the Handling ID.');
        } else if (!names.length) {
            emptyMessage('Everything matches handling.meta.');
        } else {
            names.forEach(function (name) {
                var field = state.byName[name];
                var row = el('div', 'change-row');
                var title = el('div');
                var nm = el('span', 'cname', field.label || name);
                nm.title = 'Show ' + name + ' in its group';
                nm.addEventListener('click', function () { revealField(name); });
                title.appendChild(nm);
                title.appendChild(el('span', 'cgroup', state.groups[state.groupOf[name]].name));
                row.appendChild(title);

                var rb = el('button', 'revert-btn', '↺ Revert');
                rb.addEventListener('click', function () { revertField(name); });
                row.appendChild(rb);

                var vals = el('div', 'cvals');
                vals.appendChild(el('span', 'was', valueText(state.baseline[name])));
                vals.appendChild(el('span', 'arrow', '→'));
                vals.appendChild(el('span', 'now', valueText(state.values[name])));
                var info = deltaInfo(field);
                if (info && info.cls !== 'neutral') {
                    var d = el('span', 'field-delta ' + info.cls, info.text);
                    d.style.marginLeft = '6px';
                    d.title = info.title;
                    vals.appendChild(d);
                }
                row.appendChild(vals);
                fieldsEl.appendChild(row);
            });
        }

        var actionsCard = el('div', 'card');
        var actions = el('div', 'card-row');
        var revertAll = el('button', 'secondary', 'Revert all to file');
        revertAll.disabled = !names.length;
        revertAll.addEventListener('click', function () { postNui('resetToFile'); });
        var clearTouched = el('button', 'secondary', 'Clear blue outlines (' + touchedCount + ')');
        clearTouched.title = 'Forget which fields you edited (what bulk apply and presets use) without changing any values';
        clearTouched.disabled = !touchedCount;
        clearTouched.addEventListener('click', function () {
            state.touched = {};
            renderContent();
            setToast('Cleared the edited-field outlines. Values are unchanged.');
        });
        var exportBtn = el('button', 'secondary', 'Export changes as XML');
        exportBtn.disabled = !names.length;
        exportBtn.addEventListener('click', function () { showXmlExport(true); });
        actions.appendChild(revertAll);
        actions.appendChild(clearTouched);
        actions.appendChild(exportBtn);
        actionsCard.appendChild(actions);
        fieldsEl.appendChild(actionsCard);
    }

    // ---- Tools tab --------------------------------------------------------

    function numericValues() {
        var out = {};
        Object.keys(state.byName).forEach(function (name) {
            if (isNumeric(state.byName[name]) && state.values[name] !== undefined) out[name] = state.values[name];
        });
        return out;
    }

    function toggleRow(parent, text, sub, checked, onChange) {
        var row = el('label', 'toggle-row');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked;
        box.addEventListener('change', function () { onChange(box.checked); });
        row.appendChild(box);
        row.appendChild(el('span', '', text));
        if (sub) row.appendChild(el('span', 'sub', sub));
        parent.appendChild(row);
    }

    function card(title, hint) {
        var c = el('section', 'card');
        c.appendChild(el('h2', '', title));
        if (hint) c.appendChild(el('p', 'card-hint', hint));
        fieldsEl.appendChild(c);
        return c;
    }

    function renderToolsPanel() {
        var veh = card('Vehicle', can('tools')
            ? 'Quick fixes while testing. Repair keeps your current tune.'
            : 'Your role doesn\'t include tools (repair, flip, driving aids).');
        var row = el('div', 'card-row');
        var repair = el('button', 'secondary', 'Repair & clean');
        repair.disabled = !can('tools');
        repair.addEventListener('click', function () {
            // Re-applies only your edits, so other scripts' values on the car stay as they were.
            var mine = {};
            Object.keys(state.touched).forEach(function (name) {
                var f = state.byName[name];
                if (f && isNumeric(f) && state.values[name] !== undefined) mine[name] = state.values[name];
            });
            postNui('tool', { name: 'repair', values: mine });
        });
        var flip = el('button', 'secondary', 'Flip upright');
        flip.disabled = !can('tools');
        flip.addEventListener('click', function () { postNui('tool', { name: 'flip' }); });
        row.appendChild(repair);
        row.appendChild(flip);
        veh.appendChild(row);

        renderLockCard();
        renderAbCard();

        var exp = card('Export', 'Builds a handling.meta <Item> from the fields this editor covers. Paste it into a file or share it. SubHandlingData isn\'t included.');
        var erow = el('div', 'card-row');
        var all = el('button', 'secondary', 'All fields as XML');
        all.addEventListener('click', function () { showXmlExport(false); });
        var changed = el('button', 'secondary', 'Changed fields only');
        changed.addEventListener('click', function () { showXmlExport(true); });
        erow.appendChild(all);
        erow.appendChild(changed);
        exp.appendChild(erow);

        var tm = card('Telemetry', 'Stop completely, then pull away: the strip times 0-100 km/h, 0-60 mph and the quarter mile. Braking or lifting off mid-run ends the run. Hover a time to see your best.');
        var best = (state.telemetry && state.telemetry.best) || {};
        var bestLine = el('p', 'card-hint',
            'Best since the panel opened: 0-100 ' + fmtTime(best.t100) + ' · 0-60 ' + fmtTime(best.t60) +
            ' · ¼ mile ' + fmtTime(best.tQuarter) + (best.trap ? ' @ ' + speedText(best.trap) : ''));
        tm.appendChild(bestLine);
        var trow = el('div', 'card-row');
        var reset = el('button', 'secondary', 'Reset times & top speed');
        reset.addEventListener('click', resetTelemetry);
        trow.appendChild(reset);
        tm.appendChild(trow);

        var disp = card('Display');
        toggleRow(disp, 'Show telemetry strip', '', state.showTelemetry, function (on) {
            state.showTelemetry = on;
            savePref('showTelemetry', on);
            applyDisplayPrefs();
        });
        toggleRow(disp, 'Use mph for telemetry', '', state.speedUnit === 'mph', function (on) {
            state.speedUnit = on ? 'mph' : 'kmh';
            savePref('speedUnit', state.speedUnit);
            renderTelemetry();
        });
        toggleRow(disp, 'Show field help', 'description + raw field name', state.showDesc, function (on) {
            setShowDesc(on);
        });
    }

    // ---- vehicle lock ----------------------------------------------------
    // A locked vehicle can only be saved by people with the `lock` permission
    // (any route: save, copy, preset, category, restore).

    function lockText(lock, now) {
        if (!lock) return '';
        return 'Locked by ' + ((lock.by && lock.by.name) || 'staff') + (lock.t ? ' ' + ago(lock.t, now) : '') +
            (lock.reason ? ': "' + lock.reason + '"' : '');
    }

    function renderLockCard() {
        if (!can('lock')) {
            if (state.lock) card('Locked', lockText(state.lock, state.fileNow) + '. Only someone with the lock permission can save it.');
            return;
        }
        var name = state.handling;
        var c = card('Lock this vehicle', name
            ? 'Stops anyone without the lock permission from saving ' + name + ' (single saves, copies, presets, categories and restores). You can still save it.'
            : 'Load the vehicle\'s handling.meta first (see the line under the Handling ID).');
        if (!name) return;
        var row = el('div', 'card-row');
        if (state.lock) {
            c.appendChild(el('p', 'card-hint lock-line', lockText(state.lock, state.fileNow)));
            var unlock = el('button', 'secondary', 'Unlock ' + name);
            unlock.addEventListener('click', function () {
                unlock.disabled = true;
                rpc('locks.clear', { handling: name }).then(lockAnswer);
            });
            row.appendChild(unlock);
        } else {
            var reason = document.createElement('input');
            reason.type = 'text';
            reason.className = 'text-input';
            reason.placeholder = 'Reason (optional), e.g. "PD fleet, ask Boosted"';
            reason.maxLength = 80;
            reason.spellcheck = false;
            var lockBtn = el('button', 'secondary', 'Lock ' + name);
            lockBtn.addEventListener('click', function () {
                lockBtn.disabled = true;
                rpc('locks.set', { handling: name, reason: reason.value.trim() }).then(lockAnswer);
            });
            reason.addEventListener('keydown', function (e) { if (e.key === 'Enter') lockBtn.click(); });
            row.appendChild(reason);
            row.appendChild(lockBtn);
        }
        c.appendChild(row);
    }

    // After a lock change: re-read the file (its answer carries the new lock state).
    function lockAnswer(res) {
        setToast(res.message || (res.ok ? 'Done.' : 'That didn\'t work.'), res.ok ? 'ok' : 'err');
        if (res.locks) state.locksData = res.locks;
        if (state.handlingName) postNui('reloadFile', { handlingName: state.handlingName });
        renderContent();
    }

    // ---- History tab --------------------------------------------------------
    // Every write to a handling.meta, newest first, with the before/after of
    // each field. Restore puts the "before" values back (and is logged itself).

    var KIND_TEXT = { save: 'Save', bulk: 'Bulk', restore: 'Restore' };
    var histOpen = {}; // entry id -> true while its changes are expanded
    var historyToken = 0;

    function histValue(v) {
        return (v === undefined || v === null) ? '–' : valueText(v);
    }

    function fieldLabel(name) {
        var f = state.byName[name];
        return f ? (f.label || name) : name;
    }

    function historyKey() {
        return state.historyAll ? '*' : (state.handling || '');
    }

    function loadHistory() {
        var token = ++historyToken;
        var key = historyKey();
        rpc('history.list', { handling: state.historyAll ? '' : state.handling, limit: 80 }).then(function (res) {
            if (token !== historyToken) return; // the scope changed while this was loading
            state.history = res.ok ? res : { entries: [], now: 0, error: res.message };
            state.history.key = key;
            if (state.view === 'history') renderContent();
        });
    }

    function restoreEntry(entry) {
        setToast('Restoring #' + entry.id + '…');
        rpc('history.restore', { id: entry.id }).then(function (res) {
            setToast(res.message || (res.ok ? 'Restored.' : 'Restore failed.'), res.ok ? 'ok' : 'err');
            state.history = null;
            var mine = (state.handling || '').toUpperCase();
            var hit = res.ok && (res.handlings || []).some(function (h) { return String(h).toUpperCase() === mine; });
            if (hit && state.handlingName) {
                // Re-read the file and put the restored values on the car you're in.
                state.afterApplyToast = (res.message || 'Restored.') + ' Your car now has the restored values (Ctrl+Z to undo).';
                postNui('reloadFile', { handlingName: state.handlingName, apply: true });
            }
            if (state.view === 'history') renderContent();
        });
    }

    function historyRow(entry, now) {
        var targets = entry.targets || [];
        var fieldCount = 0;
        targets.forEach(function (t) { fieldCount += (t.changes || []).length; });

        var row = el('div', 'hist-item');
        var head = el('div', 'hist-head');
        head.appendChild(el('span', 'hist-kind ' + (entry.kind || 'save'), KIND_TEXT[entry.kind] || entry.kind || 'Save'));
        var title = entry.label || (targets[0] && targets[0].handling) || ('#' + entry.id);
        if (entry.kind === 'save' && state.historyAll && targets[0]) title = targets[0].handling;
        head.appendChild(el('span', 'hist-title', title));
        head.appendChild(el('span', 'hist-id', '#' + entry.id));
        var when = el('span', 'hist-when', ago(entry.t, now));
        when.title = fullDate(entry.t);
        head.appendChild(when);
        row.appendChild(head);

        var bits = ['by ' + ((entry.by && entry.by.name) || '?')];
        var total = entry.total || targets.length;
        if (total > 1) bits.push(total + ' vehicles');
        if (!state.historyAll || total === 1) bits.push(fieldCount + ' field' + (fieldCount === 1 ? '' : 's'));
        row.appendChild(el('div', 'hist-meta', bits.join(' · ')));
        if (entry.restoredBy) {
            var rb = el('div', 'hist-note', 'Restored by ' + (entry.restoredBy.name || '?') + ' ' + ago(entry.restoredBy.t, now) +
                (entry.restoredBy.id ? ' (#' + entry.restoredBy.id + ')' : ''));
            row.appendChild(rb);
        }

        var actions = el('div', 'hist-actions');
        var toggle = el('button', 'secondary small', histOpen[entry.id] ? 'Hide changes ▴' : 'Show changes ▾');
        toggle.addEventListener('click', function () {
            histOpen[entry.id] = !histOpen[entry.id];
            renderContent();
        });
        actions.appendChild(toggle);
        if (can('restore')) {
            var restore = el('button', 'secondary small', 'Restore before this');
            if (entry.restorable === false) {
                restore.disabled = true;
                restore.title = 'Too many vehicles to restore in one click';
            } else {
                restore.title = 'Put back the values these fields had before #' + entry.id + ' (on every vehicle it touched)';
                confirmClick(restore, 'Sure? Click again', function () { restoreEntry(entry); });
            }
            actions.appendChild(restore);
        }
        row.appendChild(actions);

        if (histOpen[entry.id]) {
            var box = el('div', 'hist-changes');
            targets.forEach(function (t) {
                if (targets.length > 1 || state.historyAll) {
                    box.appendChild(el('div', 'hist-target', t.handling + '  ·  ' + t.resource + '/' + t.file));
                }
                (t.changes || []).forEach(function (c) {
                    var line = el('div', 'cvals hist-change');
                    var name = el('span', 'hist-field', fieldLabel(c.f));
                    name.title = c.f;
                    line.appendChild(name);
                    line.appendChild(el('span', 'was', histValue(c.old)));
                    line.appendChild(el('span', 'arrow', '→'));
                    line.appendChild(el('span', 'now', histValue(c.new)));
                    box.appendChild(line);
                });
            });
            if (total > targets.length) {
                box.appendChild(el('div', 'hist-target', '+ ' + (total - targets.length) + ' more vehicle' + (total - targets.length === 1 ? '' : 's')));
            }
            row.appendChild(box);
        }
        return row;
    }

    function renderHistoryPanel() {
        tabHead('Save history', state.historyAll ? 'every vehicle' : (state.handling || state.handlingName));

        var bar = el('div', 'card-row history-bar');
        var mine = el('button', 'chip' + (state.historyAll ? '' : ' on'), 'This vehicle');
        var all = el('button', 'chip' + (state.historyAll ? ' on' : ''), 'All vehicles');
        mine.addEventListener('click', function () {
            if (!state.historyAll) return;
            state.historyAll = false;
            state.history = null;
            renderContent();
        });
        all.addEventListener('click', function () {
            if (state.historyAll) return;
            state.historyAll = true;
            state.history = null;
            renderContent();
        });
        var refresh = el('button', 'secondary small', 'Refresh');
        refresh.addEventListener('click', function () {
            state.history = null;
            renderContent();
        });
        bar.appendChild(mine);
        bar.appendChild(all);
        bar.appendChild(refresh);
        fieldsEl.appendChild(bar);

        if (!state.historyAll && !state.handling) {
            emptyMessage('This vehicle\'s handling.meta isn\'t loaded (see the line under the Handling ID). Pick All vehicles to see every save.');
            return;
        }
        if (!state.history || state.history.key !== historyKey()) {
            state.history = null;
            loadHistory();
            emptyMessage('Loading…');
            return;
        }
        if (state.history.error) {
            emptyMessage(state.history.error);
            return;
        }
        var entries = state.history.entries || [];
        if (!entries.length) {
            emptyMessage(state.historyAll ? 'Nothing has been saved since the history started.'
                : 'No saves logged for this vehicle yet. Saves made before the history existed aren\'t listed.');
            return;
        }
        entries.forEach(function (entry) { fieldsEl.appendChild(historyRow(entry, state.history.now)); });
    }

    // ---- Access tab -----------------------------------------------------------
    // Who can use the editor (by Discord ID) and with which role, plus the
    // list of locked vehicles. People in config.lua show but can't be changed.

    var VIA_TEXT = { config: 'config.lua', 'in-game': 'the in-game list', ace: 'an ACE permission', console: 'the console' };
    var accessLoading = false;

    function loadAccess() {
        accessLoading = true;
        var jobs = [];
        if (can('manage')) {
            jobs.push(rpc('access.list').then(function (res) {
                state.accessData = res.ok ? res : { error: res.message || 'Could not load the access list.' };
            }));
        }
        if (can('lock')) {
            jobs.push(rpc('locks.list').then(function (res) {
                state.locksData = res.ok ? (res.locks || []) : [];
                state.locksNow = res.now || 0;
            }));
        }
        Promise.all(jobs).then(function () {
            accessLoading = false;
            if (state.view === 'access') renderContent();
        });
    }

    function accessAnswer(res) {
        setToast(res.message || (res.ok ? 'Done.' : 'That didn\'t work.'), res.ok ? 'ok' : 'err');
        state.accessData = null;
        renderContent();
    }

    function roleSelect(names, value) {
        var select = document.createElement('select');
        var roles = (state.accessData && state.accessData.roles) || [];
        names.forEach(function (name) {
            var role = roles.filter(function (r) { return r.name === name; })[0];
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = role ? role.label : name;
            select.appendChild(opt);
        });
        if (value && names.indexOf(value) !== -1) select.value = value;
        return select;
    }

    function permPills(parent, perms) {
        var wrap = el('div', 'perm-pills');
        (perms || []).forEach(function (p) { wrap.appendChild(el('span', 'perm-pill', p)); });
        parent.appendChild(wrap);
    }

    function renderMyAccessCard() {
        var a = state.access || {};
        var c = card('Your access');
        c.appendChild(el('p', 'card-hint', (a.roleLabel || 'No role') + (a.via ? ' (from ' + (VIA_TEXT[a.via] || a.via) + ')' : '') +
            ' · ' + (a.discord ? 'Discord ID ' + a.discord : 'no Discord ID: have Discord open before you connect')));
        permPills(c, Object.keys(a.perms || {}).filter(function (p) { return a.perms[p]; }).sort());
    }

    function renderAddCard(data) {
        var c = card('Give someone access', 'Pick an online player or paste a Discord user ID (in Discord: Settings → Advanced → Developer Mode, then right-click a user → Copy User ID). ' +
            'You can give out roles below your own.');
        if (!(data.assignable || []).length) {
            c.appendChild(el('p', 'card-hint', 'Your role can\'t give out any roles.'));
            return;
        }

        var pick = document.createElement('select');
        var first = document.createElement('option');
        first.value = '';
        first.textContent = 'Pick an online player…';
        pick.appendChild(first);
        (data.online || []).forEach(function (p) {
            var opt = document.createElement('option');
            opt.value = String(p.id);
            opt.textContent = '[' + p.id + '] ' + p.name + (p.discord ? (p.roleLabel ? ' · ' + p.roleLabel : ' · no access') : ' · no Discord linked');
            opt.disabled = !p.discord;
            pick.appendChild(opt);
        });

        var idInput = document.createElement('input');
        idInput.type = 'text';
        idInput.className = 'text-input mono';
        idInput.placeholder = 'Discord user ID';
        idInput.spellcheck = false;
        var labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'text-input';
        labelInput.placeholder = 'Name / note (optional)';
        labelInput.maxLength = 48;
        labelInput.spellcheck = false;
        var role = roleSelect(data.assignable, data.assignable[0]);
        var give = el('button', 'primary', 'Give access');

        pick.addEventListener('change', function () {
            var p = (data.online || []).filter(function (x) { return String(x.id) === pick.value; })[0];
            if (!p) return;
            idInput.value = p.discord || '';
            labelInput.value = p.name || '';
            if (p.role && data.assignable.indexOf(p.role) !== -1) role.value = p.role;
        });
        give.addEventListener('click', function () {
            var id = idInput.value.trim();
            if (!/^\d{15,22}$/.test(id)) {
                setToast('That isn\'t a Discord user ID (15-22 digits).', 'err');
                return;
            }
            give.disabled = true;
            rpc('access.set', { discord: id, role: role.value, label: labelInput.value.trim() }).then(accessAnswer);
        });

        var r1 = el('div', 'card-row');
        r1.appendChild(pick);
        c.appendChild(r1);
        var r2 = el('div', 'card-row access-add-row');
        r2.appendChild(idInput);
        r2.appendChild(labelInput);
        r2.appendChild(role);
        r2.appendChild(give);
        c.appendChild(r2);
    }

    function renderPeopleCard(data) {
        var users = data.users || [];
        var c = card('People with access (' + users.length + ')',
            'Also counts: anyone with an ACE from config.lua (e.g. handling_editor.use) or handling_editor.role.<name>. Those don\'t appear here.');
        if (!users.length) {
            c.appendChild(el('p', 'card-hint', 'Nobody yet.'));
            return;
        }
        users.forEach(function (u) {
            var row = el('div', 'access-item');
            var info = el('div', 'info');
            var name = el('div', 'name');
            if (u.online) name.appendChild(el('span', 'online-dot'));
            name.appendChild(document.createTextNode(u.label || u.name || 'Unknown'));
            if (u.label && u.name && u.name !== u.label) name.appendChild(el('span', 'seen', ' (' + u.name + ')'));
            info.appendChild(name);
            var meta = u.source === 'config' ? 'config.lua' : ('added by ' + (u.addedBy || '?') + (u.addedAt ? ' ' + ago(u.addedAt, data.now) : ''));
            info.appendChild(el('div', 'meta mono', u.discord + ' · ' + meta));
            row.appendChild(info);

            var actions = el('div', 'actions');
            if (u.editable) {
                var names = data.assignable.slice();
                if (names.indexOf(u.role) === -1) names.unshift(u.role);
                var sel = roleSelect(names, u.role);
                sel.addEventListener('change', function () {
                    sel.disabled = true;
                    rpc('access.set', { discord: u.discord, role: sel.value }).then(accessAnswer);
                });
                actions.appendChild(sel);
                var del = el('button', 'secondary small danger', 'Remove');
                confirmClick(del, 'Sure?', function () {
                    rpc('access.remove', { discord: u.discord }).then(accessAnswer);
                });
                actions.appendChild(del);
            } else {
                var pill = el('span', 'role-pill', u.roleLabel || u.role);
                pill.title = u.lockedReason || '';
                actions.appendChild(pill);
            }
            row.appendChild(actions);
            c.appendChild(row);
        });
    }

    function renderRolesCard(data) {
        var c = card('Roles', 'Set in config.lua (Config.Roles). Higher roles can manage lower ones.');
        (data.roles || []).slice().reverse().forEach(function (r) {
            var row = el('div', 'role-row');
            row.appendChild(el('span', 'role-pill', r.label));
            if (r.all) row.appendChild(el('span', 'card-hint', 'everything'));
            else permPills(row, r.perms);
            c.appendChild(row);
        });
    }

    function renderLocksCard() {
        var list = state.locksData || [];
        var c = card('Locked vehicles (' + list.length + ')', 'Only people with the lock permission can save these. Lock or unlock the car you\'re in from the Tools tab.');
        if (!list.length) {
            c.appendChild(el('p', 'card-hint', 'No vehicles are locked.'));
            return;
        }
        list.forEach(function (lock) {
            var row = el('div', 'access-item');
            var info = el('div', 'info');
            info.appendChild(el('div', 'name mono', lock.handling));
            info.appendChild(el('div', 'meta', lockText(lock, state.locksNow)));
            row.appendChild(info);
            var actions = el('div', 'actions');
            var unlock = el('button', 'secondary small', 'Unlock');
            confirmClick(unlock, 'Sure?', function () {
                rpc('locks.clear', { handling: lock.handling }).then(function (res) {
                    setToast(res.message || '', res.ok ? 'ok' : 'err');
                    state.locksData = res.locks || null;
                    if (state.handling && lock.handling.toUpperCase() === state.handling.toUpperCase() && state.handlingName) {
                        postNui('reloadFile', { handlingName: state.handlingName });
                    }
                    renderContent();
                });
            });
            actions.appendChild(unlock);
            row.appendChild(actions);
            c.appendChild(row);
        });
    }

    function renderAccessPanel() {
        tabHead('Access', 'by Discord ID');
        renderMyAccessCard();

        var needs = (can('manage') && !state.accessData) || (can('lock') && !state.locksData);
        if (needs) {
            if (!accessLoading) loadAccess();
            emptyMessage('Loading…');
            return;
        }

        if (can('manage')) {
            var data = state.accessData;
            if (data.error) {
                emptyMessage(data.error);
            } else {
                renderAddCard(data);
                renderPeopleCard(data);
            }
        }
        if (can('lock')) renderLocksCard();
        if (can('manage') && state.accessData && !state.accessData.error) renderRolesCard(state.accessData);

        var refreshRow = el('div', 'card-row');
        var refresh = el('button', 'secondary small', 'Refresh');
        refresh.addEventListener('click', function () {
            state.accessData = null;
            state.locksData = null;
            renderContent();
        });
        refreshRow.appendChild(refresh);
        fieldsEl.appendChild(refreshRow);
    }

    // ---- A/B compare ------------------------------------------------------
    // Two in-memory snapshots of every number field. Switching between them is
    // a normal edit (one undo step), so you can feel the difference back to
    // back on the same stretch of road. Cleared when the panel is reopened.

    var abSlots = { A: null, B: null };

    function snapshotDiff(a, b) {
        if (!a || !b) return 0;
        return Object.keys(a).filter(function (name) {
            var f = state.byName[name];
            return f && b[name] !== undefined && !sameValue(f, a[name], b[name]);
        }).length;
    }

    function applySnapshot(snap, label) {
        var changes = [];
        Object.keys(snap).forEach(function (name) {
            var field = state.byName[name];
            if (!field || sameValue(field, state.values[name], snap[name])) return;
            var v = clone(snap[name]);
            changes.push({ name: name, before: state.values[name], after: v });
            state.values[name] = v;
            state.touched[name] = true;
            forceSendLive(name, v);
        });
        record(changes);
        abSlots.active = label;
        renderContent();
        setToast(changes.length
            ? ('Driving ' + label + ' (' + changes.length + ' field' + (changes.length === 1 ? '' : 's') + ' switched).')
            : ('Already on ' + label + '.'), 'ok');
    }

    function renderAbCard() {
        var c = card('A/B compare', 'Store your current tune as A, change things, store it as B, then flip between them to feel the difference. Switching is a normal edit, so Ctrl+Z works and Save to file saves whichever one you are on.');
        var row = el('div', 'card-row');
        ['A', 'B'].forEach(function (slot) {
            var store = el('button', 'secondary', 'Store ' + slot);
            store.title = 'Remember every number field as it is now';
            store.addEventListener('click', function () {
                abSlots[slot] = clean(numericValues());
                abSlots.active = slot;
                renderContent();
                setToast('Stored the current tune as ' + slot + '.', 'ok');
            });
            row.appendChild(store);
        });
        ['A', 'B'].forEach(function (slot) {
            var drive = el('button', abSlots.active === slot ? 'primary' : 'secondary', 'Drive ' + slot);
            drive.disabled = !abSlots[slot];
            drive.addEventListener('click', function () { applySnapshot(abSlots[slot], slot); });
            row.appendChild(drive);
        });
        c.appendChild(row);
        var diff = snapshotDiff(abSlots.A, abSlots.B);
        c.appendChild(el('p', 'card-hint ab-status',
            (abSlots.A ? 'A stored' : 'A empty') + ' · ' + (abSlots.B ? 'B stored' : 'B empty') +
            (abSlots.A && abSlots.B ? ' · they differ in ' + diff + ' field' + (diff === 1 ? '' : 's') : '')));
    }

    // ---- Off-road & Crawling tabs -----------------------------------------

    // Reference value for one-click setups: the FILE value when it's loaded
    // (so clicking a setup twice doesn't stack), else the live value.
    function refValue(name) {
        var b = state.baseline[name];
        return (b !== undefined && b !== null) ? b : state.values[name];
    }

    function refNum(name) {
        var v = refValue(name);
        return typeof v === 'number' ? v : null;
    }

    // Leave AWD cars alone; turn 2WD (0 or 1) into the given split.
    function awd(split) {
        var cur = refNum('fDriveBiasFront');
        if (cur === null) return split;
        return (cur < 0.1 || cur > 0.9) ? split : cur;
    }

    function lowerCom(dz) {
        var v = refValue('vecCentreOfMassOffset');
        if (!v || typeof v !== 'object') return undefined;
        return { x: v.x, y: v.y, z: v.z - dz };
    }

    function scaled(name, mult) { var v = refNum(name); return v === null ? undefined : v * mult; }
    function offset(name, add) { var v = refNum(name); return v === null ? undefined : v + add; }
    function atMost(name, cap) { var v = refNum(name); return v === null ? cap : Math.min(v, cap); }
    function atLeast(name, floor) { var v = refNum(name); return v === null ? floor : Math.max(v, floor); }

    var SETUPS = [
        {
            id: 'trail', name: 'Trail / overland',
            desc: 'A bit of lift and droop, softer springs and roll bars, AWD, less grip lost on dirt. Still drives fine on the road.',
            build: function () {
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', 0.04),
                    fSuspensionLowerLimit: offset('fSuspensionLowerLimit', -0.03),
                    fSuspensionForce: scaled('fSuspensionForce', 0.85),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 0.9),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 0.9),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 0.8),
                    fTractionLossMult: atMost('fTractionLossMult', 0.6),
                    fDriveBiasFront: awd(0.4),
                };
            },
        },
        {
            id: 'rock', name: 'Rock crawler',
            desc: 'Big lift, lots of wheel travel, very soft springs and roll bars so the axles articulate, 50/50 AWD, grip that holds on when the tyres slip, lower centre of mass, more steering lock.',
            build: function () {
                var max = refNum('fTractionCurveMax');
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', 0.08),
                    fSuspensionUpperLimit: offset('fSuspensionUpperLimit', 0.04),
                    fSuspensionLowerLimit: offset('fSuspensionLowerLimit', -0.08),
                    fSuspensionForce: scaled('fSuspensionForce', 0.6),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 0.7),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 0.6),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 0.3),
                    fTractionCurveMin: max === null ? undefined : Math.max(refNum('fTractionCurveMin') || 0, max * 0.95),
                    fTractionLossMult: atMost('fTractionLossMult', 0.2),
                    fLowSpeedTractionLossMult: 0,
                    fDriveBiasFront: 0.5,
                    fSteeringLock: atLeast('fSteeringLock', 40),
                    vecCentreOfMassOffset: lowerCom(0.15),
                };
            },
        },
        {
            id: 'mud', name: 'Mud bogger',
            desc: 'Keeps pulling in mud: much less grip lost on soft ground, grip holds while the tyres spin, 50/50 AWD, more power and quicker revs.',
            build: function () {
                var max = refNum('fTractionCurveMax');
                return {
                    fTractionLossMult: atMost('fTractionLossMult', 0.35),
                    fTractionCurveMin: max === null ? undefined : Math.max(refNum('fTractionCurveMin') || 0, max * 0.85),
                    fSuspensionRaise: offset('fSuspensionRaise', 0.05),
                    fDriveBiasFront: 0.5,
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.15),
                    fDriveInertia: scaled('fDriveInertia', 1.1),
                };
            },
        },
        {
            id: 'sand', name: 'Desert runner',
            desc: 'Trophy-truck style: long travel with firmer damping so it soaks up whoops at speed, lift, softer roll bars, more power, less grip lost in sand.',
            build: function () {
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', 0.06),
                    fSuspensionUpperLimit: offset('fSuspensionUpperLimit', 0.04),
                    fSuspensionLowerLimit: offset('fSuspensionLowerLimit', -0.06),
                    fSuspensionForce: scaled('fSuspensionForce', 0.75),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.3),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.2),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 0.7),
                    fTractionLossMult: atMost('fTractionLossMult', 0.5),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.1),
                    fDriveBiasFront: awd(0.35),
                    vecCentreOfMassOffset: lowerCom(0.08),
                };
            },
        },
    ];

    function fitToField(field, v) {
        if (field.type === 'vector') {
            return {
                x: Math.round(clampNum(v.x, field.min, field.max) * 10000) / 10000,
                y: Math.round(clampNum(v.y, field.min, field.max) * 10000) / 10000,
                z: Math.round(clampNum(v.z, field.min, field.max) * 10000) / 10000,
            };
        }
        v = clampNum(v, field.min, field.max);
        return field.type === 'int' ? Math.round(v) : Math.round(v * 10000) / 10000;
    }

    // Sets several fields as ONE undo step, live-previewed and outlined in blue.
    function applyFieldSet(values, label) {
        var changes = [];
        Object.keys(values).forEach(function (name) {
            var field = state.byName[name];
            var v = values[name];
            if (!field || v === undefined || v === null || (typeof v === 'number' && !isFinite(v))) return;
            v = fitToField(field, v);
            if (sameValue(field, state.values[name], v)) { state.touched[name] = true; return; }
            changes.push({ name: name, before: state.values[name], after: v });
            setValue(field, v);
        });
        record(changes);
        renderContent();
        setToast(changes.length
            ? (label + ': changed ' + changes.length + ' field' + (changes.length === 1 ? '' : 's') + '. Ctrl+Z undoes it, Save to file keeps it.')
            : (label + ': already set.'), changes.length ? 'ok' : '');
    }

    function setupTitle(s) {
        var parts = [];
        var values = s.build();
        Object.keys(values).forEach(function (name) {
            var f = state.byName[name];
            if (f && values[name] !== undefined) parts.push((f.label || name) + ' → ' + valueText(fitToField(f, values[name])));
        });
        return parts.join('\n');
    }

    function setupButton(parent, s, primary) {
        var b = el('button', primary ? 'primary' : 'secondary', s.name);
        b.title = s.desc + '\n\n' + setupTitle(s);
        b.addEventListener('click', function () { applyFieldSet(s.build(), s.name); });
        parent.appendChild(b);
        return b;
    }

    // ---- file-only flag shortcuts (same bits as the Flags tab) ----

    function flagBitState(name, bitName) {
        var f = state.byName[name];
        if (!f || !f.bits) return null;
        var i = f.bits.indexOf(bitName);
        var cur = parseHex(String(state.values[name] === undefined || state.values[name] === null ? '' : state.values[name]));
        if (i < 0 || cur === null) return null;
        return (cur & ((1 << i) >>> 0)) !== 0;
    }

    function setFlagBit(name, bitName, on) {
        var f = state.byName[name];
        var i = f.bits.indexOf(bitName);
        var cur = parseHex(String(state.values[name] || '0'));
        if (i < 0 || cur === null) return;
        var mask = (1 << i) >>> 0;
        var next = on ? ((cur | mask) >>> 0) : ((cur & ~mask) >>> 0);
        var useLower = /[a-f]/.test(String(state.baseline[name] || state.values[name] || ''));
        var hex = next.toString(16);
        hex = useLower ? hex : hex.toUpperCase();
        var before = state.values[name];
        setValue(f, hex);
        record([{ name: name, before: before, after: hex }]);
        renderContent();
        setToast(bitName + (on ? ' on' : ' off') + ' - file only: Save to file, then restart the vehicle resource.', 'ok');
    }

    function flagToggle(parent, name, bitName, text, sub) {
        var on = flagBitState(name, bitName);
        var row = el('label', 'toggle-row' + (on === null ? ' disabled' : ''));
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!on;
        box.disabled = on === null;
        box.addEventListener('change', function () { setFlagBit(name, bitName, box.checked); });
        row.appendChild(box);
        row.appendChild(el('span', '', text));
        row.appendChild(el('span', 'sub', sub || bitName));
        row.title = name + ' bit ' + bitName + (on === null ? '\n(Load the file first - flags only come from handling.meta.)' : '');
        parent.appendChild(row);
    }

    // ---- setup readouts: small stat tiles worked out from the current values ----

    var readouts = []; // [{ el, fn }] tiles currently on screen; refreshed after every edit

    function driveText(bias) {
        if (typeof bias !== 'number') return '–';
        if (bias <= 0.02) return 'RWD';
        if (bias >= 0.98) return 'FWD';
        return 'AWD ' + Math.round(bias * 100) + '/' + Math.round((1 - bias) * 100);
    }

    function dirtGripText(mult) {
        if (typeof mult !== 'number') return '–';
        if (mult <= 0.4) return 'Excellent';
        if (mult <= 0.8) return 'Good';
        if (mult <= 1.1) return 'Road car';
        return 'Poor';
    }

    function numVal(name) {
        var v = state.values[name];
        return typeof v === 'number' ? v : null;
    }

    function renderReadout(parent, tiles) {
        var grid = el('div', 'stat-grid');
        tiles.forEach(function (t) {
            var tile = el('div', 'stat');
            var v = el('div', 'stat-val', '–');
            tile.appendChild(v);
            tile.appendChild(el('div', 'stat-label', t[0]));
            if (t[2]) tile.title = t[2];
            grid.appendChild(tile);
            readouts.push({ el: v, fn: t[1] });
        });
        parent.appendChild(grid);
        refreshSetupReadout();
    }

    function refreshSetupReadout() {
        readouts = readouts.filter(function (r) { return document.body.contains(r.el); });
        readouts.forEach(function (r) {
            var text;
            try { text = r.fn(); } catch (e) { text = null; }
            r.el.textContent = (text === null || text === undefined || text === '') ? '–' : text;
        });
    }

    function cm(v) { return v === null ? null : Math.round(v * 100) + ' cm'; }
    function signedCm(v) { return v === null ? null : ((v > 0 ? '+' : '') + Math.round(v * 100) + ' cm'); }

    var OFFROAD_TILES = [
        ['Wheel travel', function () {
            var up = numVal('fSuspensionUpperLimit'), lo = numVal('fSuspensionLowerLimit');
            return (up === null || lo === null) ? null : cm(up - lo);
        }, 'Upper limit minus lower limit'],
        ['Lift', function () { return signedCm(numVal('fSuspensionRaise')); }],
        ['Drive', function () { return driveText(numVal('fDriveBiasFront')); }],
        ['Grip off-road', function () { return dirtGripText(numVal('fTractionLossMult')); }, 'From the traction loss multiplier'],
    ];

    function renderSetupReadout(parent) { renderReadout(parent, OFFROAD_TILES); }

    // ---- live terrain readout ----

    var terrainEls = null;
    var terrainOn = ''; // last "liveWatch" sent: '' | 'terrain' | ',dyn' | 'terrain,dyn'
    var compScale = 0.2; // grows to the deepest compression seen, so the bars use their height

    // Tells the client which live feeds the current tab needs: per-wheel
    // terrain data and/or driving dynamics (g-forces, braking, drift).
    function setLiveWatch(terrain, dyn) {
        if (root.hidden) terrain = dyn = false;
        var key = (terrain ? 'terrain' : '') + (dyn ? ',dyn' : '');
        if (key === terrainOn) return;
        terrainOn = key;
        postNui('liveWatch', { terrain: !!terrain, dyn: !!dyn });
    }

    function wheelLabels(n) {
        if (n === 4) return ['FL', 'FR', 'RL', 'RR'];
        if (n === 2) return ['F', 'R'];
        var out = [];
        for (var i = 0; i < n; i++) out.push(String(i + 1));
        return out;
    }

    function renderTerrainCard() {
        var c = card('Live terrain', 'Updates while you drive (press F6 or Drive to get the mouse back to the game). Bars show how far each wheel is pushed up into its travel.');
        terrainEls = { root: c };
        var top = el('div', 'stat-grid');
        [['pitch', 'Pitch'], ['roll', 'Roll'], ['artic', 'Articulation'], ['grounded', 'Wheels down']].forEach(function (p) {
            var t = el('div', 'stat');
            var v = el('div', 'stat-val', '–');
            t.appendChild(v);
            t.appendChild(el('div', 'stat-label', p[1]));
            top.appendChild(t);
            terrainEls[p[0]] = v;
        });
        c.appendChild(top);
        terrainEls.wheels = el('div', 'wheel-grid');
        c.appendChild(terrainEls.wheels);
        terrainEls.best = el('div', 'terrain-best');
        c.appendChild(terrainEls.best);
        var row = el('div', 'card-row');
        var reset = el('button', 'secondary small', 'Reset records');
        reset.addEventListener('click', function () {
            postNui('resetTerrain');
            compScale = 0.2;
            setToast('Terrain records reset.');
        });
        row.appendChild(reset);
        c.appendChild(row);
        terrainEls.wheelCount = -1;
        if (state.telemetry && state.telemetry.terrain) updateTerrain(state.telemetry.terrain);
    }

    function updateTerrain(t) {
        if (!terrainEls || !t) return;
        var wheels = t.wheels || [];
        terrainEls.pitch.textContent = fmtDeg(t.pitch, true);
        terrainEls.roll.textContent = fmtDeg(t.roll, true);
        terrainEls.artic.textContent = Math.round((t.artic || 0) * 100) + ' cm';
        terrainEls.grounded.textContent = (t.grounded || 0) + ' / ' + wheels.length;

        if (terrainEls.wheelCount !== wheels.length) {
            terrainEls.wheelCount = wheels.length;
            terrainEls.wheels.innerHTML = '';
            terrainEls.wheels.className = 'wheel-grid' + (wheels.length === 4 ? ' quad' : '');
            terrainEls.bars = [];
            var labels = wheelLabels(wheels.length);
            wheels.forEach(function (w, i) {
                var cell = el('div', 'wheel');
                var bar = el('div', 'wheel-bar');
                var fill = el('div', 'wheel-fill');
                bar.appendChild(fill);
                var lab = el('div', 'wheel-label', labels[i]);
                cell.appendChild(bar);
                cell.appendChild(lab);
                terrainEls.wheels.appendChild(cell);
                terrainEls.bars.push({ cell: cell, fill: fill, label: lab, name: labels[i] });
            });
        }
        wheels.forEach(function (w, i) {
            if (w.c > compScale) compScale = w.c;
            var b = terrainEls.bars[i];
            b.fill.style.height = Math.max(0, Math.min(1, w.c / compScale)) * 100 + '%';
            b.cell.classList.toggle('air', !!w.air);
            b.cell.classList.toggle('spin', !!w.spin);
            b.label.textContent = b.name + (w.air ? ' · air' : (w.spin ? ' · spin' : ''));
            b.cell.title = Math.round(w.c * 1000) / 10 + ' cm compressed';
        });
        var best = t.best || {};
        terrainEls.best.textContent = 'Records: articulation ' + Math.round((best.artic || 0) * 100) + ' cm · steepest climb ' +
            fmtDeg(best.pitch) + ' · most side-tilt ' + fmtDeg(best.roll);
    }

    function fmtDeg(v, signed) {
        if (typeof v !== 'number') return '–';
        var r = Math.round(v * 10) / 10;
        return (signed && r > 0 ? '+' : '') + r + '°';
    }

    // ---- driving aids (Crawling tab) ----

    var AID_DEFAULTS = { ratio: 2.7, cap: 30, crawlSpeed: 4 };
    var aidPrefs = loadPref('aids', AID_DEFAULTS);
    if (!aidPrefs || typeof aidPrefs !== 'object') aidPrefs = {};
    Object.keys(AID_DEFAULTS).forEach(function (k) {
        if (typeof aidPrefs[k] !== 'number' || !isFinite(aidPrefs[k])) aidPrefs[k] = AID_DEFAULTS[k];
    });
    var aids = { lowRange: false, crawl: false, hillHold: false };
    var aidStatus = {};

    function anyAidOn() { return aids.lowRange || aids.crawl || aids.hillHold; }

    function sendAids() {
        savePref('aids', aidPrefs);
        postNui('aids', {
            lowRange: aids.lowRange, crawl: aids.crawl, hillHold: aids.hillHold,
            ratio: aidPrefs.ratio, cap: aidPrefs.cap, crawlSpeed: aidPrefs.crawlSpeed,
        });
        renderGroupNav();
    }

    function aidSlider(parent, label, min, max, step, value, unit, onChange) {
        var row = el('div', 'field-controls aid-slider');
        row.appendChild(el('span', 'aid-slider-label', label));
        var wrap = el('div', 'range-wrap');
        var range = document.createElement('input');
        range.type = 'range';
        range.min = min; range.max = max; range.step = step; range.value = value;
        function fill(v) { range.style.setProperty('--fill', 'calc(7px + (100% - 14px) * ' + ((v - min) / (max - min)) + ')'); }
        fill(value);
        wrap.appendChild(range);
        var out = el('span', 'aid-slider-val', value + ' ' + unit);
        range.addEventListener('input', function () {
            var v = parseFloat(range.value);
            fill(v);
            out.textContent = v + ' ' + unit;
        });
        range.addEventListener('change', function () { onChange(parseFloat(range.value)); });
        row.appendChild(wrap);
        row.appendChild(out);
        parent.appendChild(row);
    }

    function renderAidsCard() {
        var c = card('Driving aids', 'Live only: these never change handling values and are never saved. They switch off when the panel closes. Drive with the mouse released (F6).');

        toggleRow(c, 'Low range (4-Lo)', 'more crawl torque, speed capped', aids.lowRange, function (on) { aids.lowRange = on; sendAids(); renderContent(); });
        if (aids.lowRange) {
            var ratios = el('div', 'card-row aid-sub');
            ratios.appendChild(el('span', 'aid-slider-label', 'Ratio'));
            [2.0, 2.7, 4.0].forEach(function (r) {
                var chip = el('button', 'chip' + (aidPrefs.ratio === r ? ' on' : ''), r.toFixed(1) + ':1');
                chip.addEventListener('click', function () { aidPrefs.ratio = r; sendAids(); renderContent(); });
                ratios.appendChild(chip);
            });
            c.appendChild(ratios);
            aidSlider(c, 'Speed cap', 5, 60, 1, aidPrefs.cap, 'km/h', function (v) { aidPrefs.cap = v; sendAids(); });
        }

        toggleRow(c, 'Crawl control', 'holds a set crawl speed - you only steer, hold brake to override', aids.crawl, function (on) { aids.crawl = on; sendAids(); renderContent(); });
        if (aids.crawl) {
            aidSlider(c, 'Target', 1, 15, 0.5, aidPrefs.crawlSpeed, 'km/h', function (v) { aidPrefs.crawlSpeed = v; sendAids(); });
        }

        toggleRow(c, 'Hill hold', 'holds the car on a slope until you touch a pedal', aids.hillHold, function (on) { aids.hillHold = on; sendAids(); renderContent(); });

        var status = el('div', 'aid-status');
        c.appendChild(status);
        aidStatusEl = status;
        updateAidStatus();
    }

    var aidStatusEl = null;
    function updateAidStatus() {
        if (!aidStatusEl || !document.body.contains(aidStatusEl)) return;
        var parts = [];
        if (aidStatus.governor) parts.push('Speed cap limiting');
        if (aidStatus.crawl) parts.push('Crawl control driving');
        if (aidStatus.hillHold) parts.push('Hill hold engaged');
        aidStatusEl.textContent = parts.length ? parts.join(' · ') : (anyAidOn() ? 'Ready' : '');
        aidStatusEl.classList.toggle('active', parts.length > 0);
    }

    // ---- the two tabs ----

    function fieldCards(names) {
        names.forEach(function (name) {
            var f = state.byName[name];
            if (f) fieldsEl.appendChild(buildFieldEl(f));
        });
    }

    function renderOffroadPanel() {
        tabHead('Off-road setup', 'trails, mud, sand, rocks');

        var setups = card('One-click setups', 'Worked out from this car\'s file values, so clicking twice doesn\'t stack. Each one is a single Ctrl+Z, and nothing is written until you Save to file. Hover a button to see exactly what it sets.');
        var srow = el('div', 'card-row');
        SETUPS.forEach(function (s) { setupButton(srow, s, false); });
        setups.appendChild(srow);
        renderSetupReadout(setups);

        var flags = card('Off-road flags', 'File only: Save to file, then restart the vehicle\'s resource for these to take effect.');
        flagToggle(flags, 'strHandlingFlags', 'OFFROAD_ABILITIES', 'Off-road abilities', 'better grip on dirt and grass');
        flagToggle(flags, 'strHandlingFlags', 'OFFROAD_ABILITIES_X2', 'Off-road abilities x2', 'even more');
        flagToggle(flags, 'strHandlingFlags', 'OFFROAD_INCREASED_GRAVITY_NO_FOLIAGE_DRAG', 'No bush drag', 'plants don\'t slow it down');
        flagToggle(flags, 'strHandlingFlags', 'LESS_SNOW_SINK', 'Less snow sink', '');
        flagToggle(flags, 'strHandlingFlags', 'HAS_RALLY_TYRES', 'Rally tyres', '');
        flagToggle(flags, 'strHandlingFlags', 'IMPROVED_RIGHTING_FORCE', 'Easier to right', 'tips back onto its wheels more easily');
        flagToggle(flags, 'strModelFlags', 'AXLE_F_SOLID', 'Solid front axle', '');
        flagToggle(flags, 'strModelFlags', 'AXLE_R_SOLID', 'Solid rear axle', '');

        fieldsEl.appendChild(el('div', 'field-group-label', 'Ground clearance & travel'));
        fieldCards(['fSuspensionRaise', 'fSuspensionUpperLimit', 'fSuspensionLowerLimit', 'fSuspensionForce',
            'fSuspensionCompDamp', 'fSuspensionReboundDamp', 'fAntiRollBarForce', 'vecCentreOfMassOffset']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Grip off the road'));
        fieldCards(['fTractionLossMult', 'fTractionCurveMin', 'fTractionCurveMax', 'fLowSpeedTractionLossMult', 'fDriveBiasFront']);

        renderTerrainCard();
    }

    function renderCrawlPanel() {
        tabHead('Crawling', 'slow, technical terrain');

        renderAidsCard();

        var quick = card('Crawler setup', 'These change handling values (blue outline, Ctrl+Z, Save to file to keep).');
        var qrow = el('div', 'card-row');
        var rock = SETUPS.filter(function (s) { return s.id === 'rock'; })[0];
        setupButton(qrow, rock, true);
        [['RWD', 0], ['AWD 50/50', 0.5], ['AWD 40/60', 0.4]].forEach(function (d) {
            var b = el('button', 'secondary', d[0]);
            b.title = 'Drive bias front = ' + d[1];
            b.classList.toggle('on', typeof state.values.fDriveBiasFront === 'number' && numEq(state.values.fDriveBiasFront, d[1]));
            b.addEventListener('click', function () { applyFieldSet({ fDriveBiasFront: d[1] }, 'Drive ' + d[0]); });
            qrow.appendChild(b);
        });
        var lock = el('button', 'secondary', 'Max steering lock');
        lock.title = 'Steering lock 45° for a tight turning circle on the trail';
        lock.addEventListener('click', function () { applyFieldSet({ fSteeringLock: 45 }, 'Steering lock'); });
        qrow.appendChild(lock);
        var noSpin = el('button', 'secondary', 'No launch wheelspin');
        noSpin.title = 'Low speed traction loss = 0, so the tyres don\'t spin up on rocks';
        noSpin.addEventListener('click', function () { applyFieldSet({ fLowSpeedTractionLossMult: 0 }, 'Launch wheelspin'); });
        qrow.appendChild(noSpin);
        quick.appendChild(qrow);
        renderSetupReadout(quick);
        flagToggle(quick, 'strHandlingFlags', 'STEER_ALL_WHEELS', 'Four-wheel steering', 'file only - rear wheels steer too');
        flagToggle(quick, 'strHandlingFlags', 'LOW_SPEED_WHEELIES', 'Low-speed wheelies', 'file only');

        fieldsEl.appendChild(el('div', 'field-group-label', 'Crawl gearing & torque'));
        fieldCards(['fInitialDriveForce', 'nInitialDriveGears', 'fDriveInertia', 'fSteeringLock']);

        renderTerrainCard();
    }

    // ---- Street & track / Drift / Pickups & trucks ------------------------

    // Small nudges work from the CURRENT value (click twice = twice as much),
    // unlike the one-click setups, which work from the file value.
    function nudge(name, add, min, max) {
        var v = numVal(name);
        if (v === null) return undefined;
        return clampNum(v + add, min, max);
    }

    function nudgeButton(parent, text, title, build) {
        var b = el('button', 'secondary', text);
        b.title = title;
        b.addEventListener('click', function () { applyFieldSet(build(), text); });
        parent.appendChild(b);
        return b;
    }

    function setupRow(parent, setups) {
        var row = el('div', 'card-row');
        setups.forEach(function (s) { setupButton(row, s, false); });
        parent.appendChild(row);
    }

    // Slide grip as a share of the car's CURRENT peak grip, so it still lands on
    // the intended % after another setup has changed the peak.
    function curveMinFrom(frac) {
        var max = numVal('fTractionCurveMax');
        if (max === null) max = refNum('fTractionCurveMax');
        return max === null ? undefined : max * frac;
    }

    var STREET_SETUPS = [
        {
            id: 'comfort', name: 'Comfort / daily',
            desc: 'Softer springs, dampers and roll bars and a more forgiving slide. Rides bumps and kerbs nicely.',
            build: function () {
                return {
                    fSuspensionForce: scaled('fSuspensionForce', 0.85),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 0.85),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 0.85),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 0.8),
                    fTractionCurveLateral: offset('fTractionCurveLateral', 1.5),
                };
            },
        },
        {
            id: 'sport', name: 'Sport',
            desc: 'Slightly lower, stiffer springs and roll bars, a bit more grip and brake, quicker shifts.',
            build: function () {
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', -0.02),
                    fSuspensionForce: scaled('fSuspensionForce', 1.15),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.1),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.1),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.25),
                    fTractionCurveMax: scaled('fTractionCurveMax', 1.05),
                    fTractionCurveMin: scaled('fTractionCurveMin', 1.05),
                    fBrakeForce: scaled('fBrakeForce', 1.1),
                    fClutchChangeRateScaleUpShift: scaled('fClutchChangeRateScaleUpShift', 1.25),
                    fClutchChangeRateScaleDownShift: scaled('fClutchChangeRateScaleDownShift', 1.25),
                };
            },
        },
        {
            id: 'track', name: 'Track / grip',
            desc: 'Low and stiff, much more grip and downforce, strong brakes, a lower centre of mass, calmer steering and fast shifts.',
            build: function () {
                var down = refNum('fDownforceModifier');
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', -0.04),
                    fSuspensionForce: scaled('fSuspensionForce', 1.3),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.2),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.25),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.5),
                    fTractionCurveMax: scaled('fTractionCurveMax', 1.1),
                    fTractionCurveMin: scaled('fTractionCurveMin', 1.1),
                    fDownforceModifier: down === null ? undefined : Math.max(down * 1.5, 1.5),
                    fBrakeForce: scaled('fBrakeForce', 1.2),
                    fSteeringLock: atMost('fSteeringLock', 35),
                    vecCentreOfMassOffset: lowerCom(0.05),
                    fClutchChangeRateScaleUpShift: scaled('fClutchChangeRateScaleUpShift', 1.4),
                    fClutchChangeRateScaleDownShift: scaled('fClutchChangeRateScaleDownShift', 1.4),
                };
            },
        },
        {
            id: 'drag', name: 'Drag launch',
            desc: 'Hooks off the line: less launch wheelspin, more rear grip, faster revs and shifts, a little more power.',
            build: function () {
                return {
                    fLowSpeedTractionLossMult: atMost('fLowSpeedTractionLossMult', 0.5),
                    fTractionBiasFront: offset('fTractionBiasFront', -0.03),
                    fDriveInertia: scaled('fDriveInertia', 1.15),
                    fClutchChangeRateScaleUpShift: scaled('fClutchChangeRateScaleUpShift', 1.6),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.1),
                };
            },
        },
        {
            id: 'stance', name: 'Stance / slammed',
            desc: 'Dropped low with less bump travel so it doesn\'t bottom out on the bodywork, stiffer springs and roll bars.',
            build: function () {
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', -0.08),
                    fSuspensionUpperLimit: offset('fSuspensionUpperLimit', -0.03),
                    fSuspensionForce: scaled('fSuspensionForce', 1.3),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.2),
                };
            },
        },
    ];

    var DRIFT_SETUPS = [
        {
            id: 'drift', name: 'Drift starter',
            desc: 'RWD, lots of steering lock, a wider slide window, grip that lets go but stays controllable, easier to break loose, stronger handbrake.',
            build: function () {
                return {
                    fDriveBiasFront: 0,
                    fSteeringLock: atLeast('fSteeringLock', 55),
                    fTractionCurveLateral: atLeast('fTractionCurveLateral', 22),
                    fTractionCurveMin: curveMinFrom(0.88),
                    fLowSpeedTractionLossMult: atLeast('fLowSpeedTractionLossMult', 1.2),
                    fTractionBiasFront: offset('fTractionBiasFront', 0.02),
                    fHandBrakeForce: scaled('fHandBrakeForce', 1.2),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.1),
                };
            },
        },
        {
            id: 'angle', name: 'Pro / high angle',
            desc: 'Competition style: even more lock and slide window, grip that hardly drops when sideways, more front bite and more power to hold big angles.',
            build: function () {
                return {
                    fDriveBiasFront: 0,
                    fSteeringLock: atLeast('fSteeringLock', 65),
                    fTractionCurveLateral: atLeast('fTractionCurveLateral', 25),
                    fTractionCurveMin: curveMinFrom(0.92),
                    fLowSpeedTractionLossMult: atLeast('fLowSpeedTractionLossMult', 1.4),
                    fTractionBiasFront: offset('fTractionBiasFront', 0.03),
                    fHandBrakeForce: scaled('fHandBrakeForce', 1.3),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.2),
                };
            },
        },
    ];

    var PICKUP_SETUPS = [
        {
            id: 'daily', name: 'Half-ton daily',
            desc: 'A tidier everyday truck: slightly softer ride, a bit less body roll, lower centre of mass, a touch more brake.',
            build: function () {
                return {
                    fSuspensionForce: scaled('fSuspensionForce', 0.9),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 0.95),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 0.95),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.1),
                    vecCentreOfMassOffset: lowerCom(0.05),
                    fBrakeForce: scaled('fBrakeForce', 1.1),
                };
            },
        },
        {
            id: 'hd', name: 'Heavy duty / tow rig',
            desc: 'Diesel HD feel: heavier, stiffer springs and dampers for a load, more low-down pull, slower revs, more gears, lower top speed, bigger brakes with more front bias.',
            build: function () {
                var gears = refNum('nInitialDriveGears');
                return {
                    fMass: scaled('fMass', 1.3),
                    fSuspensionForce: scaled('fSuspensionForce', 1.3),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.2),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.2),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.15),
                    fDriveInertia: scaled('fDriveInertia', 0.85),
                    nInitialDriveGears: gears === null ? undefined : Math.max(gears, 6),
                    fInitialDriveMaxFlatVel: scaled('fInitialDriveMaxFlatVel', 0.92),
                    fBrakeForce: scaled('fBrakeForce', 1.15),
                    fBrakeBiasFront: 0.6,
                };
            },
        },
        {
            // Floors and caps rather than multipliers: addon semis often ship with
            // car-like values, and this should land near the stock Hauler / Phantom.
            id: 'semi', name: 'Semi / tractor unit',
            desc: 'Class 8 road tractor: at least 12 tonnes, strong pull with slow revs and slow shifts through 8+ gears, top gear capped at 130 km/h, firm brakes, weak handbrake, limited grip and steering lock, firm springs, lower centre of mass, no launch wheelspin. Does not change flags.',
            build: function () {
                var peak = atMost('fTractionCurveMax', 1.9);
                var force = refNum('fInitialDriveForce');
                return {
                    fMass: atLeast('fMass', 12000),
                    fInitialDragCoeff: atLeast('fInitialDragCoeff', 12),
                    vecCentreOfMassOffset: lowerCom(0.1),
                    fDriveBiasFront: 0,
                    nInitialDriveGears: atLeast('nInitialDriveGears', 8),
                    fInitialDriveForce: force === null ? 0.22 : Math.min(Math.max(force, 0.2), 0.28),
                    fDriveInertia: atMost('fDriveInertia', 0.8),
                    fClutchChangeRateScaleUpShift: atMost('fClutchChangeRateScaleUpShift', 1.3),
                    fClutchChangeRateScaleDownShift: atMost('fClutchChangeRateScaleDownShift', 1.3),
                    fInitialDriveMaxFlatVel: atMost('fInitialDriveMaxFlatVel', 130),
                    fBrakeForce: atLeast('fBrakeForce', 0.8),
                    fBrakeBiasFront: 0.5,
                    fHandBrakeForce: atMost('fHandBrakeForce', 0.5),
                    fSteeringLock: atMost('fSteeringLock', 38),
                    fTractionCurveMax: peak,
                    fTractionCurveMin: peak * 0.92,
                    fLowSpeedTractionLossMult: 0,
                    fSuspensionForce: atLeast('fSuspensionForce', 1.6),
                    fSuspensionCompDamp: atLeast('fSuspensionCompDamp', 1),
                    fSuspensionReboundDamp: atLeast('fSuspensionReboundDamp', 1.2),
                    fRollCentreHeightFront: atLeast('fRollCentreHeightFront', 0.55),
                    fRollCentreHeightRear: atLeast('fRollCentreHeightRear', 0.55),
                    fDeformationDamageMult: atMost('fDeformationDamageMult', 0.8),
                };
            },
        },
        {
            id: 'lifted', name: 'Lifted street truck',
            desc: 'Lift and a little more droop, stiffer roll bars and a lower centre of mass so the extra height doesn\'t make it tippy.',
            build: function () {
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', 0.06),
                    fSuspensionLowerLimit: offset('fSuspensionLowerLimit', -0.03),
                    fSuspensionForce: scaled('fSuspensionForce', 0.9),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.2),
                    vecCentreOfMassOffset: lowerCom(0.05),
                    fTractionLossMult: atMost('fTractionLossMult', 0.8),
                };
            },
        },
        {
            id: 'lowered', name: 'Lowered street truck',
            desc: 'Dropped stance: lower, less bump travel, stiffer springs, dampers and roll bars, a bit more grip.',
            build: function () {
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', -0.05),
                    fSuspensionUpperLimit: offset('fSuspensionUpperLimit', -0.02),
                    fSuspensionForce: scaled('fSuspensionForce', 1.25),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.15),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.15),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.3),
                    vecCentreOfMassOffset: lowerCom(0.05),
                    fTractionCurveMax: scaled('fTractionCurveMax', 1.05),
                };
            },
        },
        {
            id: 'prerunner', name: 'Prerunner',
            desc: 'Desert pickup: long travel with firm damping for whoops at speed, softer roll bars, less grip lost on dirt, more power. Keeps its drive layout.',
            build: function () {
                return {
                    fSuspensionRaise: offset('fSuspensionRaise', 0.05),
                    fSuspensionUpperLimit: offset('fSuspensionUpperLimit', 0.04),
                    fSuspensionLowerLimit: offset('fSuspensionLowerLimit', -0.07),
                    fSuspensionForce: scaled('fSuspensionForce', 0.8),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.25),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.2),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 0.75),
                    fTractionLossMult: atMost('fTractionLossMult', 0.6),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.1),
                };
            },
        },
    ];

    // Pursuit-rated builds: more power and brakes, firmer and flatter so a
    // heavy, equipment-laden vehicle stays composed at speed, and tougher in
    // collisions (push bumpers, PIT manoeuvres).
    var POLICE_SETUPS = [
        {
            id: 'policecar', name: 'Police interceptor (car)',
            desc: 'Pursuit-rated sedan (Charger / Crown Vic / Taurus style): more power and top speed, bigger brakes with a front bias, firmer and flatter, a bit more grip, less launch wheelspin, quicker shifts, takes less collision damage.',
            build: function () {
                return {
                    fMass: scaled('fMass', 1.05),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.12),
                    fInitialDriveMaxFlatVel: scaled('fInitialDriveMaxFlatVel', 1.08),
                    fClutchChangeRateScaleUpShift: scaled('fClutchChangeRateScaleUpShift', 1.3),
                    fClutchChangeRateScaleDownShift: scaled('fClutchChangeRateScaleDownShift', 1.3),
                    fBrakeForce: scaled('fBrakeForce', 1.2),
                    fBrakeBiasFront: 0.6,
                    fSuspensionForce: scaled('fSuspensionForce', 1.15),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.1),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.1),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.25),
                    fTractionCurveMax: scaled('fTractionCurveMax', 1.05),
                    fTractionCurveMin: scaled('fTractionCurveMin', 1.05),
                    fLowSpeedTractionLossMult: atMost('fLowSpeedTractionLossMult', 0.6),
                    vecCentreOfMassOffset: lowerCom(0.04),
                    fCollisionDamageMult: scaled('fCollisionDamageMult', 0.8),
                    fDeformationDamageMult: scaled('fDeformationDamageMult', 0.8),
                };
            },
        },
        {
            id: 'policesuv', name: 'Police SUV',
            desc: 'Pursuit-rated SUV (Explorer / Tahoe / Durango style): equipment weight, much stiffer roll bars and a lower centre of mass so it doesn\'t roll over in a pursuit, more power, bigger brakes, AWD if it was 2WD, takes less collision damage.',
            build: function () {
                return {
                    fMass: scaled('fMass', 1.08),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.1),
                    fInitialDriveMaxFlatVel: scaled('fInitialDriveMaxFlatVel', 1.05),
                    fClutchChangeRateScaleUpShift: scaled('fClutchChangeRateScaleUpShift', 1.2),
                    fBrakeForce: scaled('fBrakeForce', 1.25),
                    fBrakeBiasFront: 0.6,
                    fSuspensionForce: scaled('fSuspensionForce', 1.2),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.15),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.15),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.35),
                    fTractionCurveMax: scaled('fTractionCurveMax', 1.05),
                    vecCentreOfMassOffset: lowerCom(0.06),
                    fDriveBiasFront: awd(0.4),
                    fCollisionDamageMult: scaled('fCollisionDamageMult', 0.8),
                    fDeformationDamageMult: scaled('fDeformationDamageMult', 0.8),
                };
            },
        },
        {
            id: 'policetruck', name: 'Police truck',
            desc: 'Police pickup (F-150 Police Responder / Silverado PPV / K9 truck style): equipment weight, stiffer springs and roll bars, lower centre of mass, more pull and a little more top speed, bigger front-biased brakes, 4x4 if it was 2WD, copes with dirt, takes less collision damage.',
            build: function () {
                return {
                    fMass: scaled('fMass', 1.08),
                    fInitialDriveForce: scaled('fInitialDriveForce', 1.12),
                    fDriveInertia: scaled('fDriveInertia', 1.05),
                    fInitialDriveMaxFlatVel: scaled('fInitialDriveMaxFlatVel', 1.05),
                    fBrakeForce: scaled('fBrakeForce', 1.2),
                    fBrakeBiasFront: 0.6,
                    fSuspensionForce: scaled('fSuspensionForce', 1.2),
                    fSuspensionCompDamp: scaled('fSuspensionCompDamp', 1.1),
                    fSuspensionReboundDamp: scaled('fSuspensionReboundDamp', 1.15),
                    fAntiRollBarForce: scaled('fAntiRollBarForce', 1.3),
                    vecCentreOfMassOffset: lowerCom(0.05),
                    fTractionLossMult: atMost('fTractionLossMult', 0.8),
                    fDriveBiasFront: awd(0.4),
                    fCollisionDamageMult: scaled('fCollisionDamageMult', 0.8),
                    fDeformationDamageMult: scaled('fDeformationDamageMult', 0.8),
                };
            },
        },
    ];
    STREET_SETUPS.push(POLICE_SETUPS[0]);
    PICKUP_SETUPS.push(POLICE_SETUPS[2]);

    // ---- readout tiles for these tabs ----

    function powerIndex() {
        var f = numVal('fInitialDriveForce'), m = numVal('fMass');
        if (f === null || !m) return null;
        return String(Math.round(f / ((m + (state.view === 'pickup' ? payload.kg : 0)) / 1000) * 1000) / 10);
    }

    function balanceText() {
        var b = numVal('fTractionBiasFront');
        if (b === null) return null;
        var word = b < 0.47 ? 'Understeer' : (b > 0.53 ? 'Oversteer' : 'Neutral');
        return word + ' (' + fmt(b) + ')';
    }

    function topSpeedText() {
        var v = numVal('fInitialDriveMaxFlatVel');
        if (v === null) return null;
        return state.speedUnit === 'mph' ? Math.round(v / KMH_PER_MPH) + ' mph' : Math.round(v) + ' km/h';
    }

    var POWER_TILE = ['Power index', powerIndex, 'Drive force per tonne x100. Compare cars with it: higher pulls harder.'];

    var STREET_TILES = [
        POWER_TILE,
        ['Balance', balanceText, 'From the traction bias: below 0.47 pushes wide (understeer), above 0.53 the rear steps out (oversteer)'],
        ['Brake bias', function () { var b = numVal('fBrakeBiasFront'); return b === null ? null : Math.round(b * 100) + '% front'; }],
        ['Top speed', topSpeedText, 'Max flat velocity (gear-limited top speed on flat ground)'],
    ];

    var DRIFT_TILES = [
        ['Drive', function () { return driveText(numVal('fDriveBiasFront')); }],
        ['Steering lock', function () { var v = numVal('fSteeringLock'); return v === null ? null : Math.round(v) + '°'; }],
        ['Slide grip', function () {
            var mn = numVal('fTractionCurveMin'), mx = numVal('fTractionCurveMax');
            return (mn === null || !mx) ? null : Math.round(mn / mx * 100) + '%';
        }, 'Grip while sliding as a % of peak grip. Higher = holds the angle, lower = spins easier'],
        ['Slide window', function () { var v = numVal('fTractionCurveLateral'); return v === null ? null : fmt(v) + '°'; }, 'Traction curve lateral: slip angle at peak grip'],
    ];

    var PICKUP_TILES = [
        ['Weight', function () {
            var m = numVal('fMass');
            if (m === null) return null;
            return Math.round(m) + ' kg' + (payload.kg ? ' +' + payload.kg : '');
        }, 'Handling mass, plus the bed load when one is on'],
        POWER_TILE,
        ['Drive', function () { return driveText(numVal('fDriveBiasFront')); }],
        ['Lift', function () { return signedCm(numVal('fSuspensionRaise')); }],
    ];

    // ---- live dynamics card ----

    var dynEls = null;

    function fmtG(v) { return typeof v === 'number' ? (Math.round(v * 100) / 100).toFixed(2) + ' g' : '–'; }

    function fmtDist(m) {
        if (typeof m !== 'number') return '–';
        return state.speedUnit === 'mph' ? Math.round(m * 3.28084) + ' ft' : (Math.round(m * 10) / 10) + ' m';
    }

    function brakeText(rec) {
        if (!rec || typeof rec.last !== 'number') return '–';
        return fmtDist(rec.last) + (typeof rec.best === 'number' && rec.best !== rec.last ? ' (best ' + fmtDist(rec.best) + ')' : '');
    }

    function statTile(parent, key, label, title) {
        var t = el('div', 'stat');
        var v = el('div', 'stat-val', '–');
        t.appendChild(v);
        t.appendChild(el('div', 'stat-label', label));
        if (title) t.title = title;
        parent.appendChild(t);
        dynEls[key] = v;
    }

    function renderDynCard(kind) {
        var drift = kind === 'drift';
        var c = card(drift ? 'Drift meter' : 'Live g-forces & braking', drift
            ? 'Slide 10-110° above walking pace to score. Score = angle x speed; a run ends 1.5 s after you straighten up, or when you hit something. Release the mouse (F6) and drive.'
            : 'Release the mouse (F6) and drive. Braking tests start on their own: hold the brake through 100 km/h (or 60 mph) to a full stop. Getting back on the throttle cancels the run.');
        dynEls = { kind: kind };
        var grid = el('div', 'stat-grid');
        if (drift) {
            statTile(grid, 'slip', 'Angle now');
            statTile(grid, 'drift', 'Run score');
            statTile(grid, 'driftLast', 'Last run');
            statTile(grid, 'driftBest', 'Best run');
        } else {
            statTile(grid, 'lat', 'Cornering', 'Lateral g right now');
            statTile(grid, 'peakLat', 'Peak cornering');
            statTile(grid, 'peakBrake', 'Peak braking');
            statTile(grid, 'peakAccel', 'Peak accel');
        }
        c.appendChild(grid);

        var body = el('div', 'dyn-body');
        if (drift) {
            var gauge = el('div', 'angle-gauge');
            var fill = el('div', 'angle-fill');
            gauge.appendChild(el('div', 'angle-mid'));
            gauge.appendChild(fill);
            body.appendChild(gauge);
            dynEls.angleFill = fill;
            dynEls.peak = el('div', 'terrain-best');
            body.appendChild(dynEls.peak);
        } else {
            // Friction circle: rings at 0.5 / 1.0 / 1.5 g, the dot is where the
            // car is right now (cornering left/right, braking up, accelerating down).
            var circle = el('div', 'g-circle');
            [0.5, 1.0, 1.5].forEach(function (g) {
                var ring = el('div', 'g-ring');
                ring.style.width = ring.style.height = (g / 1.5 * 100) + '%';
                circle.appendChild(ring);
            });
            circle.appendChild(el('div', 'g-axis h'));
            circle.appendChild(el('div', 'g-axis v'));
            var dot = el('div', 'g-dot');
            circle.appendChild(dot);
            dynEls.dot = dot;
            body.appendChild(circle);
            var brakes = el('div', 'brake-tests');
            var b100 = el('div', 'brake-row');
            b100.appendChild(el('span', 'brake-label', '100-0 km/h'));
            dynEls.b100 = el('span', 'brake-val', '–');
            b100.appendChild(dynEls.b100);
            var b60 = el('div', 'brake-row');
            b60.appendChild(el('span', 'brake-label', '60-0 mph'));
            dynEls.b60 = el('span', 'brake-val', '–');
            b60.appendChild(dynEls.b60);
            dynEls.braking = el('div', 'brake-status');
            brakes.appendChild(b100);
            brakes.appendChild(b60);
            brakes.appendChild(dynEls.braking);
            body.appendChild(brakes);
        }
        c.appendChild(body);

        var row = el('div', 'card-row');
        var reset = el('button', 'secondary small', 'Reset records');
        reset.addEventListener('click', function () {
            postNui('resetDynamics');
            setToast('Records reset.');
        });
        row.appendChild(reset);
        c.appendChild(row);
        if (state.telemetry && state.telemetry.dyn) updateDyn(state.telemetry.dyn);
    }

    function updateDyn(d) {
        if (!dynEls || !d) return;
        if (dynEls.kind === 'drift') {
            var a = Math.abs(d.slip || 0);
            dynEls.slip.textContent = Math.round(a) + '°';
            dynEls.drift.textContent = Math.round(d.drift || 0);
            dynEls.driftLast.textContent = Math.round(d.driftLast || 0);
            dynEls.driftBest.textContent = Math.round(d.driftBest || 0);
            var side = (d.slip || 0) >= 0 ? 1 : -1;
            var frac = Math.min(1, a / 90);
            dynEls.angleFill.style.width = (frac * 50) + '%';
            dynEls.angleFill.style.left = side > 0 ? '50%' : (50 - frac * 50) + '%';
            dynEls.angleFill.classList.toggle('scoring', a >= 10);
            dynEls.peak.textContent = 'Biggest angle: this run ' + Math.round(d.driftAngle || 0) + '° · overall ' + Math.round(d.peakSlip || 0) + '°';
        } else {
            dynEls.lat.textContent = fmtG(Math.abs(d.lat || 0));
            dynEls.peakLat.textContent = fmtG(d.peakLat);
            dynEls.peakBrake.textContent = fmtG(d.peakBrake);
            dynEls.peakAccel.textContent = fmtG(d.peakAccel);
            var x = clampNum((d.lat || 0) / 1.5, -1, 1), y = clampNum(-(d.lon || 0) / 1.5, -1, 1);
            dynEls.dot.style.left = (50 + x * 50) + '%';
            dynEls.dot.style.top = (50 - y * 50) + '%';
            dynEls.b100.textContent = brakeText(d.b100);
            dynEls.b60.textContent = brakeText(d.b60);
            dynEls.braking.textContent = d.braking ? 'Measuring stop…' : '';
        }
    }

    // ---- bed load (Pickups & trucks) ----

    var payload = { kg: 0, bed: true };

    function sendPayload() {
        postNui('payload', { kg: payload.kg, bed: payload.bed });
        renderGroupNav();
        refreshSetupReadout();
    }

    function renderPayloadCard() {
        var c = card('Bed load test', 'Live only: adds weight to the truck you\'re in, and moves the centre of mass back and up when it sits in the bed, so you can feel how the springs, brakes and power cope with a load. Never saved, and removed when the panel closes.');
        var chips = el('div', 'card-row');
        [0, 300, 600, 1000, 1500].forEach(function (kg) {
            var chip = el('button', 'chip' + (payload.kg === kg ? ' on' : ''), kg ? kg + ' kg' : 'Empty');
            chip.addEventListener('click', function () { payload.kg = kg; sendPayload(); renderContent(); });
            chips.appendChild(chip);
        });
        c.appendChild(chips);
        aidSlider(c, 'Load', 0, 2000, 50, payload.kg, 'kg', function (v) { payload.kg = v; sendPayload(); renderContent(); });
        toggleRow(c, 'Load sits in the bed', 'shifts the centre of mass back and up', payload.bed, function (on) {
            payload.bed = on;
            if (payload.kg) sendPayload();
        });
    }

    // ---- the three tabs ----

    function renderPolicePanel() {
        tabHead('Police', 'interceptors, SUVs, trucks');

        var setups = card('One-click setups', 'Pursuit-rated builds worked out from this vehicle\'s file values, so clicking twice doesn\'t stack. One Ctrl+Z each; Save to file keeps it. Hover a button for exactly what it sets. To give a whole fleet the same change, apply a setup here, then use Bulk & copy -> Apply to a vMenu category (e.g. Emergency).');
        setupRow(setups, POLICE_SETUPS);
        renderReadout(setups, STREET_TILES);

        var quick = card('Pursuit tweaks', 'Small nudges from the current values; click again to go further.');
        var qrow = el('div', 'card-row');
        nudgeButton(qrow, 'Push bumper (-20% damage)', 'Collision and deformation damage x0.8: survives PITs and ramming', function () {
            var c = numVal('fCollisionDamageMult'), d = numVal('fDeformationDamageMult');
            return { fCollisionDamageMult: c === null ? undefined : c * 0.8, fDeformationDamageMult: d === null ? undefined : d * 0.8 };
        });
        nudgeButton(qrow, 'Power +5%', 'Drive force x1.05', function () {
            var v = numVal('fInitialDriveForce');
            return { fInitialDriveForce: v === null ? undefined : v * 1.05 };
        });
        nudgeButton(qrow, 'Top speed +5%', 'Max flat velocity x1.05', function () {
            var v = numVal('fInitialDriveMaxFlatVel');
            return { fInitialDriveMaxFlatVel: v === null ? undefined : v * 1.05 };
        });
        nudgeButton(qrow, 'Brakes +10%', 'Brake force x1.1', function () {
            var v = numVal('fBrakeForce');
            return { fBrakeForce: v === null ? undefined : v * 1.1 };
        });
        nudgeButton(qrow, 'Less body roll', 'Anti-roll bar force x1.15', function () {
            var v = numVal('fAntiRollBarForce');
            return { fAntiRollBarForce: v === null ? undefined : v * 1.15 };
        });
        nudgeButton(qrow, 'Tougher engine', 'Engine damage x0.8: keeps running after hits', function () {
            var v = numVal('fEngineDamageMult');
            return { fEngineDamageMult: v === null ? undefined : v * 0.8 };
        });
        quick.appendChild(qrow);
        flagToggle(quick, 'strModelFlags', 'ABS_STD', 'ABS', 'file only');
        flagToggle(quick, 'strModelFlags', 'NO_WHEEL_BURST', 'Run-flat tyres', 'file only - tyres can\'t be burst (spike strips)');
        flagToggle(quick, 'strHandlingFlags', 'IMPROVED_RIGHTING_FORCE', 'Easier to right', 'file only');

        renderDynCard('street');

        fieldsEl.appendChild(el('div', 'field-group-label', 'Power & speed'));
        fieldCards(['fMass', 'fInitialDriveForce', 'fInitialDriveMaxFlatVel', 'fDriveBiasFront', 'fClutchChangeRateScaleUpShift']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Brakes & grip'));
        fieldCards(['fBrakeForce', 'fBrakeBiasFront', 'fTractionCurveMax', 'fTractionCurveMin', 'fLowSpeedTractionLossMult']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Chassis'));
        fieldCards(['fSuspensionForce', 'fSuspensionCompDamp', 'fSuspensionReboundDamp', 'fAntiRollBarForce', 'vecCentreOfMassOffset']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Toughness'));
        fieldCards(['fCollisionDamageMult', 'fDeformationDamageMult', 'fEngineDamageMult']);
    }

    function renderStreetPanel() {
        tabHead('Street & track', 'road cars, sports cars, track builds');

        var setups = card('One-click setups', 'Worked out from the file values, so clicking twice doesn\'t stack. One Ctrl+Z each; Save to file keeps it. Hover a button for exactly what it sets.');
        setupRow(setups, STREET_SETUPS);
        renderReadout(setups, STREET_TILES);

        var bal = card('Balance & brakes', 'Small nudges from the current values; click again to go further.');
        var brow = el('div', 'card-row');
        nudgeButton(brow, 'More front grip', 'Traction bias front +0.02: sharper turn-in, rear steps out more', function () {
            return { fTractionBiasFront: nudge('fTractionBiasFront', 0.02, 0, 1) };
        });
        nudgeButton(brow, 'More rear grip', 'Traction bias front -0.02: more stable, pushes wide more', function () {
            return { fTractionBiasFront: nudge('fTractionBiasFront', -0.02, 0, 1) };
        });
        nudgeButton(brow, 'Brakes +10%', 'Brake force x1.1', function () {
            var v = numVal('fBrakeForce');
            return { fBrakeForce: v === null ? undefined : v * 1.1 };
        });
        nudgeButton(brow, 'Brake bias 55% F', 'A stable, slightly front-biased split', function () { return { fBrakeBiasFront: 0.55 }; });
        nudgeButton(brow, 'Less body roll', 'Anti-roll bar force x1.15', function () {
            var v = numVal('fAntiRollBarForce');
            return { fAntiRollBarForce: v === null ? undefined : v * 1.15 };
        });
        bal.appendChild(brow);
        flagToggle(bal, 'strModelFlags', 'ABS_STD', 'ABS', 'file only');
        flagToggle(bal, 'strHandlingFlags', 'FORCE_NO_TC_OR_SC', 'No traction / stability control', 'file only');
        flagToggle(bal, 'strHandlingFlags', 'CVT', 'CVT gearbox', 'file only - no gear changes');

        renderDynCard('street');

        fieldsEl.appendChild(el('div', 'field-group-label', 'Grip & balance'));
        fieldCards(['fTractionCurveMax', 'fTractionCurveMin', 'fTractionCurveLateral', 'fTractionBiasFront', 'fDownforceModifier']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Brakes'));
        fieldCards(['fBrakeForce', 'fBrakeBiasFront', 'fHandBrakeForce']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Chassis'));
        fieldCards(['fSuspensionRaise', 'fSuspensionForce', 'fSuspensionBiasFront', 'fAntiRollBarForce', 'fAntiRollBarBiasFront', 'vecCentreOfMassOffset']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Power & gearing'));
        fieldCards(['fInitialDriveForce', 'fInitialDriveMaxFlatVel', 'fInitialDragCoeff', 'fClutchChangeRateScaleUpShift', 'fClutchChangeRateScaleDownShift']);
    }

    function renderDriftPanel() {
        tabHead('Drift', 'angle, throttle control, handbrake entries');

        var setups = card('One-click setups', 'Worked out from the file values. One Ctrl+Z each; Save to file keeps it. Hover a button for exactly what it sets.');
        setupRow(setups, DRIFT_SETUPS);
        renderReadout(setups, DRIFT_TILES);

        var quick = card('Fine tuning', 'Small nudges from the current values; click again to go further.');
        var qrow = el('div', 'card-row');
        nudgeButton(qrow, 'More lock +5°', 'Steering lock +5° for bigger angles', function () {
            return { fSteeringLock: nudge('fSteeringLock', 5, 0, 90) };
        });
        nudgeButton(qrow, 'Slides easier', 'Slide grip -4% of peak: breaks loose and spins easier', function () {
            var mn = numVal('fTractionCurveMin'), mx = numVal('fTractionCurveMax');
            return { fTractionCurveMin: (mn === null || mx === null) ? undefined : Math.max(0, mn - mx * 0.04) };
        });
        nudgeButton(qrow, 'Holds angle better', 'Slide grip +4% of peak: more grip while sideways', function () {
            var mn = numVal('fTractionCurveMin'), mx = numVal('fTractionCurveMax');
            return { fTractionCurveMin: (mn === null || mx === null) ? undefined : Math.min(mx, mn + mx * 0.04) };
        });
        nudgeButton(qrow, 'More front bite', 'Traction bias front +0.02', function () {
            return { fTractionBiasFront: nudge('fTractionBiasFront', 0.02, 0, 1) };
        });
        nudgeButton(qrow, 'RWD', 'Drive bias front = 0', function () { return { fDriveBiasFront: 0 }; });
        quick.appendChild(qrow);
        flagToggle(quick, 'strHandlingFlags', 'FORCE_NO_TC_OR_SC', 'No traction / stability control', 'file only');

        renderDynCard('drift');

        fieldsEl.appendChild(el('div', 'field-group-label', 'Slide'));
        fieldCards(['fSteeringLock', 'fTractionCurveMax', 'fTractionCurveMin', 'fTractionCurveLateral', 'fTractionBiasFront', 'fLowSpeedTractionLossMult']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Power & handbrake'));
        fieldCards(['fDriveBiasFront', 'fInitialDriveForce', 'fDriveInertia', 'fHandBrakeForce', 'vecCentreOfMassOffset']);
    }

    function renderPickupPanel() {
        tabHead('Pickups & trucks', 'daily, HD, lifted, lowered, prerunner');

        var setups = card('One-click setups', 'Worked out from the file values, so clicking twice doesn\'t stack. One Ctrl+Z each; Save to file keeps it. Hover a button for exactly what it sets.');
        setupRow(setups, PICKUP_SETUPS);
        renderReadout(setups, PICKUP_TILES);

        renderPayloadCard();

        var quick = card('Truck tweaks', 'Small nudges from the current values; click again to go further.');
        var qrow = el('div', 'card-row');
        nudgeButton(qrow, 'Stiffer rear springs', 'Suspension bias front -0.05: more spring at the rear for a load', function () {
            return { fSuspensionBiasFront: nudge('fSuspensionBiasFront', -0.05, 0, 1) };
        });
        nudgeButton(qrow, 'Less body roll', 'Anti-roll bar force x1.15', function () {
            var v = numVal('fAntiRollBarForce');
            return { fAntiRollBarForce: v === null ? undefined : v * 1.15 };
        });
        nudgeButton(qrow, 'More low-down pull', 'Drive force x1.08 and drive inertia x0.95', function () {
            var f = numVal('fInitialDriveForce'), i = numVal('fDriveInertia');
            return { fInitialDriveForce: f === null ? undefined : f * 1.08, fDriveInertia: i === null ? undefined : i * 0.95 };
        });
        nudgeButton(qrow, 'Brake bias 60% F', 'Front-biased split for a heavy nose', function () { return { fBrakeBiasFront: 0.6 }; });
        nudgeButton(qrow, '4x4 (AWD 40/60)', 'Drive bias front = 0.4', function () { return { fDriveBiasFront: 0.4 }; });
        quick.appendChild(qrow);
        flagToggle(quick, 'strModelFlags', 'AXLE_R_SOLID', 'Solid rear axle', 'file only - leaf-spring live axle');
        flagToggle(quick, 'strModelFlags', 'DOUBLE_REAR_WHEELS', 'Dually rear wheels', 'file only');
        flagToggle(quick, 'strModelFlags', 'IS_BIG', 'Big vehicle', 'file only');

        renderDynCard('pickup');

        fieldsEl.appendChild(el('div', 'field-group-label', 'Weight & power'));
        fieldCards(['fMass', 'fInitialDriveForce', 'fDriveInertia', 'nInitialDriveGears', 'fInitialDriveMaxFlatVel', 'fDriveBiasFront']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Springs & ride'));
        fieldCards(['fSuspensionRaise', 'fSuspensionForce', 'fSuspensionCompDamp', 'fSuspensionReboundDamp', 'fSuspensionBiasFront', 'fAntiRollBarForce', 'vecCentreOfMassOffset']);
        fieldsEl.appendChild(el('div', 'field-group-label', 'Brakes'));
        fieldCards(['fBrakeForce', 'fBrakeBiasFront']);
    }

    // ---- export / modal ---------------------------------------------------

    function xmlEscape(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function buildXml(onlyChanged) {
        var lines = ['<Item type="CHandlingData">', '  <handlingName>' + xmlEscape(state.handlingName) + '</handlingName>'];
        state.groups.forEach(function (group) {
            group.fields.forEach(function (field) {
                var v = state.values[field.name];
                if (v === undefined || v === null || v === '') return;
                if (onlyChanged && !isChanged(field.name)) return;
                var n = field.name;
                if (field.type === 'float') lines.push('  <' + n + ' value="' + Number(v).toFixed(6) + '" />');
                else if (field.type === 'int') lines.push('  <' + n + ' value="' + Math.round(v) + '" />');
                else if (field.type === 'vector') {
                    lines.push('  <' + n + ' x="' + Number(v.x).toFixed(6) + '" y="' + Number(v.y).toFixed(6) + '" z="' + Number(v.z).toFixed(6) + '" />');
                } else lines.push('  <' + n + '>' + xmlEscape(v) + '</' + n + '>');
            });
        });
        lines.push('</Item>');
        return lines.join('\n');
    }

    function showXmlExport(onlyChanged) {
        openModal({
            title: onlyChanged ? 'Changed fields as XML' : 'Handling as XML',
            text: (onlyChanged ? 'Only the fields that differ from the file. ' : '') +
                'Covers the base CHandlingData fields this editor knows about.',
            value: buildXml(onlyChanged),
            readonly: true,
            actions: [
                { label: 'Close', cls: 'secondary' },
                { label: 'Copy', cls: 'primary', keepOpen: true, onClick: copyModalText },
            ],
        });
    }

    function copyModalText() {
        modalArea.focus();
        modalArea.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        setToast(ok ? 'Copied to clipboard.' : 'Select the text and press Ctrl+C to copy.', ok ? 'ok' : '');
        return ok;
    }

    function openModal(opts) {
        modalTitle.textContent = opts.title || '';
        modalText.textContent = opts.text || '';
        modalText.hidden = !opts.text;
        modalArea.value = opts.value || '';
        modalArea.readOnly = !!opts.readonly;
        modalArea.placeholder = opts.placeholder || '';
        modalActions.innerHTML = '';
        (opts.actions || [{ label: 'Close', cls: 'secondary' }]).forEach(function (a) {
            var b = el('button', a.cls || 'secondary', a.label);
            b.addEventListener('click', function () {
                var keep = a.onClick ? a.onClick(modalArea.value) : false;
                if (!a.keepOpen && keep !== true) closeModal();
            });
            modalActions.appendChild(b);
        });
        modal.hidden = false;
        modalArea.focus();
        if (opts.readonly) modalArea.select();
    }

    function closeModal() {
        modal.hidden = true;
    }

    // Two-click confirm for destructive buttons: the first click arms it.
    function confirmClick(btn, armedText, fn) {
        var idle = btn.textContent;
        var timer = null;
        btn.addEventListener('click', function () {
            if (timer) {
                clearTimeout(timer);
                timer = null;
                btn.textContent = idle;
                fn();
                return;
            }
            btn.textContent = armedText;
            timer = setTimeout(function () {
                timer = null;
                btn.textContent = idle;
            }, 2500);
        });
    }

    // ---- telemetry --------------------------------------------------------

    var tmSpeed = document.getElementById('tm-speed');
    var tmSpeedUnit = document.getElementById('tm-speed-unit');
    var tmGear = document.getElementById('tm-gear');
    var tmRpm = document.getElementById('tm-rpm-fill');
    var tm100 = document.getElementById('tm-100');
    var tm60 = document.getElementById('tm-60');
    var tmQ = document.getElementById('tm-q');
    var tmTop = document.getElementById('tm-top');

    function speedValue(ms) {
        return ms * (state.speedUnit === 'mph' ? 2.236936 : 3.6);
    }

    function speedText(ms) {
        return Math.round(speedValue(ms)) + (state.speedUnit === 'mph' ? ' mph' : ' km/h');
    }

    function fmtTime(t) {
        return typeof t === 'number' ? t.toFixed(2) + 's' : '–';
    }

    function setTimer(node, key, data) {
        var run = data.run || {};
        var best = data.best || {};
        var value = run[key];
        node.classList.toggle('running', !!data.running && value === undefined);
        if (value !== undefined) node.textContent = fmtTime(value);
        else if (data.running && typeof data.elapsed === 'number') node.textContent = data.elapsed.toFixed(1) + 's';
        else node.textContent = fmtTime(best[key]);
        node.parentNode.title = 'Last run: ' + fmtTime(value) + '  ·  Best: ' + fmtTime(best[key]) +
            (key === 'tQuarter' && best.trap ? ' @ ' + speedText(best.trap) : '');
    }

    function renderTelemetry() {
        var d = state.telemetry;
        tmSpeedUnit.textContent = state.speedUnit === 'mph' ? 'mph' : 'km/h';
        if (!d) return;
        tmSpeed.textContent = Math.round(speedValue(d.speed || 0));
        var gear = d.gear;
        tmGear.textContent = gear === 0 ? ((d.speed || 0) > 0.5 ? 'R' : 'N') : String(gear);
        tmRpm.style.width = (Math.max(0, Math.min(1, d.rpm || 0)) * 100) + '%';
        setTimer(tm100, 't100', d);
        setTimer(tm60, 't60', d);
        setTimer(tmQ, 'tQuarter', d);
        tmTop.textContent = Math.round(speedValue(d.top || 0));
    }

    function resetTelemetry() {
        postNui('resetTelemetry');
        state.telemetry = null;
        tmSpeed.textContent = '0';
        tmTop.textContent = '0';
        [tm100, tm60, tmQ].forEach(function (n) { n.textContent = '–'; n.classList.remove('running'); });
        if (state.view === 'tools') renderContent();
        setToast('Telemetry reset.');
    }

    document.querySelector('.tm-speed').addEventListener('click', function () {
        state.speedUnit = state.speedUnit === 'mph' ? 'kmh' : 'mph';
        savePref('speedUnit', state.speedUnit);
        renderTelemetry();
    });
    document.getElementById('tm-reset').addEventListener('click', resetTelemetry);

    function applyDisplayPrefs() {
        document.body.classList.toggle('no-telemetry', !state.showTelemetry);
        descBtn.classList.toggle('on', state.showDesc);
        changedOnlyBtn.classList.toggle('on', state.changedOnly);
        renderTelemetry();
    }

    function setShowDesc(on) {
        state.showDesc = on;
        savePref('showDesc', on);
        applyDisplayPrefs();
        renderContent();
    }

    function setChangedOnly(on) {
        state.changedOnly = on;
        applyDisplayPrefs();
    }

    // ---- whole-class apply ----------------------------------------------

    function renderClassBar() {
        classSelect.innerHTML = '';
        state.classes.forEach(function (c) {
            var opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name + ' (' + c.count + ')';
            if (c.id === state.classId) opt.selected = true;
            classSelect.appendChild(opt);
        });
        classBar.hidden = !state.classes.length;
        classConfirm.hidden = true;
        renderScopeSelect();
    }

    // "Only in <resource>" limits a class-wide edit to one vehicle pack. It
    // defaults to the resource the current vehicle's handling.meta was found in
    // (known once the file lookup answers); "All resources" is always available.
    function renderScopeSelect() {
        var previous = scopeSelect.value;
        scopeSelect.innerHTML = '';
        var options = [];
        if (state.resource) options.push({ value: state.resource, text: state.resource });
        options.push({ value: '', text: 'All resources' });
        options.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.text;
            scopeSelect.appendChild(opt);
        });
        var keep = options.some(function (o) { return o.value === previous; }) && previous !== '';
        scopeSelect.value = keep ? previous : options[0].value;
        classConfirm.hidden = true;
    }

    function selectedClass() {
        var id = parseInt(classSelect.value, 10);
        return state.classes.filter(function (c) { return c.id === id; })[0] || null;
    }

    // Only the fields you've edited; flags/strings are never applied class-wide.
    function touchedValues() {
        var out = {};
        Object.keys(state.touched).forEach(function (name) {
            var field = state.byName[name];
            if (!field || field.type === 'flags' || field.type === 'string') return;
            if (state.values[name] !== undefined) out[name] = state.values[name];
        });
        return out;
    }

    // Step 1: ask the game/server which models are really in scope. The summary
    // is shown once the exact count comes back (see the 'classScope' message).
    function openClassConfirm() {
        var cls = selectedClass();
        if (!cls) return;
        if (!Object.keys(touchedValues()).length) {
            setToast('Change a value first — only the fields you edit (outlined in blue) are applied to the class.', 'err');
            return;
        }
        classConfirm.hidden = true;
        setToast('Checking which ' + cls.name + ' models are in scope…');
        postNui('classScope', { classId: cls.id, resource: scopeSelect.value });
    }

    function selectedModelNames() {
        return state.scopeModels
            .filter(function (m) { return !state.excluded[m.name]; })
            .map(function (m) { return m.name; });
    }

    // Headline count plus enabling/disabling the action buttons: with nothing
    // ticked there is nothing to apply.
    function updateClassHead() {
        var selected = selectedModelNames().length;
        var total = state.scopeModels.length;
        if (classHead) {
            classHead.textContent = state.scopeClassName + ' — set on ' + selected + ' of ' + total +
                ' vehicle' + (total === 1 ? '' : 's') + state.scopeWhere + ':';
        }
        document.getElementById('class-live-btn').disabled = selected === 0;
        classSaveBtn.disabled = selected === 0;
    }

    // The tick list, filtered by the box above it. Toggling a row only touches
    // state.excluded and that row's style, so the list keeps its scroll position.
    function renderClassModels() {
        var needle = classModelFilter.value.trim().toLowerCase();
        classModels.innerHTML = '';
        state.scopeModels.forEach(function (m) {
            var text = (m.name + ' ' + (m.label || '')).toLowerCase();
            if (needle && text.indexOf(needle) === -1) return;

            var row = document.createElement('label');
            row.className = 'class-model' + (state.excluded[m.name] ? ' off' : '');

            var box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = !state.excluded[m.name];
            box.addEventListener('change', function () {
                if (box.checked) delete state.excluded[m.name]; else state.excluded[m.name] = true;
                row.classList.toggle('off', !box.checked);
                updateClassHead();
            });

            var name = document.createElement('span');
            name.className = 'name';
            name.textContent = m.name;
            row.appendChild(box);
            row.appendChild(name);
            if (m.label) {
                var label = document.createElement('span');
                label.className = 'label';
                label.textContent = m.label;
                row.appendChild(label);
            }
            classModels.appendChild(row);
        });
    }

    // All / None act on the rows currently shown, so filter "suv" then None
    // leaves everything else ticked.
    function setShownTicked(ticked) {
        var needle = classModelFilter.value.trim().toLowerCase();
        state.scopeModels.forEach(function (m) {
            var text = (m.name + ' ' + (m.label || '')).toLowerCase();
            if (needle && text.indexOf(needle) === -1) return;
            if (ticked) delete state.excluded[m.name]; else state.excluded[m.name] = true;
        });
        renderClassModels();
        updateClassHead();
    }

    // Step 2: show exactly what will be set and on which models.
    function showClassSummary(msg) {
        var cls = selectedClass();
        var values = touchedValues();
        var names = Object.keys(values);
        if (!cls || cls.id !== msg.classId || (msg.resource || '') !== scopeSelect.value) return; // stale
        if (!names.length) return;

        state.scopeWhere = msg.resource ? ' in ' + msg.resource : ' across ALL resources';
        state.scopeClassName = cls.name;
        if (!msg.count) {
            setToast('No ' + cls.name + ' models found' + state.scopeWhere + '.', 'err');
            return;
        }

        // Everything in scope starts ticked; untick to leave a vehicle out.
        state.scopeModels = msg.models || [];
        state.excluded = {};
        classModelFilter.value = '';
        renderClassModels();

        classSummary.innerHTML = '';
        classHead = document.createElement('div');
        classHead.className = 'head';
        classSummary.appendChild(classHead);
        updateClassHead();
        names.slice(0, 8).forEach(function (name) {
            var row = document.createElement('div');
            row.className = 'row';
            row.textContent = (state.byName[name].label || name) + ' = ' + valueText(values[name]);
            classSummary.appendChild(row);
        });
        if (names.length > 8) {
            var more = document.createElement('div');
            more.className = 'row';
            more.textContent = '+ ' + (names.length - 8) + ' more';
            classSummary.appendChild(more);
        }
        setToast('');
        classConfirm.hidden = false;
        if (state.view !== 'bulk') setView('bulk');
    }

    function sendClassRequest(action) {
        var cls = selectedClass();
        if (!cls) return;
        var models = selectedModelNames();
        if (!models.length) return;
        classConfirm.hidden = true;
        if (action === 'classSave') {
            classSaveBtn.disabled = true;
            setToast('Saving to ' + models.length + ' ' + cls.name + ' vehicle' + (models.length === 1 ? '' : 's') + '…');
        } else {
            setToast('Applying…');
        }
        postNui(action, { classId: cls.id, resource: scopeSelect.value, values: touchedValues(), models: models });
    }

    // ---- presets ----------------------------------------------------------
    // Saved locally (per game client) in the browser's localStorage, same as
    // the panel's remembered position/size. Each preset only stores the
    // fields you'd actually touched when you saved it, not a full snapshot.

    var PRESETS_KEY = 'handling_editor.presets';

    function loadPresets() {
        try {
            var raw = JSON.parse(localStorage.getItem(PRESETS_KEY));
            if (Array.isArray(raw)) return raw;
        } catch (e) { /* no storage */ }
        return [];
    }

    function persistPresets() {
        try { localStorage.setItem(PRESETS_KEY, JSON.stringify(state.presets)); } catch (e) { /* no storage */ }
    }

    function newPresetId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // Unlike touchedValues() (used for whole-class apply), this keeps flags/
    // string fields too, since a preset is meant to be a full "what I changed"
    // snapshot rather than something restricted to live-previewable fields.
    function touchedFieldValues() {
        var out = {};
        Object.keys(state.touched).forEach(function (name) {
            if (state.values[name] !== undefined) out[name] = state.values[name];
        });
        return out;
    }

    function saveCurrentAsPreset(name) {
        var values = touchedFieldValues();
        var names = Object.keys(values);
        if (!names.length) {
            setToast("Change a value first — presets save the fields you've edited (outlined in blue).", 'err');
            return;
        }
        state.presets.push({ id: newPresetId(), name: name, values: clean(values) });
        persistPresets();
        renderContent();
        setToast('Saved preset "' + name + '" (' + names.length + ' field' + (names.length === 1 ? '' : 's') + ').', 'ok');
    }

    function overwritePreset(preset) {
        var values = touchedFieldValues();
        var count = Object.keys(values).length;
        if (!count) {
            setToast("Nothing to save — edit some fields first (outlined in blue).", 'err');
            return;
        }
        preset.values = clean(values);
        persistPresets();
        renderContent();
        setToast('Updated preset "' + preset.name + '" with ' + count + ' field' + (count === 1 ? '' : 's') + '.', 'ok');
    }

    function applyPreset(preset) {
        if (!preset || !preset.values) return;
        if (state.presetTarget) {
            applyPresetToOtherVehicle(preset);
            return;
        }
        var names = Object.keys(preset.values);
        var changes = [];
        names.forEach(function (name) {
            var field = state.byName[name];
            if (!field) return; // field no longer exists (e.g. shared/fields.lua changed)
            var v = clean(preset.values[name]);
            changes.push({ name: name, before: state.values[name], after: v });
            state.values[name] = v;
            state.touched[name] = true;
            if (isNumeric(field)) forceSendLive(name, v);
        });
        record(changes);
        state.filter = '';
        filterInput.value = '';
        setView('group');
        setToast('Applied preset "' + preset.name + '" (' + names.length + ' field' + (names.length === 1 ? '' : 's') +
            ') — click Save to file to keep it. Ctrl+Z undoes it.', 'ok');
    }

    // Presets applied to a vehicle other than the one you're sitting in skip
    // the live/touched/save-to-file flow entirely: there's nothing of yours to
    // preview, so this writes straight to that model's handling.meta (and
    // live-updates it if a copy happens to already be spawned). Flags/strings
    // are identity fields, not something to copy onto an unrelated vehicle, so
    // only numeric/vector fields are sent — same rule "Whole class" uses.
    function applyPresetToOtherVehicle(preset) {
        if (!can('bulk')) {
            setToast(DENIED_TEXT, 'err');
            return;
        }
        var values = {};
        var count = 0;
        Object.keys(preset.values).forEach(function (name) {
            var field = state.byName[name];
            if (!field || field.type === 'flags' || field.type === 'string') return;
            values[name] = preset.values[name];
            count++;
        });
        if (!count) {
            setToast('Preset "' + preset.name + '" has no live-numeric fields (flags/strings aren\'t applied to another vehicle).', 'err');
            return;
        }
        setToast('Applying "' + preset.name + '" to ' + state.presetTarget + '…');
        postNui('applyPresetToVehicle', {
            model: state.presetTarget,
            resource: state.resource,
            values: values,
            presetName: preset.name,
        });
    }

    function exportPresets(list) {
        var data = list.map(function (p) { return { name: p.name, values: p.values }; });
        openModal({
            title: list.length === 1 ? 'Export preset "' + list[0].name + '"' : 'Export ' + list.length + ' presets',
            text: 'Share this text with another admin; they can paste it into Presets → Import.',
            value: JSON.stringify(list.length === 1 ? data[0] : data, null, 2),
            readonly: true,
            actions: [
                { label: 'Close', cls: 'secondary' },
                { label: 'Copy', cls: 'primary', keepOpen: true, onClick: copyModalText },
            ],
        });
    }

    function importPresets(text) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) {
            setToast('That isn\'t valid preset JSON.', 'err');
            return true; // keep the modal open so they can fix it
        }
        if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.presets)) parsed = parsed.presets;
        var list = Array.isArray(parsed) ? parsed : [parsed];
        var added = 0;
        list.forEach(function (p) {
            if (!p || typeof p !== 'object' || typeof p.values !== 'object' || !p.values) return;
            var values = {};
            Object.keys(p.values).forEach(function (k) {
                if (state.byName[k]) values[k] = p.values[k];
            });
            if (!Object.keys(values).length) return;
            var base = (typeof p.name === 'string' && p.name.trim()) ? p.name.trim().slice(0, 60) : 'Imported preset';
            var name = base, n = 2;
            while (state.presets.some(function (x) { return x.name === name; })) name = base + ' (' + (n++) + ')';
            state.presets.push({ id: newPresetId(), name: name, values: clean(values) });
            added++;
        });
        if (!added) {
            setToast('No usable presets found in that text.', 'err');
            return true;
        }
        persistPresets();
        renderContent();
        scheduleIndicators();
        setToast('Imported ' + added + ' preset' + (added === 1 ? '' : 's') + '.', 'ok');
        return false;
    }

    // Copies this vehicle's whole current handling (not just what you've
    // touched — everything shown, numeric/vector fields only) straight to
    // another vehicle's handling.meta, for a quick "clone this car onto that
    // one" without saving a preset first.
    function copyHandlingToVehicle() {
        if (!state.targetModel || !can('bulk')) return;
        var values = numericValues();
        if (!Object.keys(values).length) {
            setToast('Nothing to copy yet.', 'err');
            return;
        }
        var model = state.targetModel;
        setToast('Copying ' + (state.handlingName || 'this vehicle') + '\'s handling to ' + model + '…');
        postNui('applyPresetToVehicle', {
            model: model,
            resource: state.resource,
            values: values,
            presetName: (state.handlingName || 'vehicle') + ' -> ' + model,
        });
    }

    // ---- target vehicle pickers ---------------------------------------------
    // The Bulk tab's "Copy this car to" picker and the Presets tab's "Apply
    // presets to" picker each keep their own target. Both list the other
    // vehicles in the current vehicle's own resource — no folder to pick.

    function ensureResourceTargets() {
        if (!can('bulk')) return; // the server would refuse the lookup anyway
        if (!state.resource || state.targetsResource === state.resource || state.targetsLoading) return;
        state.targetsLoading = true;
        postNui('listVehicles', { resource: state.resource });
    }

    // Fills `select` with a first option (value '') plus the other vehicles in
    // this resource, and returns `value` if it's still listed, else ''.
    function fillVehicleSelect(select, firstText, value) {
        select.innerHTML = '';
        var firstOpt = document.createElement('option');
        firstOpt.value = '';
        firstOpt.textContent = state.resource ? firstText : 'No handling.meta found for this car yet';
        select.appendChild(firstOpt);

        if (state.targetsLoading) {
            var loadingOpt = document.createElement('option');
            loadingOpt.disabled = true;
            loadingOpt.textContent = 'Loading vehicles from ' + state.resource + '…';
            select.appendChild(loadingOpt);
        } else if (state.resource && state.resourceTargets.length) {
            var others = state.resourceTargets.filter(function (m) {
                return m.name.toUpperCase() !== (state.handlingName || '').toUpperCase();
            });
            if (others.length) {
                var group = document.createElement('optgroup');
                group.label = 'Vehicles in ' + state.resource;
                others.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (m) {
                    var opt = document.createElement('option');
                    opt.value = m.name;
                    opt.textContent = m.label ? (m.name + ' — ' + m.label) : m.name;
                    group.appendChild(opt);
                });
                select.appendChild(group);
            }
        }
        // The list can go stale (e.g. a target picked, then the current
        // vehicle changes); fall back rather than show a dangling value.
        if (value && !Array.prototype.some.call(select.options, function (o) { return o.value === value; })) {
            value = '';
        }
        select.value = value;
        return value;
    }

    function renderCopyBar() {
        ensureResourceTargets();
        state.targetModel = fillVehicleSelect(copyTargetSelect, 'Pick a vehicle…', state.targetModel);

        var target = state.targetModel;
        copyBtn.disabled = !target;
        copyBtn.textContent = target ? ('Copy to ' + target) : 'Copy';
        copyBtn.title = target
            ? ('Copy ' + (state.handlingName || 'this car') + '\'s current handling onto ' + target + ' and save it to ' + target + '\'s handling.meta')
            : 'Pick a vehicle to copy this car\'s handling onto';
        copyHint.hidden = !target;
        copyHint.textContent = target
            ? ('Replaces ' + target + '\'s handling with this car\'s current values and saves it to file right away. ' +
               'Restart ' + state.resource + ' to see it on newly spawned ' + target + 's.')
            : '';
    }

    // Re-syncs the Bulk tab picker plus the Presets tab (if open).
    function refreshTargetPickers() {
        renderCopyBar();
        if (state.view === 'presets') renderContent();
    }

    copyTargetSelect.addEventListener('change', function () {
        state.targetModel = copyTargetSelect.value;
        refreshTargetPickers();
    });
    copyBtn.addEventListener('click', copyHandlingToVehicle);

    function deletePreset(id) {
        state.presets = state.presets.filter(function (p) { return p.id !== id; });
        persistPresets();
        renderContent();
    }

    // ---- shared presets (kept on the server, every staff member sees them) --

    var sharedLoading = false;

    function loadSharedPresets() {
        sharedLoading = true;
        rpc('presets.list').then(function (res) {
            sharedLoading = false;
            state.sharedPresets = res.ok ? (res.presets || []) : [];
            state.sharedNow = res.now || 0;
            if (!res.ok) setToast(res.message || 'Could not load shared presets.', 'err');
            if (state.view === 'presets') renderContent();
        });
    }

    function sharedAnswer(res) {
        setToast(res.message || (res.ok ? 'Done.' : 'That didn\'t work.'), res.ok ? 'ok' : 'err');
        if (res.presets) state.sharedPresets = res.presets;
        else state.sharedPresets = null;
        if (state.view === 'presets') renderContent();
    }

    function sharePreset(preset) {
        rpc('presets.publish', { name: preset.name, values: preset.values }).then(sharedAnswer);
    }

    function keepSharedCopy(preset) {
        var base = preset.name, name = base, n = 2;
        while (state.presets.some(function (x) { return x.name === name; })) name = base + ' (' + (n++) + ')';
        state.presets.push({ id: newPresetId(), name: name, values: clean(preset.values) });
        persistPresets();
        renderContent();
        setToast('Saved a copy of "' + preset.name + '" on this PC' + (name !== base ? ' as "' + name + '"' : '') + '.', 'ok');
    }

    function presetSummary(info, preset) {
        var keys = Object.keys(preset.values || {});
        info.appendChild(el('div', 'count', keys.length + ' field' + (keys.length === 1 ? '' : 's') + ': ' + keys.map(fieldLabel).join(', ')));
        info.title = keys.map(function (k) { return k + ' = ' + valueText(preset.values[k]); }).join('\n');
    }

    function applyButton(preset) {
        var applyBtn = el('button', 'secondary', state.presetTarget ? 'Apply & save' : 'Apply');
        applyBtn.title = state.presetTarget
            ? ('Live-update and save directly to ' + state.presetTarget + '\'s handling.meta')
            : "Apply to the vehicle you're in";
        applyBtn.addEventListener('click', function () { applyPreset(preset); });
        return applyBtn;
    }

    function renderSharedPresets(wrap) {
        var head = el('div', 'preset-section');
        head.appendChild(el('span', '', 'Shared on the server'));
        var refresh = el('button', 'secondary small', 'Refresh');
        refresh.addEventListener('click', function () {
            state.sharedPresets = null;
            renderContent();
        });
        head.appendChild(refresh);
        wrap.appendChild(head);

        var list = el('div', 'preset-list');
        if (state.sharedPresets === null) {
            if (!sharedLoading) loadSharedPresets();
            list.appendChild(el('div', 'preset-empty', 'Loading…'));
        } else if (!state.sharedPresets.length) {
            list.appendChild(el('div', 'preset-empty', can('publish')
                ? 'Nothing shared yet. Use Share on one of your presets below.'
                : 'Nothing shared yet.'));
        } else {
            state.sharedPresets.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (preset) {
                var row = el('div', 'preset-item shared');
                var info = el('div', 'info');
                info.appendChild(el('div', 'name', preset.name));
                presetSummary(info, preset);
                var by = el('div', 'count by', 'by ' + ((preset.by && preset.by.name) || '?') + ' · ' + ago(preset.t, state.sharedNow));
                by.title = fullDate(preset.t);
                info.appendChild(by);

                var actions = el('div', 'actions');
                actions.appendChild(applyButton(preset));
                var keep = el('button', 'secondary', 'Copy to PC');
                keep.title = 'Save a copy in your own presets on this PC';
                keep.addEventListener('click', function () { keepSharedCopy(preset); });
                actions.appendChild(keep);
                var expBtn = el('button', 'secondary', 'Export');
                expBtn.addEventListener('click', function () { exportPresets([preset]); });
                actions.appendChild(expBtn);
                if (preset.canDelete) {
                    var delBtn = el('button', 'secondary danger', 'Delete');
                    delBtn.title = preset.mine ? 'Remove it from the server' : 'Remove it from the server for everyone (you can manage)';
                    confirmClick(delBtn, 'Sure?', function () {
                        rpc('presets.delete', { id: preset.id }).then(sharedAnswer);
                    });
                    actions.appendChild(delBtn);
                }
                row.appendChild(info);
                row.appendChild(actions);
                list.appendChild(row);
            });
        }
        wrap.appendChild(list);

        var mineHead = el('div', 'preset-section');
        mineHead.appendChild(el('span', '', 'On this PC'));
        wrap.appendChild(mineHead);
    }

    function renderPresetsPanel() {
        tabHead('Presets', can('publish') ? 'yours on this PC, or shared with everyone' : 'saved on this game client');

        var wrap = el('div', 'preset-panel');

        var saveRow = el('div', 'preset-save-row');
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Preset name…';
        nameInput.autocomplete = 'off';
        nameInput.spellcheck = false;
        var saveBtnEl = el('button', 'primary', 'Save preset');
        function trySave() {
            var name = nameInput.value.trim();
            if (!name) { setToast('Name the preset first.', 'err'); return; }
            if (state.presets.some(function (p) { return p.name === name; })) {
                setToast('A preset named "' + name + '" already exists — use its Update button or pick another name.', 'err');
                return;
            }
            saveCurrentAsPreset(name);
        }
        saveBtnEl.addEventListener('click', trySave);
        nameInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') trySave();
        });
        saveRow.appendChild(nameInput);
        saveRow.appendChild(saveBtnEl);
        wrap.appendChild(saveRow);

        var touchedCount = Object.keys(touchedFieldValues()).length;
        wrap.appendChild(el('div', 'preset-hint', touchedCount
            ? ('Saves the ' + touchedCount + ' field' + (touchedCount === 1 ? '' : 's') + " you've edited (outlined in blue) on this vehicle.")
            : "Change a value first (outlined in blue) — a preset only saves the fields you've edited, not the whole vehicle."));

        if (can('bulk')) {
            var targetRow = el('label', 'preset-target-row');
            targetRow.appendChild(document.createTextNode('Apply presets to'));
            var targetSelect = document.createElement('select');
            targetSelect.id = 'preset-target-select';
            state.presetTarget = fillVehicleSelect(targetSelect,
                'My car (' + (state.handlingName || 'current') + ')', state.presetTarget);
            targetSelect.addEventListener('change', function () {
                state.presetTarget = targetSelect.value;
                renderContent();
            });
            targetRow.appendChild(targetSelect);
            wrap.appendChild(targetRow);
        } else {
            state.presetTarget = '';
        }

        if (state.presetTarget) {
            wrap.appendChild(el('div', 'preset-hint target', 'Apply saves straight to ' + state.presetTarget + '\'s handling.meta ' +
                '(number fields only) - no need to press Save to file.'));
        }

        var tools = el('div', 'preset-tools');
        var importBtn = el('button', 'secondary small', 'Import…');
        importBtn.addEventListener('click', function () {
            openModal({
                title: 'Import presets',
                text: 'Paste preset JSON exported from this editor (one preset or a list).',
                value: '',
                placeholder: '{ "name": "...", "values": { ... } }',
                actions: [
                    { label: 'Cancel', cls: 'secondary' },
                    { label: 'Import', cls: 'primary', onClick: importPresets },
                ],
            });
        });
        var exportAll = el('button', 'secondary small', 'Export all');
        exportAll.disabled = !state.presets.length;
        exportAll.addEventListener('click', function () { exportPresets(state.presets); });
        tools.appendChild(importBtn);
        tools.appendChild(exportAll);
        wrap.appendChild(tools);

        renderSharedPresets(wrap);

        var list = el('div', 'preset-list');
        var sorted = state.presets.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
        if (!sorted.length) {
            list.appendChild(el('div', 'preset-empty', 'No saved presets yet.'));
        } else {
            sorted.forEach(function (preset) {
                var keys = Object.keys(preset.values || {});
                var count = keys.length;

                var row = el('div', 'preset-item');
                var info = el('div', 'info');
                info.appendChild(el('div', 'name', preset.name));
                var cnt = el('div', 'count', count + ' field' + (count === 1 ? '' : 's') + ': ' + keys.map(function (k) {
                    var f = state.byName[k];
                    return f ? (f.label || k) : k;
                }).join(', '));
                info.title = keys.map(function (k) { return k + ' = ' + valueText(preset.values[k]); }).join('\n');
                info.appendChild(cnt);

                var actions = el('div', 'actions');
                var applyBtn = applyButton(preset);
                var updBtn = el('button', 'secondary', 'Update');
                updBtn.title = 'Replace this preset with the fields you have edited now';
                confirmClick(updBtn, 'Sure?', function () { overwritePreset(preset); });
                var expBtn = el('button', 'secondary', 'Export');
                expBtn.addEventListener('click', function () { exportPresets([preset]); });
                var delBtn = el('button', 'secondary danger', 'Delete');
                confirmClick(delBtn, 'Sure?', function () { deletePreset(preset.id); });
                actions.appendChild(applyBtn);
                if (can('publish')) {
                    var shareBtn = el('button', 'secondary', 'Share');
                    shareBtn.title = 'Put a copy on the server so every staff member can use it';
                    shareBtn.addEventListener('click', function () { sharePreset(preset); });
                    actions.appendChild(shareBtn);
                }
                actions.appendChild(updBtn);
                actions.appendChild(expBtn);
                actions.appendChild(delBtn);

                row.appendChild(info);
                row.appendChild(actions);
                list.appendChild(row);
            });
        }
        wrap.appendChild(list);

        fieldsEl.appendChild(wrap);
    }

    function setToast(message, kind) {
        toast.textContent = message || '';
        toast.className = kind || '';
    }

    function close() {
        closeModal();
        root.hidden = true;
        terrainOn = '';
        aids = { lowRange: false, crawl: false, hillHold: false };
        payload = { kg: 0, bed: true };
        postNui('close');
    }

    function lockedOut() {
        return !!state.lock && !can('lock');
    }

    function updateSaveBtn() {
        saveBtn.disabled = state.saving || !can('save') || lockedOut();
        if (!can('save')) saveBtn.title = 'Your role can\'t save to file. You can still try edits live on your car.';
        else if (lockedOut()) saveBtn.title = lockText(state.lock, state.fileNow) + '. Only someone with the lock permission can save it.';
        else saveBtn.title = 'Write to handling.meta (Ctrl+S)';
    }

    function save() {
        if (!can('save')) { setToast(DENIED_TEXT, 'err'); return; }
        if (lockedOut()) { setToast(lockText(state.lock, state.fileNow) + '. Only someone with the lock permission can save it.', 'err'); return; }
        if (state.saving) return;
        state.saving = true;
        updateSaveBtn();
        setToast('Saving…');
        postNui('save', { values: state.values });
    }

    // Role badge, freecam button and backup toggle follow the role.
    var roleBadge = document.getElementById('role-badge');
    function renderAccessBits() {
        var a = state.access || {};
        roleBadge.hidden = !a.roleLabel;
        roleBadge.textContent = a.roleLabel || '';
        roleBadge.title = a.roleLabel ? ('Your handling editor role' + (a.discord ? ' (Discord ' + a.discord + ')' : '')) : '';
        document.getElementById('freecam-btn').hidden = !can('freecam');
        document.getElementById('backup-toggle').hidden = !can('save') && !can('bulk');
        updateSaveBtn();
    }

    // ---- draggable / resizable panel ------------------------------------

    var LAYOUT_KEY = 'handling_editor.layout';
    var MIN_W = 380;
    var MIN_H = 300;
    var drag = null;

    function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
    }

    function setLayout(l) {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var w = clamp(l.width, Math.min(MIN_W, vw), vw);
        var h = clamp(l.height, Math.min(MIN_H, vh), vh);
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
        panel.style.left = clamp(l.left, 0, vw - w) + 'px';
        panel.style.top = clamp(l.top, 0, vh - h) + 'px';
    }

    function currentLayout() {
        var r = panel.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    function restoreLayout() {
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)); } catch (e) { /* no storage */ }
        if (saved && isFinite(saved.left) && isFinite(saved.top) && isFinite(saved.width) && isFinite(saved.height)) {
            setLayout(saved);
            return;
        }
        var h = Math.min(Math.round(window.innerHeight * 0.88), 780);
        setLayout({
            left: window.innerWidth - 500 - 24,
            top: Math.round((window.innerHeight - h) / 2),
            width: 500,
            height: h,
        });
    }

    function startDrag(e, mode, dir) {
        if (e.button !== 0) return;
        var r = panel.getBoundingClientRect();
        drag = {
            mode: mode, dir: dir || '',
            x: e.clientX, y: e.clientY,
            left: r.left, top: r.top, width: r.width, height: r.height,
        };
        document.body.classList.add('dragging');
        e.preventDefault();
    }

    document.getElementById('panel-header').addEventListener('mousedown', function (e) {
        if (e.target.closest('input, button, select, .tm-speed')) return;
        startDrag(e, 'move');
    });

    Array.prototype.forEach.call(panel.querySelectorAll('.rz'), function (handle) {
        handle.addEventListener('mousedown', function (e) {
            startDrag(e, 'resize', handle.getAttribute('data-dir'));
        });
    });

    window.addEventListener('mousemove', function (e) {
        if (!drag) return;
        var dx = e.clientX - drag.x;
        var dy = e.clientY - drag.y;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var l = drag.left, t = drag.top, w = drag.width, h = drag.height;

        if (drag.mode === 'move') {
            l = clamp(drag.left + dx, 0, vw - w);
            t = clamp(drag.top + dy, 0, vh - h);
        } else {
            var right = drag.left + drag.width;
            var bottom = drag.top + drag.height;
            if (drag.dir.indexOf('e') !== -1) w = clamp(drag.width + dx, MIN_W, vw - drag.left);
            if (drag.dir.indexOf('s') !== -1) h = clamp(drag.height + dy, MIN_H, vh - drag.top);
            if (drag.dir.indexOf('w') !== -1) { w = clamp(drag.width - dx, MIN_W, right); l = right - w; }
            if (drag.dir.indexOf('n') !== -1) { h = clamp(drag.height - dy, MIN_H, bottom); t = bottom - h; }
        }
        setLayout({ left: l, top: t, width: w, height: h });
    });

    window.addEventListener('mouseup', function () {
        if (!drag) return;
        drag = null;
        document.body.classList.remove('dragging');
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(currentLayout())); } catch (e) { /* no storage */ }
    });

    // Keep the panel on screen if the game window changes size.
    window.addEventListener('resize', function () {
        if (!root.hidden) setLayout(currentLayout());
    });

    // ---- buttons / keys -------------------------------------------------

    document.getElementById('close-btn').addEventListener('click', close);
    // ? brings the getting-started guide back, above the field list.
    document.getElementById('guide-btn').addEventListener('click', function () {
        setGuideHidden(false);
        if (state.changedOnly) setChangedOnly(false);
        setView('group', state.view === 'group' ? state.activeGroup : 0);
    });
    document.getElementById('release-btn').addEventListener('click', function () {
        postNui('releaseFocus');
    });
    document.getElementById('freecam-btn').addEventListener('click', function () {
        postNui('freecam');
    });

    // Text boxes keep their own Ctrl+Z; everywhere else it's the editor's undo.
    function isTextEntry(target) {
        if (!target || !target.tagName) return false;
        if (target.tagName === 'TEXTAREA') return true;
        return target.tagName === 'INPUT' && target.type === 'text';
    }

    document.addEventListener('keydown', function (e) {
        if (root.hidden) return;
        if (!modal.hidden) {
            if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
            return;
        }
        var ctrl = e.ctrlKey || e.metaKey;
        var key = (e.key || '').toLowerCase();
        if (e.key === 'Escape') close();
        else if (e.key === 'F6') postNui('releaseFocus');
        else if (e.key === 'F7') { if (can('freecam')) postNui('freecam'); }
        else if (ctrl && key === 's') { e.preventDefault(); save(); }
        else if (ctrl && key === 'f') { e.preventDefault(); filterInput.focus(); filterInput.select(); }
        else if (ctrl && (key === 'z' || key === 'y') && !isTextEntry(e.target)) {
            e.preventDefault();
            if (key === 'y' || e.shiftKey) redo(); else undo();
        }
    });

    filterInput.addEventListener('input', function () {
        state.filter = filterInput.value.trim();
        if (state.view !== 'group') state.view = 'group';
        render();
    });

    changedOnlyBtn.addEventListener('click', function () {
        setChangedOnly(!state.changedOnly);
        if (state.changedOnly) state.view = 'group';
        fieldsScroll.scrollTop = 0;
        render();
    });

    descBtn.addEventListener('click', function () { setShowDesc(!state.showDesc); });

    handlingNameInput.addEventListener('change', function () {
        state.handlingName = handlingNameInput.value.trim().toUpperCase();
        handlingNameInput.value = state.handlingName;
    });
    handlingNameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') document.getElementById('reload-btn').click();
    });

    document.getElementById('reload-btn').addEventListener('click', function () {
        state.handlingName = handlingNameInput.value.trim().toUpperCase();
        handlingNameInput.value = state.handlingName;
        setToast('Looking up handling.meta…');
        sourceLine.className = '';
        sourceLine.textContent = 'Looking up handling.meta…';
        postNui('reloadFile', { handlingName: state.handlingName });
    });

    document.getElementById('reset-file-btn').addEventListener('click', function () {
        postNui('resetToFile');
    });

    document.getElementById('reset-live-btn').addEventListener('click', function () {
        postNui('resetToLive');
    });

    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);

    document.getElementById('class-open-btn').addEventListener('click', openClassConfirm);
    document.getElementById('class-cancel-btn').addEventListener('click', function () {
        classConfirm.hidden = true;
    });
    document.getElementById('class-live-btn').addEventListener('click', function () {
        sendClassRequest('classLive');
    });
    classSaveBtn.addEventListener('click', function () {
        sendClassRequest('classSave');
    });
    classModelFilter.addEventListener('input', renderClassModels);
    document.getElementById('class-all-btn').addEventListener('click', function () { setShownTicked(true); });
    document.getElementById('class-none-btn').addEventListener('click', function () { setShownTicked(false); });

    // The summary names the class and scope, so changing either makes it stale.
    classSelect.addEventListener('change', function () { classConfirm.hidden = true; });
    scopeSelect.addEventListener('change', function () { classConfirm.hidden = true; });

    // "Keep .bak backup": off by default, remembered per game client, and sent
    // to the client script so every kind of save (single, class, preset) uses it.
    var BACKUP_KEY = 'handling_editor.backup';
    var backupCheck = document.getElementById('backup-check');
    try { backupCheck.checked = localStorage.getItem(BACKUP_KEY) === '1'; } catch (e) { /* no storage */ }
    function sendBackupSetting() {
        postNui('setBackup', { enabled: backupCheck.checked });
    }
    backupCheck.addEventListener('change', function () {
        try { localStorage.setItem(BACKUP_KEY, backupCheck.checked ? '1' : '0'); } catch (e) { /* no storage */ }
        sendBackupSetting();
    });

    saveBtn.addEventListener('click', save);

    function renderVehicleSub() {
        var cls = state.classes.filter(function (c) { return c.id === state.classId; })[0];
        var parts = [];
        if (state.displayName) parts.push(state.displayName);
        if (cls) parts.push(cls.name);
        vehicleSub.textContent = parts.join(' · ');
    }

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (!data || !data.action) return;

        switch (data.action) {
            case 'open': {
                sendBackupSetting();
                state.groups = data.groups || [];
                state.byName = {};
                state.groupOf = {};
                state.groups.forEach(function (g, idx) {
                    g.fields.forEach(function (f) {
                        state.byName[f.name] = f;
                        state.groupOf[f.name] = idx;
                    });
                });
                state.handlingName = data.handlingName || '';
                state.displayName = data.displayName || '';
                state.values = cleanValues(data.live);
                state.car = cleanValues(data.live);
                state.adopted = data.adopted || {};
                state.lastEdit = {};
                state.toldLive = false;
                state.baseline = {};
                state.touched = {};
                state.flagsOpen = {};
                state.classes = data.classes || [];
                state.classId = data.classId;
                state.resource = '';
                state.targetModel = '';
                state.presetTarget = '';
                state.resourceTargets = [];
                state.targetsResource = null;
                state.targetsLoading = false;
                state.telemetry = null;
                state.access = data.access || { perms: {} };
                state.lock = null;
                state.handling = '';
                state.fileNow = 0;
                state.saving = false;
                state.sharedPresets = null;
                state.history = null;
                state.accessData = null;
                state.locksData = null;
                state.afterApplyToast = null;
                histOpen = {};
                undoStack = [];
                redoStack = [];
                // The client switches aids and the terrain feed off whenever the
                // editor closes, so start from the same place here.
                aids = { lowRange: false, crawl: false, hillHold: false };
                aidStatus = {};
                abSlots = { A: null, B: null };
                payload = { kg: 0, bed: true };
                terrainOn = '';
                compScale = 0.2;
                renderClassBar();
                renderVehicleSub();
                state.view = 'group';
                state.activeGroup = 0;
                state.filter = '';
                state.changedOnly = false;
                filterInput.value = '';
                handlingNameInput.value = state.handlingName;
                sourceLine.className = '';
                sourceLine.textContent = 'Looking up handling.meta…';
                setToast(can('save')
                    ? (state.guideHidden ? 'Change any value and it goes straight onto your car. Save to file to keep it.' : '')
                    : 'Your role (' + (state.access.roleLabel || 'none') + ') can try edits on your car but can\'t save them to file.');
                renderAccessBits();
                closeModal();
                applyDisplayPrefs();
                root.hidden = false;
                restoreLayout();
                render();
                renderCopyBar();
                break;
            }
            case 'close': {
                closeModal();
                root.hidden = true;
                terrainOn = '';
                aids = { lowRange: false, crawl: false, hillHold: false };
                payload = { kg: 0, bed: true };
                break;
            }
            case 'freecam': {
                document.body.classList.toggle('freecam', !!data.active);
                var freecamBtn = document.getElementById('freecam-btn');
                freecamBtn.classList.toggle('active', !!data.active);
                freecamBtn.textContent = data.active ? 'Exit freecam' : 'Freecam';
                break;
            }
            case 'focus': {
                panel.classList.toggle('unfocused', !data.focused);
                document.getElementById('focus-hint').hidden = !!data.focused;
                break;
            }
            case 'fileResult': {
                var result = data.result || {};
                var newHandling = result.ok ? (result.handling || state.handlingName) : '';
                if (newHandling !== state.handling) state.history = null;
                state.handling = newHandling;
                state.lock = result.ok ? (result.lock || null) : null;
                state.fileNow = result.now || 0;
                updateSaveBtn();
                if (result.ok) {
                    var oldBaseline = state.baseline;
                    var hadBaseline = Object.keys(oldBaseline).length > 0;
                    state.baseline = cleanValues(result.values);
                    var filledText = false;
                    // The panel edits the file, so fields you haven't touched show the
                    // file's value, not the car's: other scripts (damage, op-mechanic
                    // tunes, off-road grip) change some values on the car, and those
                    // must not end up in the file when you save. Where the car runs
                    // something else, the field shows "car: ...". After a re-read
                    // (a save, or someone else's), only fields that were still showing
                    // the old file value move, so "Read from car" values stay.
                    Object.keys(state.byName).forEach(function (name) {
                        var f = state.byName[name];
                        var fileValue = state.baseline[name];
                        if (state.touched[name] || fileValue === undefined || fileValue === null) return;
                        if (sameValue(f, state.values[name], fileValue)) return;
                        if (hadBaseline && !sameValue(f, state.values[name], oldBaseline[name])) return;
                        state.values[name] = clone(fileValue);
                        if (fieldEls[name]) filledText = true; // its inputs need redrawing
                    });
                    sourceLine.className = state.lock ? 'locked' : 'ok';
                    sourceLine.textContent = result.resource + '/' + result.file +
                        (state.lock ? '  ·  ' + lockText(state.lock, state.fileNow) : '');
                    sourceLine.title = state.lock ? (lockedOut()
                        ? 'Only someone with the lock permission can save this vehicle.'
                        : 'You have the lock permission, so you can still save it.') : '';
                } else {
                    state.baseline = {};
                    sourceLine.className = 'warn';
                    sourceLine.title = '';
                    sourceLine.textContent = result.message || 'Could not find a matching handling.meta.';
                }
                renderGroupNav(); // the Tools tab shows a "lock" badge
                // The pack this vehicle lives in becomes the default class-edit scope
                // and where the Copy Handling dropdown looks for other vehicles.
                var newResource = result.ok ? (result.resource || '') : '';
                if (newResource !== state.resource) {
                    state.targetModel = '';
                    state.presetTarget = '';
                    state.resourceTargets = [];
                    state.targetsResource = null;
                    state.targetsLoading = false;
                }
                state.resource = newResource;
                renderScopeSelect();
                // Don't rebuild the cards under the user's cursor just because the
                // file was re-read after a save; refresh them in place instead.
                if (state.view === 'group' && !state.changedOnly && !filledText) {
                    Object.keys(fieldEls).forEach(function (name) { fieldEls[name]._refresh(); });
                    renderCopyBar();
                } else {
                    renderContent();
                }
                scheduleIndicators();
                break;
            }
            case 'appliedBaseline': {
                var incoming = cleanValues(data.values);
                var changes = [];
                Object.keys(incoming).forEach(function (name) {
                    var field = state.byName[name];
                    if (field && !sameValue(field, state.values[name], incoming[name])) {
                        changes.push({ name: name, before: state.values[name], after: incoming[name] });
                    }
                });
                state.values = Object.assign({}, state.values, incoming);
                state.touched = {}; // reset to file/live, so nothing is "changed" any more
                record(changes);
                renderContent();
                if (state.afterApplyToast) {
                    setToast(state.afterApplyToast, 'ok'); // a restore just put the file values on the car
                    state.afterApplyToast = null;
                } else {
                    setToast(changes.length
                        ? ('Reset ' + changes.length + ' field' + (changes.length === 1 ? '' : 's') + '. Ctrl+Z to undo.')
                        : 'Nothing to reset.');
                }
                break;
            }
            case 'access': {
                // Our role changed while the panel was open.
                state.access = data.access || { perms: {} };
                state.accessData = null;
                state.locksData = null;
                state.sharedPresets = null;
                if (!can('bulk')) state.presetTarget = '';
                renderAccessBits();
                render();
                setToast('Your handling editor role is now ' + (state.access.roleLabel || 'none') + '.', 'ok');
                break;
            }
            case 'externalChange': {
                // Someone else saved / restored / (un)locked this vehicle; the
                // client is re-reading the file, which refreshes the "file:" values.
                if (data.message) setToast(data.message, 'ok');
                state.history = null;
                break;
            }
            case 'rpc': {
                var waiting = rpcWaiting[data.id];
                if (waiting) {
                    delete rpcWaiting[data.id];
                    waiting(data.result || {});
                }
                break;
            }
            case 'classScope': {
                if (data.ok) {
                    showClassSummary(data);
                } else {
                    setToast(data.message || 'Could not check the class scope.', 'err');
                }
                break;
            }
            case 'saveResult': {
                var res = data.result || {};
                state.saving = false;
                updateSaveBtn();
                classSaveBtn.disabled = false;
                if (res.ok) state.history = null; // there's a new entry to show
                setToast(res.message || (res.ok ? 'Saved.' : 'Save failed.'), res.ok ? 'ok' : 'err');
                break;
            }
            case 'vehicleList': {
                state.targetsLoading = false;
                if (data.ok) {
                    state.resourceTargets = data.models || [];
                    state.targetsResource = data.resource || '';
                } else {
                    state.resourceTargets = [];
                    state.targetsResource = state.resource;
                    setToast(data.message || 'Could not list vehicles for that resource.', 'err');
                }
                refreshTargetPickers();
                break;
            }
            case 'telemetry': {
                state.telemetry = data;
                if (state.showTelemetry && !root.hidden) renderTelemetry();
                if (data.terrain && terrainEls) updateTerrain(data.terrain);
                if (data.dyn && dynEls) updateDyn(data.dyn);
                aidStatus = data.aids || {};
                updateAidStatus();
                break;
            }
            case 'carValues': {
                // What the car is really running, once a second while the panel is open.
                state.car = cleanValues(data.values);
                Object.keys(fieldEls).forEach(function (name) {
                    if (fieldEls[name]._refreshCar) fieldEls[name]._refreshCar();
                });
                break;
            }
            case 'liveOverwritten': {
                // Another script changed one of your edits on the car; the client put it back.
                var worst = null;
                (data.fields || []).forEach(function (f) {
                    var field = state.byName[f.field];
                    if (!field) return;
                    if (f.count === 1 && !worst) worst = { field: field, stuck: false };
                    if (f.count === 6) worst = { field: field, stuck: true };
                });
                if (worst) {
                    var lbl = worst.field.label || worst.field.name;
                    if (worst.stuck) {
                        setToast(lbl + ' keeps getting changed back by another script, so you may not feel your edit. ' +
                            'An op-mechanic tuning kit on this car or another vehicle script could be doing it. Saving still writes your value.', 'err');
                    } else {
                        setToast('Another script changed ' + lbl + ' on your car. The editor put your value back.', 'ok');
                    }
                }
                break;
            }
            case 'aidsReset': {
                aids = { lowRange: false, crawl: false, hillHold: false };
                renderGroupNav();
                if (state.view === 'crawl') renderContent();
                break;
            }
        }
    });
})();
