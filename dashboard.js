let activeBuildingFilter = 'all';
let activePriorityFilter = 'all';
let searchQuery = '';

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

// Render KPIs in a single, high-performance O(N) loop
function calculateKPIs() {
    let total = 0;
    let urgent = 0;
    let stale = 0;
    let project = 0;

    for (let i = 0; i < TRIAGE_DATA.length; i++) {
        const t = TRIAGE_DATA[i];
        total++;
        const p = t.ai_triage?.priority;
        if (p === 'Critical' || p === 'High') {
            urgent++;
        }
        if (t.ai_triage?.stale_alert) {
            stale++;
        }
        if (t.status === 'Project') {
            project++;
        }
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

// Check if ticket building location matches filter
function matchesBuildingFilter(ticket, filter) {
    if (filter === 'all') return true;
    const building = (ticket.ai_triage?.location || 'District/Other').toLowerCase();
    if (filter === 'bps') return building.includes('bps') || building.includes('primary');
    if (filter === 'bis') return building.includes('bis') || building.includes('intermediate');
    if (filter === 'other') return !building.includes('bps') && !building.includes('primary') && !building.includes('bis') && !building.includes('intermediate');
    return true;
}

// Render ticket cards list efficiently using Map join and event delegation
function renderTicketList() {
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
        let buildingClass = 'building-district';
        let buildingLabel = 'District';
        const location = (ticket.ai_triage?.location || 'District/Other').toLowerCase();
        if (location.includes('bps') || location.includes('primary')) {
            buildingClass = 'building-bps';
            buildingLabel = 'BPS';
        } else if (location.includes('bis') || location.includes('intermediate')) {
            buildingClass = 'building-bis';
            buildingLabel = 'BIS';
        }

        const staleBadge = ticket.ai_triage?.stale_alert ? `<span class="stale-pill">&#9888; Stale</span>` : '';
        const priorityText = ticket.ai_triage?.priority || 'Medium';

        return `
            <div class="ticket-card ${isSelected ? 'selected' : ''}" data-id="${ticket.id}">
                <div class="ticket-card-header">
                    <span class="ticket-id-tag">#${ticket.id}</span>
                    <div class="ticket-badges">
                        ${staleBadge}
                        <span class="ticket-building ${buildingClass}">${buildingLabel}</span>
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
}

// Highlight a single ticket and load details pane in place (highly optimized O(1) DOM updates)
function selectTicket(id) {
    // Un-select previous card
    if (selectedTicketId !== null) {
        const prevCard = ticketListContainer.querySelector(`.ticket-card[data-id="${selectedTicketId}"]`);
        if (prevCard) prevCard.classList.remove('selected');
    }

    selectedTicketId = id;

    // Select new card
    const newCard = ticketListContainer.querySelector(`.ticket-card[data-id="${selectedTicketId}"]`);
    if (newCard) newCard.classList.add('selected');

    const ticket = TRIAGE_DATA.find(t => t.id === id);
    if (!ticket) return;

    emptyStateView.style.display = 'none';
    detailActiveView.style.display = 'flex';

    // Construct comments list
    let commentsHtml = '';
    if (ticket.conversation && ticket.conversation.length > 0) {
        ticket.conversation.forEach(comment => {
            const isTech = (comment.email || comment.sender || '').toLowerCase().includes(typeof TECHNICIAN_USERNAME !== 'undefined' ? TECHNICIAN_USERNAME.toLowerCase() : 'tech');
            const cleanBody = comment.body.replace(/^\u003c!--html--\u003e/i, '').trim();
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

    // Construct checklist
    let checklistHtml = '';
    if (ticket.ai_triage?.recommended_actions && ticket.ai_triage.recommended_actions.length > 0) {
        ticket.ai_triage.recommended_actions.forEach((action, index) => {
            checklistHtml += `
                <label class="checklist-item" id="chk-label-${index}">
                    <input type="checkbox" class="checklist-checkbox" onchange="toggleChecklist(this, ${index})" />
                    <span>${action}</span>
                </label>
            `;
        });
    }

    const priorityText = ticket.ai_triage?.priority || 'Medium';
    const priorityClass = priorityText.toLowerCase();

    // Populate the active view details container
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
            <!-- Left Column: Details & Thread -->
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
            
            <!-- Right Column: AI Triage Panel -->
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
                            <p>${ticket.ai_triage?.location || 'District/Other'}</p>
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
                
                <!-- Checklist -->
                <div>
                    <div class="section-title">Resolution Blueprint</div>
                    <div class="triage-card" style="padding: 16px;">
                        <div class="checklist-group">
                            ${checklistHtml || '<div style="font-size: 0.8rem; color: var(--text-muted);">No blueprint items defined.</div>'}
                        </div>
                    </div>
                </div>
                
                <!-- Suggested Draft Response -->
                <div class="draft-box-wrapper">
                    <div class="draft-header-row">
                        <div class="section-title" style="margin-bottom: 0;">Draft Response</div>
                        <button class="copy-btn" onclick="copyDraftResponse()">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:12px; height:12px;">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                            </svg>
                            Copy Draft
                        </button>
                    </div>
                    <div class="draft-box" id="suggested-draft-box">${ticket.ai_triage?.draft_response || 'No draft template suggested for this inquiry.'}</div>
                    <div class="copy-toast" id="copy-toast-notification">Copied to Clipboard!</div>
                </div>
            </div>
        </div>
    `;
}

// Toggle action items checklist visual state
function toggleChecklist(checkbox, index) {
    const label = document.getElementById(`chk-label-${index}`);
    if (checkbox.checked) {
        label.classList.add('checked');
    } else {
        label.classList.remove('checked');
    }
}

// Copy generated draft email to clipboard
function copyDraftResponse() {
    const draftText = document.getElementById('suggested-draft-box').innerText;
    navigator.clipboard.writeText(draftText).then(() => {
        const toast = document.getElementById('copy-toast-notification');
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 2000);
    });
}

// Setup filter click handlers and event listeners
function setupFilters() {
    // Location pills
    const buildingPills = document.querySelectorAll('#filter-building-group .filter-pill');
    buildingPills.forEach(pill => {
        pill.addEventListener('click', () => {
            buildingPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            activeBuildingFilter = pill.dataset.filter;
            renderTicketList();
        });
    });

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

// Initialize Cockpit App
window.addEventListener('DOMContentLoaded', () => {
    calculateKPIs();
    renderTicketList();
    setupFilters();
});
