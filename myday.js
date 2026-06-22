// ===========================================================================
// My Day -- Focus Planner
// Builds a daily work plan from the shared TRIAGE_DATA. The goal is to mix
// priority bands so aging or low-priority tickets surface instead of being
// buried under a wall of Critical/High tickets. Pure client-side, no API.
// ===========================================================================

const PRIORITY_BASE = { Critical: 100, High: 70, Medium: 45, Low: 25 };
const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low'];

// --- Small helpers -----------------------------------------------------------

function getPriority(ticket) {
    return ticket.ai_triage?.priority || 'Medium';
}

// Find the most recent conversation entry (the thread is not guaranteed sorted)
function latestComment(ticket) {
    const conv = ticket.conversation || [];
    if (conv.length === 0) return null;
    return conv.reduce((latest, c) => {
        if (!latest) return c;
        return new Date(c.date) > new Date(latest.date) ? c : latest;
    }, null);
}

// True when the customer is the last one to speak (the ball is in your court),
// or when a brand-new ticket has not been answered yet.
function customerWaiting(ticket) {
    const techName = typeof TECHNICIAN_USERNAME !== 'undefined' ? TECHNICIAN_USERNAME.toLowerCase() : '';
    const last = latestComment(ticket);
    if (!last) return ticket.status === 'New';
    const who = (last.email || last.sender || '').toLowerCase();
    return techName ? !who.includes(techName) : false;
}

// Strip the inline html marker and tags to estimate raw text length cheaply
function plainTextLength(html) {
    if (!html) return 0;
    return html.replace(/^<!--html-->/i, '').replace(/<[^>]+>/g, ' ').trim().length;
}

// --- Effort heuristic --------------------------------------------------------
// No AI / no API. Estimate effort from thread length, number of recommended
// actions, and description size. Returns { minutes, tier } where tier is one
// of 'quick' | 'medium' | 'heavy'.
function estimateEffort(ticket) {
    const actions = ticket.ai_triage?.recommended_actions?.length || 0;
    const threadLen = (ticket.conversation || []).length;
    const descLen = plainTextLength(ticket.description);

    let minutes = 5;                 // baseline acknowledge/read
    minutes += actions * 6;          // each blueprint step is real work
    minutes += threadLen * 2;        // long back-and-forth means more context
    if (descLen > 600) minutes += 10; // wall-of-text descriptions take longer
    else if (descLen > 250) minutes += 5;

    // Aging tickets often need a fresh dig-in, so nudge effort up a touch
    if (ticket.ai_triage?.stale_alert) minutes += 5;

    let tier;
    if (minutes <= 12) tier = 'quick';
    else if (minutes <= 30) tier = 'medium';
    else tier = 'heavy';

    return { minutes, tier };
}

// --- Focus score -------------------------------------------------------------
// Weighted blend so no single dimension dominates. Aging grows with age so an
// old Low ticket eventually outranks a fresh Medium one.
function focusScore(ticket) {
    const priority = getPriority(ticket);
    const base = PRIORITY_BASE[priority] ?? 45;

    const staleDays = ticket.ai_triage?.stale_days || 0;
    const aging = Math.min(staleDays, 30) * 1.5;
    const staleBoost = ticket.ai_triage?.stale_alert ? 25 : 0;
    const ballBoost = customerWaiting(ticket) ? 20 : 0;
    const statusBoost = ticket.status === 'New' ? 10 : 0;

    return base + aging + staleBoost + ballBoost + statusBoost;
}

// Attach derived fields once so the rest of the page is cheap to render
function enrich(tickets) {
    return tickets.map(t => ({
        ticket: t,
        priority: getPriority(t),
        score: focusScore(t),
        waiting: customerWaiting(t),
        effort: estimateEffort(t),
        staleDays: t.ai_triage?.stale_days || 0,
        staleAlert: !!t.ai_triage?.stale_alert,
        location: effectiveLocation(t)
    }));
}

// Self-contained location resolution (this page does not load dashboard.js).
// Honors the same manual override key the dashboard writes to localStorage.
function effectiveLocation(ticket) {
    let overrides = {};
    try { overrides = JSON.parse(localStorage.getItem('jitbit_cockpit_location_overrides') || '{}'); } catch { overrides = {}; }
    const locs = typeof LOCATIONS !== 'undefined' ? LOCATIONS : [];
    const overrideKey = overrides[ticket.id];
    if (overrideKey) {
        const loc = locs.find(l => l.key === overrideKey);
        if (loc) return `${loc.key} (${loc.label})`;
    }
    return ticket.ai_triage?.location || 'District/Other';
}

// --- Bucket builder ----------------------------------------------------------
// Themed buckets are mutually exclusive (assigned in priority order) so the
// same card never shows up four times. The Focus Queue below is the master
// interleaved list and intentionally includes everything.
function buildBuckets(rows) {
    const assigned = new Set();
    const take = (candidates, limit) => {
        const out = [];
        for (const r of candidates) {
            if (out.length >= limit) break;
            if (assigned.has(r.ticket.id)) continue;
            assigned.add(r.ticket.id);
            out.push(r);
        }
        return out;
    };

    const byScore = [...rows].sort((a, b) => b.score - a.score);

    // 1. Do First -- the genuine urgents (top of the blended score)
    const doFirst = take(byScore, 4);

    // 2. Don't Let These Rot -- aging tickets regardless of priority.
    //    This is the core "harder to miss" guarantee.
    const agers = rows
        .filter(r => r.staleAlert || r.staleDays >= 7)
        .sort((a, b) => b.staleDays - a.staleDays);
    const dontRot = take(agers, 5);

    // 3. Awaiting Your Reply -- ball is in your court
    const waiting = byScore.filter(r => r.waiting);
    const awaiting = take(waiting, 6);

    // 4. Quick Wins -- low effort, clear them for momentum
    const quick = byScore.filter(r => r.effort.tier === 'quick');
    const quickWins = take(quick, 5);

    return { doFirst, dontRot, awaiting, quickWins };
}

// Round-robin across priority bands so every band gets daily airtime instead
// of letting Critical/High tunnel-vision bury Medium and Low.
function buildFocusQueue(rows) {
    const bands = {};
    PRIORITY_ORDER.forEach(p => { bands[p] = []; });
    rows.forEach(r => { (bands[r.priority] || bands.Medium).push(r); });
    PRIORITY_ORDER.forEach(p => bands[p].sort((a, b) => b.score - a.score));

    const queue = [];
    let added = true;
    while (added) {
        added = false;
        for (const p of PRIORITY_ORDER) {
            if (bands[p].length) {
                queue.push(bands[p].shift());
                added = true;
            }
        }
    }
    return queue;
}

// --- Rendering ---------------------------------------------------------------

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function locationKey(locationStr) {
    const locs = typeof LOCATIONS !== 'undefined' ? LOCATIONS : [];
    const lower = (locationStr || '').toLowerCase();
    for (let i = 0; i < locs.length; i++) {
        if (lower.includes(locs[i].key.toLowerCase())) {
            return { key: locs[i].key, colorClass: `building-color-${i % 6}` };
        }
    }
    return { key: 'Other', colorClass: 'building-other' };
}

const EFFORT_LABEL = { quick: 'Quick win', medium: 'Moderate', heavy: 'Deep work' };

function renderCard(row) {
    const t = row.ticket;
    const prio = row.priority;
    const { key: locKey, colorClass } = locationKey(row.location);
    const tenant = typeof JITBIT_TENANT_URL !== 'undefined' ? JITBIT_TENANT_URL : 'https://yourdomain.jitbit.com/helpdesk';

    const waitingPill = row.waiting ? `<span class="md-flag md-flag-waiting">&#8617; Awaiting you</span>` : '';
    const stalePill = row.staleAlert ? `<span class="md-flag md-flag-stale">&#9888; Stale ${row.staleDays}d</span>` : '';
    const agePill = (!row.staleAlert && row.staleDays > 0) ? `<span class="md-flag md-flag-age">${row.staleDays}d open</span>` : '';

    return `
        <div class="md-card">
            <div class="md-card-top">
                <span class="md-id">#${t.id}</span>
                <div class="md-card-flags">
                    ${waitingPill}${stalePill}${agePill}
                    <span class="md-building ${colorClass}">${escapeHtml(locKey)}</span>
                    <span class="priority-badge badge-${prio.toLowerCase()}">${prio}</span>
                </div>
            </div>
            <div class="md-subject">${escapeHtml(t.subject)}</div>
            <div class="md-card-meta">
                <span class="md-from">${escapeHtml(t.from)}</span>
                <span class="md-effort md-effort-${row.effort.tier}">${EFFORT_LABEL[row.effort.tier]} &middot; ~${row.effort.minutes}m</span>
            </div>
            <div class="md-card-actions">
                <a class="md-action md-action-detail" href="dashboard.html#ticket-${t.id}">View detail</a>
                <a class="md-action md-action-jitbit" href="${tenant}/Ticket/${t.id}" target="_blank" rel="noopener">Open in JitBit
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:12px;height:12px;">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                </a>
            </div>
        </div>
    `;
}

function renderBucket(meta, rows) {
    if (!rows.length) return '';
    const cards = rows.map(renderCard).join('');
    return `
        <section class="md-bucket md-bucket-${meta.id}">
            <div class="md-bucket-head">
                <div class="md-bucket-title">
                    <span class="md-bucket-icon">${meta.icon}</span>
                    <h2>${meta.title}</h2>
                    <span class="md-bucket-count">${rows.length}</span>
                </div>
                <p class="md-bucket-sub">${meta.sub}</p>
            </div>
            <div class="md-bucket-cards">${cards}</div>
        </section>
    `;
}

function renderTopStrip(rows) {
    const total = rows.length;
    const waiting = rows.filter(r => r.waiting).length;
    const aging = rows.filter(r => r.staleAlert || r.staleDays >= 7).length;
    const urgent = rows.filter(r => r.priority === 'Critical' || r.priority === 'High').length;
    const totalMinutes = rows.reduce((sum, r) => sum + r.effort.minutes, 0);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const loadLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    return `
        <div class="md-stat md-stat-total">
            <span class="md-stat-value">${total}</span>
            <span class="md-stat-label">On your plate</span>
        </div>
        <div class="md-stat md-stat-urgent">
            <span class="md-stat-value">${urgent}</span>
            <span class="md-stat-label">Urgent (Crit + High)</span>
        </div>
        <div class="md-stat md-stat-waiting">
            <span class="md-stat-value">${waiting}</span>
            <span class="md-stat-label">Awaiting your reply</span>
        </div>
        <div class="md-stat md-stat-aging">
            <span class="md-stat-value">${aging}</span>
            <span class="md-stat-label">Aging / stale</span>
        </div>
        <div class="md-stat md-stat-load">
            <span class="md-stat-value">${loadLabel}</span>
            <span class="md-stat-label">Est. focused load</span>
        </div>
    `;
}

function renderEmpty() {
    return `
        <div class="md-empty">
            <h3>Inbox zero, more or less.</h3>
            <p>No assigned tickets to plan right now. Check the
            <a href="dashboard.html">triage dashboard</a> or run a sync.</p>
        </div>
    `;
}

const BUCKET_META = {
    doFirst: { id: 'dofirst', icon: '&#9889;', title: 'Do First', sub: 'Highest blended urgency right now.' },
    dontRot: { id: 'dontrot', icon: '&#9203;', title: "Don't Let These Rot", sub: 'Aging tickets, any priority, before they become a problem.' },
    awaiting: { id: 'awaiting', icon: '&#8617;', title: 'Awaiting Your Reply', sub: 'The ball is in your court on these.' },
    quickWins: { id: 'quickwins', icon: '&#10003;', title: 'Quick Wins', sub: 'Low-effort clears for momentum.' }
};

function render() {
    const stripEl = document.getElementById('md-strip');
    const bucketsEl = document.getElementById('md-buckets');
    const queueEl = document.getElementById('md-queue-cards');
    const queueWrapEl = document.getElementById('md-queue');

    const data = (typeof TRIAGE_DATA !== 'undefined' && Array.isArray(TRIAGE_DATA)) ? TRIAGE_DATA : [];
    // The planner is about active work, so skip deferred Project items.
    const active = data.filter(t => t.status !== 'Project');
    const rows = enrich(active);

    if (rows.length === 0) {
        stripEl.innerHTML = '';
        bucketsEl.innerHTML = renderEmpty();
        queueWrapEl.style.display = 'none';
        return;
    }

    stripEl.innerHTML = renderTopStrip(rows);

    const { doFirst, dontRot, awaiting, quickWins } = buildBuckets(rows);
    bucketsEl.innerHTML = [
        renderBucket(BUCKET_META.doFirst, doFirst),
        renderBucket(BUCKET_META.dontRot, dontRot),
        renderBucket(BUCKET_META.awaiting, awaiting),
        renderBucket(BUCKET_META.quickWins, quickWins)
    ].join('');

    const queue = buildFocusQueue(rows);
    queueEl.innerHTML = queue.map(renderCard).join('');
}

// Mirror the dashboard's sync status badge so freshness is visible here too
function updateSyncStatus() {
    const badge = document.getElementById('status-badge');
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!badge) return;

    if (typeof LAST_SYNC === 'undefined') {
        badge.className = 'status-badge status-unknown';
        text.textContent = 'No sync data';
        return;
    }

    const ageMin = Math.floor((Date.now() - new Date(LAST_SYNC).getTime()) / 60000);
    const ageHours = ageMin / 60;
    let label = ageMin < 60 ? `Synced ${ageMin} min ago` : `Synced ${Math.floor(ageHours)} h ago`;

    if (ageHours < 2) {
        badge.className = 'status-badge';
    } else if (ageHours < 4) {
        badge.className = 'status-badge status-warn';
        label += ' — check sync';
    } else {
        badge.className = 'status-badge status-stale';
        label += ' — data stale';
    }
    text.textContent = label;
}

window.addEventListener('DOMContentLoaded', () => {
    render();
    updateSyncStatus();
});
