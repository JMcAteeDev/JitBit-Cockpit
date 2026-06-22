let activeBuildingFilter = 'all';
let activePriorityFilter = 'all';
let searchQuery = '';
let selectedTicketId = null;

// DOM elements
const ticketListContainer = document.getElementById('ticket-list-container');
const emptyStateView = document.getElementById('empty-state-view');
const detailActiveView = document.getElementById('detail-active-view');
const searchInput = document.getElementById('search-input');

// Debounce utility helper
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// --- Location helpers ---

function getLocationOverrides() {
    try {
        return JSON.parse(localStorage.getItem('jitbit_cockpit_location_overrides') || '{}');
    } catch { return {}; }
}

// Returns the effective location string for a ticket (manual override takes priority over AI)
function getEffectiveLocation(ticket) {
    const overrides = getLocationOverrides();
    const overrideKey = overrides[ticket.id];
    if (overrideKey) {
        const locs = typeof LOCATIONS !== 'undefined' ? LOCATIONS : [];
        const loc = locs.find(l => l.key === overrideKey);
        if (loc) return `${loc.key} (${loc.label})`;
    }
    return ticket.ai_triage?.location || 'District/Other';
}

// Matches a location string against LOCATIONS config, returns { key, colorIndex }
function resolveLocationInfo(locationStr) {
    const locs = typeof LOCATIONS !== 'undefined' ? LOCATIONS : [];
    const lower = (locationStr || '').toLowerCase();
    for (let i = 0; i < locs.length; i++) {
        if (lower.includes(locs[i].key.toLowerCase())) {
            return { key: locs[i].key, colorIndex: i };
        }
    }
    return { key: 'Other', colorIndex: -1 };
}

// Save a manual location override for a ticket, then re-render
function setTicketLocation(ticketId, locationKey) {
    const overrides = getLocationOverrides();
    if (locationKey === '') {
        delete overrides[ticketId];
    } else {
        overrides[ticketId] = locationKey;
    }
    localStorage.setItem('jitbit_cockpit_location_overrides', JSON.stringify(overrides));
    renderTicketList();
    selectTicket(ticketId);
}

// --- Per-ticket checklist & draft persistence ---

function getTicketWorkState() {
    try {
        return JSON.parse(localStorage.getItem('jitbit_cockpit_ticket_state') || '{}');
    } catch { return {}; }
}

function saveTicketWorkState(state) {
    localStorage.setItem('jitbit_cockpit_ticket_state', JSON.stringify(state));
}

// Toggle a checklist item's checked state for a ticket and persist it
function setChecklistChecked(ticketId, index, checked) {
    const state = getTicketWorkState();
    const entry = state[ticketId] || {};
    const checklist = entry.checklist || {};
    checklist[index] = checked;
    entry.checklist = checklist;
    state[ticketId] = entry;
    saveTicketWorkState(state);
}

// Persist edited draft response text for a ticket (debounced on input)
function setDraftText(ticketId, text) {
    const state = getTicketWorkState();
    const entry = state[ticketId] || {};
    entry.draft = text;
    state[ticketId] = entry;
    saveTicketWorkState(state);
}

// Clear a ticket's saved draft edit, reverting the box to the AI-generated draft
function resetDraftText(ticketId) {
    const state = getTicketWorkState();
    if (state[ticketId]) {
        delete state[ticketId].draft;
    }
    saveTicketWorkState(state);
    selectTicket(ticketId);
}

// --- KPIs ---

// Render KPIs in a single, high-performance O(N) loop
function calculateKPIs() {
    let total = 0, urgent = 0, stale = 0, project = 0;

    for (let i = 0; i < TRIAGE_DATA.length; i++) {
        const t = TRIAGE_DATA[i];
        total++;
        const p = t.ai_triage?.priority;
        if (p === 'Critical' || p === 'High') urgent++;
        if (t.ai_triage?.stale_alert) stale++;
        if (t.status === 'Project') project++;
    }

    document.getElementById('kpi-total-backlog').innerText = total;
    document.getElementById('kpi-urgent-count').innerText = urgent;
    document.getElementById('kpi-stale-count').innerText = stale;
    document.getElementById('kpi-project-count').innerText = project;
}

// Helper to format ISO date to readable string
function formatDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// Check if ticket building location matches the active filter
function matchesBuildingFilter(ticket, filter) {
    if (filter === 'all') return true;
    const effectiveLocation = getEffectiveLocation(ticket);
    if (filter === 'other') return resolveLocationInfo(effectiveLocation).colorIndex === -1;
    return effectiveLocation.toLowerCase().includes(filter.toLowerCase());
}

// Render ticket cards list efficiently using map/join and event delegation
function renderTicketList() {
    try {
        const query = searchQuery.toLowerCase().trim();

        const filtered = TRIAGE_DATA.filter(ticket => {
            const matchesSearch = query === '' ||
                ticket.id.toString().includes(query) ||
                ticket.subject.toLowerCase().includes(query) ||
                ticket.description.toLowerCase().includes(query) ||
                ticket.from.toLowerCase().includes(query) ||
                ticket.fromEmail.toLowerCase().includes(query);

            const matchesBuilding = matchesBuildingFilter(ticket, activeBuildingFilter);
            const matchesPriority = activePriorityFilter === 'all' || (ticket.ai_triage?.priority || 'Medium') === activePriorityFilter;

            return matchesSearch && matchesBuilding && matchesPriority;
        });

        if (filtered.length === 0) {
            ticketListContainer.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                    No tickets match the selected filters or search query.
                </div>
            `;
            return;
        }

        const html = filtered.map(ticket => {
            const isSelected = selectedTicketId === ticket.id;
            const effectiveLocation = getEffectiveLocation(ticket);
            const { key: locKey, colorIndex } = resolveLocationInfo(effectiveLocation);
            const buildingClass = colorIndex >= 0 ? `building-color-${colorIndex % 6}` : 'building-other';

            const staleBadge = ticket.ai_triage?.stale_alert ? `<span class="stale-pill">&#9888; Stale</span>` : '';
            const priorityText = ticket.ai_triage?.priority || 'Medium';

            return `
                <div class="ticket-card ${isSelected ? 'selected' : ''}" data-id="${ticket.id}">
                    <div class="ticket-card-header">
                        <span class="ticket-id-tag">#${ticket.id}</span>
                        <div class="ticket-badges">
                            ${staleBadge}
                            <span class="ticket-building ${buildingClass}">${locKey}</span>
                        </div>
                    </div>
                    <div class="ticket-subject">${ticket.subject}</div>
                    <div class="ticket-meta">
                        <span class="ticket-submitter">${ticket.from}</span>
                        <span class="priority-badge badge-${priorityText.toLowerCase()}">${priorityText}</span>
                    </div>
                </div>
            `;
        }).join('');

        ticketListContainer.innerHTML = html;
    } catch (e) {
        console.error('Error rendering tickets:', e);
        ticketListContainer.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--color-critical); font-size: 0.85rem;">
            An error occurred while rendering tickets. Please try again later.
        </div>`;
    }
}

// Highlight a single ticket and load details pane in place
function selectTicket(id) {
    if (selectedTicketId !== null) {
        const prevCard = ticketListContainer.querySelector(`.ticket-card[data-id="${selectedTicketId}"]`);
        if (prevCard) prevCard.classList.remove('selected');
    }

    selectedTicketId = id;

    const newCard = ticketListContainer.querySelector(`.ticket-card[data-id="${selectedTicketId}"]`);
    if (newCard) newCard.classList.add('selected');

    const ticket = TRIAGE_DATA.find(t => t.id === id);
    if (!ticket) return;

    emptyStateView.style.display = 'none';
    detailActiveView.style.display = 'flex';

    // Build comments HTML
    let commentsHtml = '';
    if (ticket.conversation && ticket.conversation.length > 0) {
        ticket.conversation.forEach(comment => {
            const isTech = (comment.email || comment.sender || '').toLowerCase().includes(typeof TECHNICIAN_USERNAME !== 'undefined' ? TECHNICIAN_USERNAME.toLowerCase() : 'tech');
            const cleanBody = comment.body.replace(/^<!--html-->/i, '').trim();
            commentsHtml += `
                <div class="comment-node ${isTech ? 'tech-sender' : ''}">
                    <div class="comment-header">
                        <span class="comment-sender">${comment.sender}</span>
                        <span class="comment-date">${formatDate(comment.date)}</span>
                    </div>
                    <div class="comment-body">${cleanBody}</div>
                </div>
            `;
        });
    } else {
        commentsHtml = `<div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 12px 0;">No comments in thread.</div>`;
    }

    // Build checklist HTML, restoring any previously saved checked state
    const workState = getTicketWorkState()[ticket.id] || {};
    const savedChecklist = workState.checklist || {};
    let checklistHtml = '';
    if (ticket.ai_triage?.recommended_actions && ticket.ai_triage.recommended_actions.length > 0) {
        ticket.ai_triage.recommended_actions.forEach((action, index) => {
            const isChecked = !!savedChecklist[index];
            checklistHtml += `
                <label class="checklist-item ${isChecked ? 'checked' : ''}" id="chk-label-${index}">
                    <input type="checkbox" class="checklist-checkbox" ${isChecked ? 'checked' : ''} onchange="toggleChecklist(this, ${ticket.id}, ${index})" />
                    <span>${action}</span>
                </label>
            `;
        });
    }

    // Build location override dropdown
    const locs = typeof LOCATIONS !== 'undefined' ? LOCATIONS : [];
    const overrides = getLocationOverrides();
    const currentOverride = overrides[ticket.id] || '';
    const locOptions = locs.map(loc =>
        `<option value="${loc.key}" ${currentOverride === loc.key ? 'selected' : ''}>${loc.key} — ${loc.label}</option>`
    ).join('');

    const priorityText = ticket.ai_triage?.priority || 'Medium';
    const priorityClass = priorityText.toLowerCase();

    detailActiveView.innerHTML = `
        <div class="detail-header">
            <div class="detail-header-top">
                <div class="detail-title-section">
                    <div class="detail-title-row">
                        <span class="detail-id">Ticket #${ticket.id}</span>
                        <span class="priority-badge badge-${priorityClass}">${priorityText} Priority</span>
                        <span style="font-size:0.75rem; font-weight:600; padding:2px 8px; border-radius:99px; background:rgba(255,255,255,0.04); color:var(--text-secondary); border:1px solid var(--border-color);">${ticket.status}</span>
                    </div>
                    <h2 class="detail-subject">${ticket.subject}</h2>
                </div>
                <a href="${typeof JITBIT_TENANT_URL !== 'undefined' ? JITBIT_TENANT_URL : 'https://yourdomain.jitbit.com/helpdesk'}/Ticket/${ticket.id}" target="_blank" class="open-jitbit-btn">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:14px; height:14px;">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Open in JitBit
                </a>
            </div>
            <div class="detail-metadata-strip">
                <div class="detail-meta-item">
                    <span>From:</span> <strong>${ticket.from}</strong> (${ticket.fromEmail})
                </div>
                <div class="detail-meta-item">
                    <span>Created:</span> <strong>${formatDate(ticket.created)}</strong>
                </div>
                <div class="detail-meta-item">
                    <span>Category:</span> <strong>${ticket.category}</strong>
                </div>
            </div>
        </div>

        <div class="detail-content-split">
            <div class="detail-left">
                <div>
                    <div class="section-title">Description</div>
                    <div class="description-box">${ticket.description}</div>
                </div>

                <div>
                    <div class="section-title">Conversation Thread</div>
                    <div class="comments-timeline">
                        ${commentsHtml}
                    </div>
                </div>
            </div>

            <div class="detail-right">
                <div class="triage-card card-${priorityClass}">
                    <div class="triage-badge-row">
                        <span class="triage-badge-label">AI Triage Analysis</span>
                        <span class="priority-badge badge-${priorityClass}">${priorityText} Priority</span>
                    </div>

                    <div class="justification-text">
                        <strong>Justification:</strong> ${ticket.ai_triage?.justification || 'No justification provided.'}
                    </div>

                    <div class="meta-pill-grid">
                        <div class="meta-detail-pill">
                            <div>Location</div>
                            <select class="location-override-select" onchange="setTicketLocation(${ticket.id}, this.value)">
                                <option value="" ${!currentOverride ? 'selected' : ''}>Auto: ${ticket.ai_triage?.location || 'District/Other'}</option>
                                ${locOptions}
                            </select>
                        </div>
                        <div class="meta-detail-pill">
                            <div>Classroom</div>
                            <p>${ticket.ai_triage?.classroom || 'N/A'}</p>
                        </div>
                        <div class="meta-detail-pill">
                            <div>Ticket Age</div>
                            <p>${ticket.ai_triage?.stale_days || 0} Days Open</p>
                        </div>
                        <div class="meta-detail-pill">
                            <div>SLA Alert</div>
                            <p style="color: ${ticket.ai_triage?.stale_alert ? 'var(--color-critical)' : '#10b981'};">
                                ${ticket.ai_triage?.stale_alert ? '&#9888; Highly Stale' : '&#10003; Normal'}
                            </p>
                        </div>
                    </div>
                </div>

                <div>
                    <div class="section-title">Resolution Blueprint</div>
                    <div class="triage-card" style="padding: 16px;">
                        <div class="checklist-group">
                            ${checklistHtml || '<div style="font-size: 0.8rem; color: var(--text-muted);">No blueprint items defined.</div>'}
                        </div>
                    </div>
                </div>

                <div class="draft-box-wrapper">
                    <div class="draft-header-row">
                        <div class="section-title" style="margin-bottom: 0;">Draft Response ${workState.draft !== undefined ? '<span class="draft-edited-tag">Edited</span>' : ''}</div>
                        <div style="display:flex; gap:6px;">
                            ${workState.draft !== undefined ? `<button class="copy-btn draft-reset-btn" onclick="resetDraftText(${ticket.id})">Reset to AI Draft</button>` : ''}
                            <button class="copy-btn" onclick="copyDraftResponse()">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:12px; height:12px;">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                                </svg>
                                Copy Draft
                            </button>
                        </div>
                    </div>
                    <div class="draft-box" id="suggested-draft-box" contenteditable="true" oninput="onDraftInput(${ticket.id}, this)">${workState.draft !== undefined ? workState.draft : (ticket.ai_triage?.draft_response || 'No draft template suggested for this inquiry.')}</div>
                    <div class="copy-toast" id="copy-toast-notification">Copied to Clipboard!</div>
                </div>
            </div>
        </div>
    `;
}

// Toggle action items checklist visual state and persist it
function toggleChecklist(checkbox, ticketId, index) {
    const label = document.getElementById(`chk-label-${index}`);
    if (checkbox.checked) {
        label.classList.add('checked');
    } else {
        label.classList.remove('checked');
    }
    setChecklistChecked(ticketId, index, checkbox.checked);
}

// Debounced save of draft edits as the technician types
const debouncedSaveDraftText = debounce((ticketId, text) => setDraftText(ticketId, text), 400);
function onDraftInput(ticketId, el) {
    debouncedSaveDraftText(ticketId, el.innerText);
}

// Copy generated draft email to clipboard
function copyDraftResponse() {
    const draftText = document.getElementById('suggested-draft-box').innerText;
    navigator.clipboard.writeText(draftText).then(() => {
        const toast = document.getElementById('copy-toast-notification');
        toast.classList.add('show');
        setTimeout(() => { toast.classList.remove('show'); }, 2000);
    });
}

// Build location filter pills dynamically from the LOCATIONS config constant
function buildLocationPills() {
    const group = document.getElementById('filter-building-group');
    const locs = typeof LOCATIONS !== 'undefined' ? LOCATIONS : [];

    const dynamicPills = locs.map(loc =>
        `<span class="filter-pill" data-filter="${loc.key.toLowerCase()}">${loc.key}</span>`
    ).join('');

    group.innerHTML = `
        <span class="filter-pill active" data-filter="all">All Locations</span>
        ${dynamicPills}
        <span class="filter-pill" data-filter="other">Other</span>
    `;

    group.querySelectorAll('.filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            group.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            activeBuildingFilter = pill.dataset.filter;
            renderTicketList();
        });
    });
}

// Setup filter click handlers and event listeners
function setupFilters() {
    buildLocationPills();

    // Priority pills
    const priorityPills = document.querySelectorAll('#filter-priority-group .filter-pill');
    priorityPills.forEach(pill => {
        pill.addEventListener('click', () => {
            priorityPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            activePriorityFilter = pill.dataset.filter;
            renderTicketList();
        });
    });

    // Search typing with true 250ms debounce to eliminate typing stutter
    searchInput.addEventListener('input', debounce((e) => {
        searchQuery = e.target.value;
        renderTicketList();
    }, 250));

    // Event delegation for ticket selection (O(1) memory profile)
    ticketListContainer.addEventListener('click', (e) => {
        const card = e.target.closest('.ticket-card');
        if (card) {
            const ticketId = parseInt(card.dataset.id, 10);
            selectTicket(ticketId);
        }
    });
}

function updateSyncStatus() {
    const badge = document.getElementById('status-badge');
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');

    if (typeof LAST_SYNC === 'undefined') {
        badge.className = 'status-badge status-unknown';
        dot.className = 'status-dot';
        text.textContent = 'No sync data';
        return;
    }

    const ageMs = Date.now() - new Date(LAST_SYNC).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    const ageHours = ageMin / 60;

    let label;
    if (ageMin < 60) {
        label = `Synced ${ageMin} min ago`;
    } else {
        const h = Math.floor(ageHours);
        label = `Synced ${h} h ago`;
    }

    if (ageHours < 2) {
        badge.className = 'status-badge';
        dot.className = 'status-dot';
    } else if (ageHours < 4) {
        badge.className = 'status-badge status-warn';
        dot.className = 'status-dot';
        label += ' — check sync';
    } else {
        badge.className = 'status-badge status-stale';
        dot.className = 'status-dot';
        label += ' — data stale';
    }

    text.textContent = label;
}

// Open a ticket referenced by a #ticket-<id> URL hash (deep link from My Day)
function openTicketFromHash() {
    const match = /^#ticket-(\d+)$/.exec(window.location.hash);
    if (!match) return;
    const id = parseInt(match[1], 10);
    if (!TRIAGE_DATA.some(t => t.id === id)) return;
    selectTicket(id);
    const card = ticketListContainer.querySelector(`.ticket-card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ block: 'center' });
}

// Initialize Cockpit App
window.addEventListener('DOMContentLoaded', () => {
    calculateKPIs();
    renderTicketList();
    setupFilters();
    updateSyncStatus();
    openTicketFromHash();
});

// Respond to hash changes while the dashboard is already open
window.addEventListener('hashchange', openTicketFromHash);
