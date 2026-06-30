// ════════════════════════════════════════════════════════════════════════════
// TASKFLOW — Frontend desacoplado con router History API
// URLs: /api/login  /api/home  /api/board/<id>
// ════════════════════════════════════════════════════════════════════════════

const API = '/api';
let token = sessionStorage.getItem('tf_token') || '';
let currentUser = sessionStorage.getItem('tf_user') || '';
let userLevel = 1;
let currentBoardId = null;
let allBoards = [];
let ws = null;
let draggedCardId = null;
let draggedListId = null;
let pendingDelete = null;
let boardWs = null;
let currentBoardData = null;
let allUsersCache = [];

const BOARD_COLORS = ['bc-0', 'bc-1', 'bc-2', 'bc-3', 'bc-4', 'bc-5'];

// ── HELPERS ──────────────────────────────────────────────────────────────────

function h() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function refreshAccessToken() {
  const refreshToken = sessionStorage.getItem('tf_refresh');
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API}/token/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: refreshToken })
    });
    if (!res.ok) return false;
    const data = await res.json();
    token = data.access;
    sessionStorage.setItem('tf_token', token);
    if (data.refresh) {
      sessionStorage.setItem('tf_refresh', data.refresh);
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function api(method, path, body) {
  const opts = { method, headers: h() };
  if (body) opts.body = JSON.stringify(body);
  let res = await fetch(`${API}${path}`, opts);

  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) { logout(); return null; }
    opts.headers = h();
    res = await fetch(`${API}${path}`, opts);
    if (res.status === 401) { logout(); return null; }
  }

  return res;
}
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn.dataset.orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.orig || btn.innerHTML;
    btn.disabled = false;
  }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.style.opacity = '0', 3200);
  setTimeout(() => el.remove(), 3500);
}

function escapeQuotes(str) {
  return String(str).replace(/'/g, "\\'");
}

// ── ROUTER (History API) ──────────────────────────────────────────────────────
// Rutas:  /api/login        → pantalla de login
//         /api/home         → grid de tableros
//         /api/board/<id>   → detalle de un tablero

function navigate(path, pushState = true) {
  if (pushState) history.pushState({}, '', path);
  dispatch(path);
}

function dispatch(path) {
  if (!token) {
    _showLoginScreen();
    return;
  }
  if (path === '/api/login') {
    history.replaceState({}, '', '/api/home');
    dispatch('/api/home');
    return;
  }
  const boardMatch = path.match(/^\/api\/board\/(\d+)/);
  if (boardMatch) {
    const id = parseInt(boardMatch[1]);
    _openBoardById(id);
    return;
  }
  // /api/home o cualquier ruta desconocida → home
  _showHomeScreen();
}

// Botón atrás / adelante del navegador
window.addEventListener('popstate', () => dispatch(location.pathname));

// ── SCREEN HELPERS (internos) ─────────────────────────────────────────────────

function _showLoginScreen() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-section').style.display = 'none';
}

function _showAppShell() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-section').style.display = 'flex';
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

async function login() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  if (!username || !password) {
    document.getElementById('login-err').innerHTML = '⚠ Completá todos los campos';
    return;
  }
  setLoading('login-btn', true);
  const res = await fetch(`${API}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  setLoading('login-btn', false);
if (res.ok) {
    const data = await res.json();
    token = data.access;
    currentUser = username;
    sessionStorage.setItem('tf_token', token);
    sessionStorage.setItem('tf_refresh', data.refresh);
    sessionStorage.setItem('tf_user', currentUser);
    document.getElementById('login-err').innerHTML = '';
    await showApp();
  } else {
    document.getElementById('login-err').innerHTML = '✕ Usuario o contraseña incorrectos';
  }
}

function logout() {
  token = ''; currentUser = ''; userLevel = 1;
  currentBoardId = null; allBoards = [];
  sessionStorage.clear();
  if (ws) { ws.close(); ws = null; }
  disconnectBoardWS();
  document.getElementById('admin-badge').style.display = 'none';
  document.getElementById('sidebar-admin-section').style.display = 'none';
  document.querySelectorAll('.sidebar-admin-form').forEach(f => f.classList.add('hidden'));
  document.querySelectorAll('.sidebar-admin-arrow').forEach(a => a.classList.remove('open'));
  navigate('/api/login');
}

// ── APP INIT ──────────────────────────────────────────────────────────────────

async function showApp() {
  _showAppShell();
  document.getElementById('username-display').textContent = currentUser;
  document.getElementById('user-avatar').textContent = currentUser[0].toUpperCase();

 const res = await api('GET', '/users/me/');
  if (res && res.ok) {
    const me = await res.json();
    userLevel = me.level;
    if (userLevel === 0) {
      document.getElementById('admin-badge').style.display = 'inline-flex';
      document.getElementById('sidebar-admin-section').style.display = 'block';
      await loadUsersForAdmin();
    }
  }
  connectWS();
  loadNotifications();
  // Navegar a la ruta actual o a /api/home si venimos del login
  const path = location.pathname;
  if (path === '/api/login' || path === '/') {
    navigate('/api/home');
  } else {
    dispatch(path);
  }
}

// ── BOARDS DATA + SIDEBAR ─────────────────────────────────────────────────────

async function loadBoards() {
  const res = await api('GET', '/boards/');
  if (!res || !res.ok) return;
  allBoards = await res.json();
  renderSidebar();
  if (currentBoardId === null) renderBoardsGrid();
}

function onSidebarSearchInput(event) {
  const query = event.target.value;
  const container = document.getElementById('sidebar-search-results');

  if (!query.trim()) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const results = searchCards(query);
  renderSearchResults(results, query);
}

function searchCards(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results = [];
  for (const board of allBoards) {
    for (const list of board.lists || []) {
      for (const card of list.cards || []) {
        if (card.title.toLowerCase().includes(q)) {
          results.push({ card, list, board });
        }
      }
    }
  }
  return results.slice(0, 8);
}

async function goToSearchResult(boardId, cardId) {
  document.getElementById('sidebar-search-results').classList.add('hidden');
  document.getElementById('sidebar-search-input').value = '';

  const board = allBoards.find(b => b.id === boardId);
  navigate(`/api/board/${boardId}`);

  if (board) {
    setTimeout(() => openCardDetail(cardId), 300);
  }
}

function renderSearchResults(results, query) {
  const container = document.getElementById('sidebar-search-results');

  if (results.length === 0) {
    container.innerHTML = `<div class="search-no-results">Sin resultados para "${escapeQuotes(query)}"</div>`;
    container.classList.remove('hidden');
    return;
  }

  container.innerHTML = results.map(r => `
    <div class="search-result-item" onclick="goToSearchResult(${r.board.id}, ${r.card.id})">
      <div class="search-result-title">${r.card.title}</div>
      <div class="search-result-meta">${r.board.title} · ${r.list.title}</div>
    </div>
  `).join('');
  container.classList.remove('hidden');
}

function renderSidebar() {
  const list = document.getElementById('sidebar-boards');
  const home = document.getElementById('sidebar-home');

  home.classList.toggle('active', currentBoardId === null);

  list.innerHTML = allBoards.map((b, i) => `
    <div class="sidebar-item ${b.id === currentBoardId ? 'active' : ''}"
         onclick="openBoard(${b.id}, '${escapeQuotes(b.title)}')">
      <span class="sidebar-dot ${BOARD_COLORS[i % 6]}"></span>
      <span class="sidebar-item-label">${b.title}</span>
    </div>
  `).join('');
}

// ── SIDEBAR — NUEVO TABLERO ───────────────────────────────────────────────────

function showSidebarNewBoardForm() {
  document.getElementById('sidebar-new-board-trigger').classList.add('hidden');
  document.getElementById('sidebar-new-board-form').classList.remove('hidden');
  setTimeout(() => document.getElementById('sidebar-new-board-input').focus(), 50);
}

function hideSidebarNewBoardForm() {
  document.getElementById('sidebar-new-board-trigger').classList.remove('hidden');
  document.getElementById('sidebar-new-board-form').classList.add('hidden');
  document.getElementById('sidebar-new-board-input').value = '';
}

async function createBoard() {
  const input = document.getElementById('sidebar-new-board-input');
  const title = input.value.trim();
  if (!title) return;
  const res = await api('POST', '/boards/', { title });
  if (res && res.ok) {
    toast('Tablero creado con 5 listas predeterminadas', 'success');
    hideSidebarNewBoardForm();
    await loadBoards();
  } else {
    toast('Error al crear el tablero', 'error');
  }
}

async function deleteBoard(id) {
  const res = await api('DELETE', `/boards/${id}/`);
  if (res && (res.ok || res.status === 204)) {
    toast('Tablero eliminado', 'success');
    if (currentBoardId === id) currentBoardId = null;
    await loadBoards();
    if (currentBoardId === null) showHome();
  } else toast('Error al eliminar', 'error');
}

// ── HOME (GRID) ───────────────────────────────────────────────────────────────

function showHome() {
  navigate('/api/home');
}

function _showHomeScreen() {
  currentBoardId = null;
  currentBoardData = null;
  disconnectBoardWS();
  document.getElementById('boards-view').style.display = 'block';
  document.getElementById('board-view').style.display = 'none';
  renderSidebar();
  if (allBoards.length === 0) {
    const grid = document.getElementById('boards-grid');
    grid.innerHTML = Array(3).fill(0).map(() =>
      `<div class="skeleton" style="height:100px"></div>`
    ).join('');
  }
  loadBoards();
}

function renderBoardsGrid() {
  const grid = document.getElementById('boards-grid');

  if (allBoards.length === 0) {
    grid.innerHTML = `<div class="boards-empty" style="grid-column:1/-1">
      <div class="boards-empty-icon">📋</div>
      <p>No tenés tableros todavía.<br>Usá "+ Nuevo tablero" en la barra lateral para crear uno.</p>
    </div>`;
    return;
  }

  grid.innerHTML = allBoards.map((b, i) => `
    <div class="board-card ${BOARD_COLORS[i % 6]}" onclick="openBoard(${b.id}, '${escapeQuotes(b.title)}')">
      <button class="board-card-del" onclick="event.stopPropagation(); confirmDelete('board', ${b.id}, '${escapeQuotes(b.title)}')">✕</button>
      <span class="board-card-name">${b.title}</span>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="board-card-meta">${(b.lists || []).length} listas</span>
        ${userLevel === 0 ? `<span class="board-card-meta" style="font-weight:600">👤 ${b.owner}</span>` : ''}
      </div>
    </div>
  `).join('');
}

// ── BOARD DETAIL ──────────────────────────────────────────────────────────────

function openBoard(id, title) {
  navigate(`/api/board/${id}`);
}

async function _openBoardById(id) {
  currentBoardId = id;
  document.getElementById('boards-view').style.display = 'none';
  document.getElementById('board-view').style.display = 'flex';
  renderSidebar();
  connectBoardWS(id);

  // Buscar título en caché o usar placeholder
  const cached = allBoards.find(b => b.id === id);
  document.getElementById('board-view-title').textContent = cached ? cached.title : '…';

  const container = document.getElementById('lists-container');
  container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;width:100%;padding:3rem">
    <div class="spinner spinner-lg"></div>
  </div>`;

  const res = await api('GET', `/boards/${id}/`);
  if (!res) return;
  const board = await res.json();
  currentBoardData = board;
  document.getElementById('board-view-title').textContent = board.title;
  document.title = `${board.title} — Taskflow`;
  renderBoard(board);

  // Asegurar sidebar actualizado
  if (allBoards.length === 0) await loadBoards();
  else renderSidebar();
}

function renderBoard(board) {
  const container = document.getElementById('lists-container');
  const lists = (board.lists || []).sort((a, b) => a.position - b.position);

  container.innerHTML = lists.map(list => `
    <div class="list-col" id="list-col-${list.id}"
      draggable="true"
      ondragstart="onListDragStart(event, ${list.id})"
      ondragend="onListDragEnd(event)"
      ondragover="onListDragOver(event)"
      ondragleave="onListDragLeave(event)"
      ondrop="onListDrop(event, ${list.id})">
      <div class="col-header">
        <span class="col-title">${list.title}</span>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="col-count">${(list.cards || []).length}</span>
          <div class="col-actions">
            <button class="btn-icon" onclick="confirmDelete('list', ${list.id}, '${escapeQuotes(list.title)}')">🗑</button>
          </div>
        </div>
      </div>
      <div class="cards-area" id="cards-${list.id}"
        ondragover="onDragOver(event)"
        ondragleave="onDragLeave(event)"
        ondrop="onDrop(event, ${list.id})">
        ${(list.cards || []).sort((a, b) => a.position - b.position).map(card => cardHTML(card)).join('')}
      </div>
      <div class="col-footer">
        <button class="add-card-btn" onclick="showAddCardForm(${list.id})">
          <span style="font-size:16px">+</span> Agregar tarjeta
        </button>
        <div class="add-card-form hidden" id="add-card-form-${list.id}">
          <textarea id="card-input-${list.id}" placeholder="Título de la tarjeta" rows="2"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();createCard(${list.id})}"></textarea>
          <div class="add-card-actions">
            <button class="btn btn-primary btn-sm" id="create-card-btn-${list.id}" onclick="createCard(${list.id})">Agregar</button>
            <button class="cancel-btn" onclick="hideAddCardForm(${list.id})">✕</button>
          </div>
        </div>
      </div>
    </div>
  `).join('') + `
    <div class="add-list-col">
      <button class="add-list-btn" id="add-list-btn" onclick="showAddListForm()">
        <span style="font-size:18px">+</span> Agregar lista
      </button>
      <div class="add-list-form hidden" id="add-list-form">
        <input type="text" id="list-input" placeholder="Nombre de la lista"
          onkeydown="if(event.key==='Enter') createList()">
        <div class="form-row">
        <button class="btn btn-primary btn-sm" id="create-list-btn" onclick="createList()">Crear lista</button>          <button class="cancel-btn" onclick="hideAddListForm()">✕</button>
        </div>
      </div>
    </div>
  `;
}
function dueDateStatus(dueDate) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + 'T00:00:00');
  const diffDays = Math.round((due - today) / 86400000);

  if (diffDays < 0) return 'overdue';
  if (diffDays <= 2) return 'soon';
  return 'ok';
}

function formatDueDate(dueDate) {
  const due = new Date(dueDate + 'T00:00:00');
  return due.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function cardHTML(card) {
  const dueStatus = dueDateStatus(card.due_date);
  return `
    <div class="card-item"
      draggable="true"
      id="card-${card.id}"
      ondragstart="onDragStart(event, ${card.id})"
      ondragend="onDragEnd(event)"
      onclick="openCardDetail(${card.id})">
      <button class="card-del"
        onclick="event.stopPropagation(); confirmDelete('card', ${card.id}, '${escapeQuotes(card.title)}')">✕</button>
      <div class="card-title">${card.title}</div>
      ${(card.assigned_to || dueStatus) ? `
        <div class="card-meta">
          ${dueStatus ? `
            <div class="card-due card-due-${dueStatus}">
              <span style="font-size:10px">📅</span>
              ${formatDueDate(card.due_date)}
            </div>` : '<span></span>'}
          ${card.assigned_to ? `
            <div class="card-assigned">
              <span style="font-size:10px">👤</span>
              ${card.assigned_to_username || 'Asignado'}
            </div>` : ''}
        </div>` : ''}
    </div>
  `;
}

async function refreshBoard() {
  if (!currentBoardId) return;
  const res = await api('GET', `/boards/${currentBoardId}/`);
  if (res && res.ok) {
    currentBoardData = await res.json();
    renderBoard(currentBoardData);
  }
}

// ── LISTS ─────────────────────────────────────────────────────────────────────

function showAddListForm() {
  document.getElementById('add-list-btn').classList.add('hidden');
  document.getElementById('add-list-form').classList.remove('hidden');
  setTimeout(() => document.getElementById('list-input').focus(), 50);
}

function hideAddListForm() {
  document.getElementById('add-list-btn').classList.remove('hidden');
  document.getElementById('add-list-form').classList.add('hidden');
}

async function createList() {
  const title = document.getElementById('list-input').value.trim();
  if (!title) return;
  const position = document.querySelectorAll('.list-col').length * 1000;
  setLoading('create-list-btn', true);
  const res = await api('POST', '/lists/', { title, board: currentBoardId, position });
  setLoading('create-list-btn', false);
  if (res && res.ok) { hideAddListForm(); refreshBoard(); }
  else toast('Error al crear la lista', 'error');
}

async function deleteList(id) {
  const res = await api('DELETE', `/lists/${id}/`);
  if (res && (res.ok || res.status === 204)) { toast('Lista eliminada', 'success'); refreshBoard(); }
  else toast('Error al eliminar', 'error');
}

// ── CARDS ─────────────────────────────────────────────────────────────────────

function showAddCardForm(listId) {
  document.querySelectorAll('.add-card-form').forEach(f => f.classList.add('hidden'));
  document.querySelectorAll('.add-card-btn').forEach(b => b.style.display = '');
  const form = document.getElementById(`add-card-form-${listId}`);
  form.classList.remove('hidden');
  form.previousElementSibling.style.display = 'none';
  setTimeout(() => document.getElementById(`card-input-${listId}`).focus(), 50);
}

function hideAddCardForm(listId) {
  document.getElementById(`add-card-form-${listId}`).classList.add('hidden');
  document.querySelector(`#list-col-${listId} .add-card-btn`).style.display = '';
}

async function createCard(listId) {
  const input = document.getElementById(`card-input-${listId}`);
  const title = input.value.trim();
  if (!title) return;
  const position = document.querySelectorAll(`#cards-${listId} .card-item`).length * 1000;
  setLoading(`create-card-btn-${listId}`, true);
  const res = await api('POST', '/cards/', { title, list: listId, position });
  setLoading(`create-card-btn-${listId}`, false);
  if (res && res.ok) {
    input.value = '';
    hideAddCardForm(listId);
    refreshBoard();
  } else toast('Error al crear la tarjeta', 'error');
}

async function deleteCard(id) {
  const res = await api('DELETE', `/cards/${id}/`);
  if (res && (res.ok || res.status === 204)) { toast('Tarjeta eliminada', 'success'); refreshBoard(); }
  else toast('Error al eliminar', 'error');
}

// ── DETALLE DE TARJETA + ASIGNACIÓN ──────────────────────────────────────────

async function ensureUsersLoaded() {
  if (allUsersCache.length > 0) return;
  const res = await api('GET', '/users/');
  if (res && res.ok) allUsersCache = await res.json();
}

function findCardById(cardId) {
  if (!currentBoardData) return null;
  for (const list of currentBoardData.lists || []) {
    const card = (list.cards || []).find(c => c.id === cardId);
    if (card) return card;
  }
  return null;
}

async function openCardDetail(cardId) {
  const card = findCardById(cardId);
  if (!card) return;
  await ensureUsersLoaded();

document.getElementById('card-detail-id').value = card.id;
  document.getElementById('card-detail-title').value = card.title;
  document.getElementById('card-detail-desc').value = card.description || '';
  document.getElementById('card-detail-due').value = card.due_date || '';

  const select = document.getElementById('card-detail-assignee');
  select.innerHTML = '<option value="">Sin asignar</option>' +
    allUsersCache.map(u =>
      `<option value="${u.id}" ${card.assigned_to === u.id ? 'selected' : ''}>${u.username}</option>`
    ).join('');

  document.getElementById('card-detail-modal').classList.remove('hidden');
}

function closeCardDetail() {
  document.getElementById('card-detail-modal').classList.add('hidden');
}

async function saveCardDetail() {
  const id = document.getElementById('card-detail-id').value;
  const title = document.getElementById('card-detail-title').value.trim();
  const description = document.getElementById('card-detail-desc').value.trim();
  const assigneeValue = document.getElementById('card-detail-assignee').value;
  const dueValue = document.getElementById('card-detail-due').value;

  if (!title) { toast('El título no puede estar vacío', 'error'); return; }

  setLoading('card-detail-save-btn', true);
  const res = await api('PATCH', `/cards/${id}/`, {
    title,
    description,
    assigned_to: assigneeValue ? parseInt(assigneeValue) : null,
    due_date: dueValue || null
  });
  setLoading('card-detail-save-btn', false);

  if (res && res.ok) {
    closeCardDetail();
    toast('Tarjeta actualizada', 'success');
    refreshBoard();
  } else {
    toast('Error al actualizar la tarjeta', 'error');
  }
}

// ── DRAG & DROP ───────────────────────────────────────────────────────────────

function onListDragStart(event, listId) {
  draggedListId = listId;
  event.currentTarget.classList.add('list-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.stopPropagation();
}

function onListDragEnd(event) {
  event.currentTarget.classList.remove('list-dragging');
}

function onListDragOver(event) {
  if (!draggedListId) return;
  event.preventDefault();
  event.currentTarget.classList.add('list-drag-over');
}

function onListDragLeave(event) {
  event.currentTarget.classList.remove('list-drag-over');
}

async function onListDrop(event, targetListId) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('list-drag-over');
  if (!draggedListId || draggedListId === targetListId) { draggedListId = null; return; }

  const cols = Array.from(document.querySelectorAll('.list-col'));
  const draggedIndex = cols.findIndex(c => c.id === `list-col-${draggedListId}`);
  const targetIndex = cols.findIndex(c => c.id === `list-col-${targetListId}`);
  if (draggedIndex === -1 || targetIndex === -1) { draggedListId = null; return; }

  const newPosition = (targetIndex + (draggedIndex < targetIndex ? 1 : 0)) * 1000 + 500;

  const res = await api('PATCH', `/lists/${draggedListId}/`, { position: newPosition });
  draggedListId = null;
  if (res && res.ok) refreshBoard();
  else toast('Error al mover la lista', 'error');
}

function onDragStart(event, cardId) {
  draggedCardId = cardId;
  event.target.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(event) {
  event.target.classList.remove('dragging');
}

function onDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add('drag-over');
}

function onDragLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

async function onDrop(event, targetListId) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  if (!draggedCardId) return;
  const count = document.querySelectorAll(`#cards-${targetListId} .card-item`).length;
  const newPosition = (count + 1) * 1000;
  const res = await api('PATCH', `/cards/${draggedCardId}/move/`, {
    list: targetListId, position: newPosition
  });
  draggedCardId = null;
  if (res && res.ok) refreshBoard();
  else toast('Error al mover la tarjeta', 'error');
}
// ── CONFIRM DELETE MODAL ──────────────────────────────────────────────────────

function confirmDelete(type, id, name) {
  const labels = { board: 'tablero', list: 'lista', card: 'tarjeta' };
  pendingDelete = { type, id };
  document.getElementById('modal-title').textContent = `¿Eliminar ${labels[type]}?`;
  document.getElementById('modal-desc').textContent = `"${name}" se eliminará permanentemente. Esta acción no se puede deshacer.`;
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('confirm-modal').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const cardModal = document.getElementById('card-detail-modal');
      if (cardModal && !cardModal.classList.contains('hidden')) closeCardDetail();
      const confirmModal = document.getElementById('confirm-modal');
      if (confirmModal && !confirmModal.classList.contains('hidden')) closeModal();
      const searchResults = document.getElementById('sidebar-search-results');
      if (searchResults && !searchResults.classList.contains('hidden')) {
        searchResults.classList.add('hidden');
        document.getElementById('sidebar-search-input').blur();
      }
    }
  });
  document.getElementById('modal-confirm-btn').addEventListener('click', async () => {
    if (!pendingDelete) return;
    closeModal();
    const { type, id } = pendingDelete;
    if (type === 'board') await deleteBoard(id);
    else if (type === 'list') await deleteList(id);
    else if (type === 'card') await deleteCard(id);
    pendingDelete = null;
  });
  document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('confirm-modal')) closeModal();
  });

  document.getElementById('card-detail-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('card-detail-modal')) closeCardDetail();
  });

  document.addEventListener('click', (e) => {
    const panel = document.getElementById('notif-panel');
    if (panel && !panel.classList.contains('hidden')) {
      if (!panel.contains(e.target)) panel.classList.add('hidden');
    }
    const searchWrapper = document.querySelector('.sidebar-search-wrapper');
    const searchResults = document.getElementById('sidebar-search-results');
    if (searchWrapper && searchResults && !searchResults.classList.contains('hidden')) {
      if (!searchWrapper.contains(e.target)) searchResults.classList.add('hidden');
    }
  });

  // ── INIT con router ────────────────────────────────────────────────────────
  if (token) {
    showApp();
  } else {
    if (location.pathname !== '/api/login') {
      history.replaceState({}, '', '/api/login');
    }
    _showLoginScreen();
  }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────

async function loadNotifications() {
  const res = await api('GET', '/notifications/');
  if (!res || !res.ok) return;
  const notifs = await res.json();
  renderNotifications(notifs);
}

function renderNotifications(notifs) {
  const list = document.getElementById('notif-list');
  const badge = document.getElementById('notif-badge');
  const unread = notifs.filter(n => !n.is_read).length;

  if (unread > 0) {
    badge.style.display = 'flex';
    badge.textContent = unread > 9 ? '9+' : unread;
  } else {
    badge.style.display = 'none';
  }

  if (notifs.length === 0) {
    list.innerHTML = `<div class="notif-empty">
      <div class="notif-empty-icon">🔕</div>
      <p>No tenés notificaciones</p>
    </div>`;
    return;
  }

  list.innerHTML = notifs.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" style="display:flex;gap:10px">
      ${!n.is_read ? '<div class="notif-dot"></div>' : '<div style="width:7px;flex-shrink:0"></div>'}
      <div>
        <div class="notif-msg">${n.message}</div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>
    </div>
  `).join('');
}

async function markAllRead() {
  const res = await api('PATCH', '/notifications/mark_all_as_read/');
  if (res && res.ok) {
    document.getElementById('notif-badge').style.display = 'none';
    loadNotifications();
  }
}

function toggleNotif(event) {
  event.stopPropagation();
  document.getElementById('notif-panel').classList.toggle('hidden');
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr)) / 1000;
  if (diff < 60) return 'hace un momento';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  return `hace ${Math.floor(diff / 86400)}d`;
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────

function connectWS() {
  if (ws) ws.close();
  const dot = document.getElementById('ws-dot');
  ws = new WebSocket(`ws://${window.location.host}/ws/notifications/?token=${token}`);
  ws.onopen = () => { dot.classList.add('connected'); };
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    toast(`🔔 ${data.message}`, 'info');
    loadNotifications();
  };
  ws.onerror = () => { dot.classList.remove('connected'); };
  ws.onclose = () => {
    dot.classList.remove('connected');
    setTimeout(() => { if (token) connectWS(); }, 4000);
  };
}

// WS aparte, uno por tablero abierto: cuando otro usuario mueve/crea/borra
// algo en ESTE tablero, refrescamos para ver el cambio sin recargar la página.
function connectBoardWS(boardId) {
  if (boardWs) boardWs.close();
  boardWs = new WebSocket(`ws://${window.location.host}/ws/board/${boardId}/?token=${token}`);
  boardWs.onmessage = () => {
    refreshBoard();
  };
}

function disconnectBoardWS() {
  if (boardWs) { boardWs.close(); boardWs = null; }
}

// ── ADMIN FUNCTIONS ───────────────────────────────────────────────────────────

function toggleSidebarForm(type) {
  const form = document.getElementById(`form-${type}`);
  const arrow = document.getElementById(`arrow-${type}`);
  const isHidden = form.classList.contains('hidden');

  document.querySelectorAll('.sidebar-admin-form').forEach(f => f.classList.add('hidden'));
  document.querySelectorAll('.sidebar-admin-arrow').forEach(a => a.classList.remove('open'));

  if (isHidden) {
    form.classList.remove('hidden');
    arrow.classList.add('open');
    if (type === 'send-notif') loadUsersForAdmin();
  }
}

async function loadUsersForAdmin() {
  const res = await api('GET', '/users/');
  if (!res || !res.ok) return;
  const users = await res.json();
  const select = document.getElementById('admin-notif-user');
  select.innerHTML = '<option value="">Seleccioná un usuario</option>' +
    users.filter(u => u.username !== currentUser).map(u =>
      `<option value="${u.id}">${u.username} (nivel ${u.level})</option>`
    ).join('');
}

async function adminCreateUser() {
  const username = document.getElementById('admin-new-user').value.trim();
  const password = document.getElementById('admin-new-pass').value;
  const level = parseInt(document.getElementById('admin-new-level').value);
  if (!username || !password) {
    toast('Completá usuario y contraseña', 'error'); return;
  }
  const res = await api('POST', '/register/', { username, password, level });
  if (res && res.ok) {
    toast(`Usuario "${username}" creado correctamente`, 'success');
    document.getElementById('admin-new-user').value = '';
    document.getElementById('admin-new-pass').value = '';
    await loadUsersForAdmin();
  } else {
    const err = await res.json();
    toast(Object.values(err).flat().join(' · '), 'error');
  }
}

async function adminSendNotification() {
  const recipientId = document.getElementById('admin-notif-user').value;
  const message = document.getElementById('admin-notif-msg').value.trim();
  if (!recipientId) { toast('Seleccioná un usuario', 'error'); return; }
  if (!message) { toast('Escribí un mensaje', 'error'); return; }
  const res = await api('POST', '/notifications/send/', { recipient_id: recipientId, message });
  if (res && res.ok) {
    toast('Notificación enviada correctamente', 'success');
    document.getElementById('admin-notif-msg').value = '';
  } else toast('Error al enviar la notificación', 'error');
}