// State
let installedItems = [];
let ghostItems = [];
let unusedItems = [];
let junkItems = [];
let selectedMap = new Map(); // path -> { path, name, size, sourceTab, cleanContentsOnly }
let customUnusedFolder = null;
let totalSessionFreed = 0;

// Helpers
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  return d.toLocaleDateString('pt-BR');
}

function getSizeClass(bytes) {
  if (bytes >= 500 * 1024 * 1024) return 'size-pill size-large';
  if (bytes >= 100 * 1024 * 1024) return 'size-pill size-medium';
  return 'size-pill';
}

function renderSizeWithBar(bytes, maxBytes) {
  if (!bytes || bytes <= 0) return '<span class="size-pill">-</span>';
  const pct = maxBytes > 0 ? Math.max(4, Math.min(100, Math.round((bytes / maxBytes) * 100))) : 5;
  let barClass = 'size-bar-value';
  if (bytes >= 500 * 1024 * 1024) barClass += ' bar-danger';
  else if (bytes >= 100 * 1024 * 1024) barClass += ' bar-amber';

  return `
    <div class="size-bar-wrap">
      <span class="${getSizeClass(bytes)}">${formatBytes(bytes)}</span>
      <div class="size-bar-track">
        <div class="${barClass}" style="width: ${pct}%;"></div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==========================================
// ICON SYSTEM (NATIVE OS ICON OR VECTOR SVG)
// ==========================================
const SVG_ICONS = {
  appDefault: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 3v18M3 9h6"/></svg>`,
  storeApp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
  ghostExe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>`,
  folderOrphan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
  devCache: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><polygon points="10 8 16 12 10 16 10 8"/></svg>`,
  installer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`,
  fileGeneric: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  junkBolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`
};

function renderItemIcon(item, categoryType) {
  if (item.iconDataUrl) {
    return `<div class="item-icon-box"><img src="${item.iconDataUrl}" alt="" /></div>`;
  }

  if (categoryType === 'installed') {
    if (item.isStoreApp) {
      return `<div class="item-icon-box icon-tone-purple">${SVG_ICONS.storeApp}</div>`;
    }
    return `<div class="item-icon-box icon-tone-blue">${SVG_ICONS.appDefault}</div>`;
  }

  if (categoryType === 'ghost') {
    if (item.statusType === 'hidden_program') {
      return `<div class="item-icon-box icon-tone-purple">${SVG_ICONS.ghostExe}</div>`;
    }
    return `<div class="item-icon-box icon-tone-amber">${SVG_ICONS.folderOrphan}</div>`;
  }

  if (categoryType === 'unused') {
    const ext = item.extension || '';
    if (ext === 'dev_cache') {
      return `<div class="item-icon-box icon-tone-emerald">${SVG_ICONS.devCache}</div>`;
    }
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
      return `<div class="item-icon-box icon-tone-amber">${SVG_ICONS.archive}</div>`;
    }
    if (['.mp4', '.mkv', '.avi', '.mov', '.mp3', '.wav'].includes(ext)) {
      return `<div class="item-icon-box icon-tone-rose">${SVG_ICONS.media}</div>`;
    }
    if (['.exe', '.msi', '.iso', '.img'].includes(ext)) {
      return `<div class="item-icon-box icon-tone-purple">${SVG_ICONS.installer}</div>`;
    }
    return `<div class="item-icon-box icon-tone-blue">${SVG_ICONS.fileGeneric}</div>`;
  }

  if (categoryType === 'junk') {
    return `<div class="item-icon-box icon-tone-amber">${SVG_ICONS.junkBolt}</div>`;
  }

  return `<div class="item-icon-box icon-tone-blue">${SVG_ICONS.fileGeneric}</div>`;
}

// ==========================================
// THEME MANAGER (DARK / LIGHT)
// ==========================================
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeIconSun = document.getElementById('theme-icon-sun');
const themeIconMoon = document.getElementById('theme-icon-moon');
const themeLabel = document.getElementById('theme-label');

function initTheme() {
  const saved = localStorage.getItem('deepclean_theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    themeIconSun.classList.remove('hidden');
    themeIconMoon.classList.add('hidden');
    themeLabel.textContent = 'Tema Claro';
  } else {
    document.documentElement.removeAttribute('data-theme');
    themeIconSun.classList.add('hidden');
    themeIconMoon.classList.remove('hidden');
    themeLabel.textContent = 'Tema Escuro';
  }
  localStorage.setItem('deepclean_theme', theme);
}

themeToggleBtn.addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  applyTheme(isLight ? 'dark' : 'light');
});

// System Telemetry (All Drives Space + Admin Status)
let availableDrives = [];

async function refreshSystemStatus() {
  try {
    const st = await window.deepCleanAPI.getSystemStatus();
    const adminBadge = document.getElementById('admin-badge');
    if (st.isAdmin) {
      adminBadge.textContent = 'Modo Administrador Ativo';
      adminBadge.classList.add('is-admin');
    } else {
      adminBadge.textContent = 'Modo Usuário Padrão';
      adminBadge.classList.remove('is-admin');
    }

    availableDrives = Array.isArray(st.drives) && st.drives.length > 0
      ? st.drives
      : [{ name: 'C:', root: 'C:\\', freeBytes: st.freeBytes, usedBytes: st.usedBytes, totalBytes: st.totalBytes }];

    const container = document.getElementById('drives-telemetry-list');
    if (container) {
      container.innerHTML = '';
      for (const drv of availableDrives) {
        if (!drv.totalBytes || drv.totalBytes <= 0) continue;
        const usedPct = Math.round((drv.usedBytes / drv.totalBytes) * 100);
        const card = document.createElement('div');
        card.className = 'disk-telemetry';
        card.style.marginBottom = '10px';
        card.innerHTML = `
          <div class="disk-header">
            <span>Unidade (${escapeHtml(drv.name)})</span>
            <strong>${formatBytes(drv.freeBytes)} livres</strong>
          </div>
          <div class="disk-bar-bg">
            <div class="disk-bar-fill" style="width: ${usedPct}%;"></div>
          </div>
          <small class="disk-sub">${formatBytes(drv.usedBytes)} usados de ${formatBytes(drv.totalBytes)} (${usedPct}%)</small>
        `;
        container.appendChild(card);
      }
    }
  } catch (err) {
    console.error('Telemetry error:', err);
  }
}

// Tab Navigation
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.getAttribute('data-tab');
    document.getElementById(target).classList.add('active');
  });
});

// Listen for Scan Progress
window.deepCleanAPI.onScanProgress((data) => {
  if (data.type === 'ghost') {
    const el = document.getElementById('ghost-progress-text');
    if (el) el.textContent = data.message;
  } else if (data.type === 'unused') {
    const el = document.getElementById('unused-progress-text');
    if (el) el.textContent = data.message;
  } else if (data.type === 'migrate') {
    const el = document.getElementById('migrate-progress-text');
    if (el) el.textContent = data.message;
  }
});

// Update Selection Totals
function updateSelectionUI() {
  let totalBytes = 0;
  for (const item of selectedMap.values()) {
    totalBytes += item.size;
  }

  const count = selectedMap.size;
  document.getElementById('selected-size-display').textContent = formatBytes(totalBytes);
  document.getElementById('selected-count-display').textContent = `${count} item(ns) marcado(s)`;

  const statusText = count > 0
    ? `${count} item(ns) selecionado(s) pronto(s) para limpeza (${formatBytes(totalBytes)})`
    : 'Nenhum item marcado para exclusão.';
  document.getElementById('footer-status-text').textContent = statusText;

  document.getElementById('btn-clear-selection').disabled = count === 0;
  document.getElementById('btn-delete-selected').disabled = count === 0;
}

function toggleItemSelection(item, checked) {
  if (checked) {
    selectedMap.set(item.path, item);
  } else {
    selectedMap.delete(item.path);
  }
  updateSelectionUI();
}

// ==========================================
// TAB 0: UNINSTALLER PRO (INSTALLED APPS)
// ==========================================
const btnRefreshInstalled = document.getElementById('btn-refresh-installed');
const toggleStoreApps = document.getElementById('toggle-store-apps');
const installedProgress = document.getElementById('installed-progress');
const installedProgressText = document.getElementById('installed-progress-text');
const installedTbody = document.getElementById('installed-tbody');
const installedSearch = document.getElementById('installed-search');
const installedFilter = document.getElementById('installed-filter');
const installedSort = document.getElementById('installed-sort');

async function loadInstalledPrograms() {
  btnRefreshInstalled.disabled = true;
  installedProgressText.textContent = 'Lendo programas instalados, ícones nativos e espaço real em disco...';
  installedProgress.classList.remove('hidden');

  try {
    installedItems = await window.deepCleanAPI.getInstalledPrograms({
      includeStore: toggleStoreApps.checked
    });
    document.getElementById('badge-count-installed').textContent = installedItems.length;
    renderInstalledTable();
  } catch (err) {
    console.error(err);
  } finally {
    btnRefreshInstalled.disabled = false;
    installedProgress.classList.add('hidden');
  }
}

btnRefreshInstalled.addEventListener('click', loadInstalledPrograms);
toggleStoreApps.addEventListener('change', loadInstalledPrograms);

function getFilteredInstalledItems() {
  const q = installedSearch.value.trim().toLowerCase();
  const f = installedFilter.value;
  const s = installedSort.value;

  let filtered = installedItems.filter(item => {
    if (f === 'broken' && !item.brokenUninstaller) return false;
    if (f === 'user' && item.scope !== 'Usuário Atual') return false;
    if (f === 'system' && item.scope !== 'Sistema (Todos)') return false;
    if (f === 'store' && !item.isStoreApp) return false;
    if (q && !item.name.toLowerCase().includes(q) && !item.publisher.toLowerCase().includes(q)) return false;
    return true;
  });

  if (s === 'size_desc') {
    filtered.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  } else if (s === 'name_asc') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (s === 'publisher_asc') {
    filtered.sort((a, b) => a.publisher.localeCompare(b.publisher));
  }

  return filtered;
}

function renderInstalledTable() {
  const list = getFilteredInstalledItems();
  installedTbody.innerHTML = '';

  if (list.length === 0) {
    installedTbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">Nenhum programa encontrado com esses filtros.</div>
        </td>
      </tr>
    `;
    return;
  }

  const maxBytes = Math.max(...list.map(i => i.size || 0), 1);

  for (const item of list) {
    const tr = document.createElement('tr');
    let statusBadge = `<span class="badge badge-emerald">${escapeHtml(item.scope)}</span>`;
    if (item.isJunction) {
      statusBadge = `<span class="badge badge-purple" title="Movido com Junção NTFS apontando para: ${escapeHtml(item.realTarget || '')}">Movido (${escapeHtml((item.realTarget || '').slice(0, 3))})</span>`;
    } else if (item.brokenUninstaller) {
      statusBadge = `<span class="badge badge-amber" title="O executável de desinstalação ou pasta original não foi encontrado">Desinstalador Ausente</span>`;
    } else if (item.isStoreApp) {
      statusBadge = `<span class="badge badge-purple">Microsoft Store</span>`;
    }

    tr.innerHTML = `
      <td>
        <div class="item-cell">
          ${renderItemIcon(item, 'installed')}
          <div class="item-meta">
            <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="item-path" title="${escapeHtml(item.installLocation || item.uninstallString)}">
              ${escapeHtml(item.installLocation || item.uninstallString || 'Local gerenciado pelo Windows')}
            </span>
          </div>
        </div>
      </td>
      <td>${escapeHtml(item.publisher)}</td>
      <td>${escapeHtml(item.version)}</td>
      <td>${statusBadge}</td>
      <td>${renderSizeWithBar(item.size, maxBytes)}</td>
      <td>
        <div class="action-group">
          <button class="btn-danger btn-sm btn-uninstall" title="Executar desinstalador e escanear sobras">
            Desinstalar
          </button>
          ${item.installLocation && !item.isStoreApp ? `<button class="btn-primary btn-sm btn-migrate-loc" title="Mover pasta do programa para outro disco (ex: C: para E:) sem quebrar nada">Mover Disco</button>` : ''}
          ${!item.isStoreApp ? `<button class="btn-secondary btn-sm btn-force-clean" title="Remover entrada do registro e caçar pastas residuais">Forçar</button>` : ''}
          ${item.installLocation ? `<button class="btn-secondary btn-sm btn-open-loc" title="Abrir pasta no Explorer">Pasta</button>` : ''}
        </div>
      </td>
    `;

    tr.querySelector('.btn-uninstall').addEventListener('click', () => handleStandardUninstall(item));
    const migrateBtn = tr.querySelector('.btn-migrate-loc');
    if (migrateBtn) {
      migrateBtn.addEventListener('click', () => openMigrateModal({
        name: item.name,
        path: item.installLocation,
        size: item.size,
        isDirectory: true,
        defaultMode: 'junction'
      }));
    }
    const forceBtn = tr.querySelector('.btn-force-clean');
    if (forceBtn) {
      forceBtn.addEventListener('click', () => handleForceRemove(item));
    }

    const openBtn = tr.querySelector('.btn-open-loc');
    if (openBtn) {
      openBtn.addEventListener('click', () => window.deepCleanAPI.revealInExplorer(item.installLocation));
    }

    installedTbody.appendChild(tr);
  }
}

installedSearch.addEventListener('input', renderInstalledTable);
installedFilter.addEventListener('change', renderInstalledTable);
installedSort.addEventListener('change', renderInstalledTable);

async function handleStandardUninstall(appItem) {
  installedProgressText.textContent = `Executando desinstalador de "${appItem.name}" e aguardando conclusão para escanear resíduos...`;
  installedProgress.classList.remove('hidden');

  try {
    const res = await window.deepCleanAPI.uninstallProgram(appItem);
    await loadInstalledPrograms();
    await refreshSystemStatus();
    showLeftoversModal(appItem, res.leftovers || [], {
      mode: 'standard',
      launchedOk: res.launchedOk
    });
  } catch (err) {
    alert('Erro durante desinstalação: ' + err.message);
  } finally {
    installedProgress.classList.add('hidden');
  }
}

async function handleForceRemove(appItem) {
  const ok = confirm(
    `Deseja forçar a remoção de "${appItem.name}"?\n\nIsso apagará a chave de desinstalação do Registro do Windows e procurará todas as pastas restantes desse programa para você apagar.`
  );
  if (!ok) return;

  installedProgressText.textContent = `Removendo registro de "${appItem.name}" e procurando pastas residuais...`;
  installedProgress.classList.remove('hidden');

  try {
    const res = await window.deepCleanAPI.forceRemoveProgram(appItem);
    await loadInstalledPrograms();
    showLeftoversModal(appItem, res.leftovers || [], {
      mode: 'force',
      regRemoved: res.regRemoved,
      regError: res.regError
    });
  } catch (err) {
    alert('Erro ao forçar remoção: ' + err.message);
  } finally {
    installedProgress.classList.add('hidden');
  }
}

// Leftovers Modal
const leftoversModal = document.getElementById('leftovers-modal');
const leftoversTitle = document.getElementById('leftovers-title');
const leftoversDesc = document.getElementById('leftovers-desc');
const leftoversList = document.getElementById('leftovers-list');
const leftoversCancel = document.getElementById('leftovers-cancel');
const leftoversConfirm = document.getElementById('leftovers-confirm');
let currentLeftoverSelection = [];

function showLeftoversModal(appItem, leftovers, meta) {
  leftoversTitle.textContent = `Resíduos de: ${appItem.name}`;
  leftoversList.innerHTML = '';
  currentLeftoverSelection = [...leftovers];

  let statusNote = '';
  if (meta.mode === 'force') {
    statusNote = meta.regRemoved
      ? 'Chave do Registro removida com sucesso! '
      : `Nota sobre o Registro: ${meta.regError || 'Não foi possível remover a chave.'} `;
  }

  if (leftovers.length === 0) {
    leftoversDesc.textContent = `${statusNote}Nenhuma pasta residual foi encontrada em AppData, ProgramData ou Program Files. O programa foi limpo completamente!`;
    leftoversList.innerHTML = `<div class="empty-state" style="padding:20px;">Zero sobras encontradas no disco.</div>`;
    leftoversConfirm.classList.add('hidden');
    leftoversCancel.textContent = 'Fechar';
  } else {
    const totalBytes = leftovers.reduce((acc, i) => acc + (i.size || 0), 0);
    leftoversDesc.innerHTML = `${statusNote}Encontramos <strong>${leftovers.length} pasta(s) residual(is)</strong> deixadas por <strong>${escapeHtml(appItem.name)}</strong> totalizando <strong>${formatBytes(totalBytes)}</strong>. Marque o que deseja excluir:`;
    leftoversConfirm.classList.remove('hidden');
    leftoversCancel.textContent = 'Manter Pastas';

    leftovers.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'modal-file-item';
      row.innerHTML = `
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;max-width:440px;overflow:hidden;">
          <input type="checkbox" class="leftover-check" data-idx="${idx}" checked />
          <span title="${escapeHtml(item.path)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            <strong>[${escapeHtml(item.label)}]</strong> ${escapeHtml(item.path)}
          </span>
        </label>
        <strong>${formatBytes(item.size)}</strong>
      `;
      leftoversList.appendChild(row);
    });
  }

  leftoversModal.classList.remove('hidden');
}

leftoversCancel.addEventListener('click', () => {
  leftoversModal.classList.add('hidden');
});

leftoversConfirm.addEventListener('click', async () => {
  const checks = leftoversList.querySelectorAll('.leftover-check');
  const toDelete = [];
  checks.forEach(ch => {
    if (ch.checked) {
      const idx = Number(ch.getAttribute('data-idx'));
      if (currentLeftoverSelection[idx]) {
        toDelete.push(currentLeftoverSelection[idx]);
      }
    }
  });

  if (toDelete.length === 0) {
    leftoversModal.classList.add('hidden');
    return;
  }

  leftoversConfirm.disabled = true;
  leftoversConfirm.textContent = 'Apagando sobras...';

  try {
    const res = await window.deepCleanAPI.deleteItemsPermanently({ items: toDelete, useTrash: false });
    totalSessionFreed += res.totalFreed;
    document.getElementById('freed-size-display').textContent = formatBytes(totalSessionFreed);
    await refreshSystemStatus();
    leftoversModal.classList.add('hidden');
  } catch (err) {
    alert('Erro ao apagar sobras: ' + err.message);
  } finally {
    leftoversConfirm.disabled = false;
    leftoversConfirm.textContent = 'Apagar Resíduos Selecionados';
  }
});

// ==========================================
// TAB 1: GHOST PROGRAMS & ORPHAN FOLDERS
// ==========================================
const btnScanGhost = document.getElementById('btn-scan-ghost');
const btnCancelGhost = document.getElementById('btn-cancel-ghost');
const ghostProgress = document.getElementById('ghost-progress');
const ghostTbody = document.getElementById('ghost-tbody');
const ghostSearch = document.getElementById('ghost-search');
const ghostFilterType = document.getElementById('ghost-filter-type');
const ghostSort = document.getElementById('ghost-sort');
const ghostSelectAll = document.getElementById('ghost-select-all');

btnCancelGhost.addEventListener('click', () => window.deepCleanAPI.cancelScan());

btnScanGhost.addEventListener('click', async () => {
  btnScanGhost.disabled = true;
  btnCancelGhost.classList.remove('hidden');
  ghostProgress.classList.remove('hidden');
  ghostTbody.innerHTML = '';

  try {
    ghostItems = await window.deepCleanAPI.scanGhostPrograms();
    document.getElementById('badge-count-ghost').textContent = ghostItems.length;
    renderGhostTable();
  } catch (err) {
    console.error(err);
  } finally {
    btnScanGhost.disabled = false;
    btnCancelGhost.classList.add('hidden');
    ghostProgress.classList.add('hidden');
  }
});

function getFilteredGhostItems() {
  const q = ghostSearch.value.trim().toLowerCase();
  const t = ghostFilterType.value;
  const s = ghostSort.value;

  let filtered = ghostItems.filter(item => {
    if (t !== 'all' && item.statusType !== t) return false;
    if (q && !item.name.toLowerCase().includes(q) && !item.path.toLowerCase().includes(q)) return false;
    return true;
  });

  if (s === 'size_desc') {
    filtered.sort((a, b) => b.size - a.size);
  } else if (s === 'days_desc') {
    filtered.sort((a, b) => b.daysSinceModify - a.daysSinceModify);
  } else if (s === 'name_asc') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  return filtered;
}

function renderGhostTable() {
  const list = getFilteredGhostItems();
  ghostTbody.innerHTML = '';

  if (list.length === 0) {
    ghostTbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty-state">Nenhum programa oculto ou pasta órfã encontrada com esses filtros.</div>
        </td>
      </tr>
    `;
    return;
  }

  const maxBytes = Math.max(...list.map(i => i.size || 0), 1);

  for (const item of list) {
    const tr = document.createElement('tr');
    const isChecked = selectedMap.has(item.path);
    const badgeHtml = item.statusType === 'hidden_program'
      ? `<span class="badge badge-purple">Programa Oculto (${item.exeCount} .exe)</span>`
      : `<span class="badge badge-amber">Pasta Órfã / Resíduo</span>`;

    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" ${isChecked ? 'checked' : ''} /></td>
      <td>
        <div class="item-cell">
          ${renderItemIcon(item, 'ghost')}
          <div class="item-meta">
            <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="item-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
          </div>
        </div>
      </td>
      <td>${badgeHtml}</td>
      <td>${escapeHtml(item.locationLabel)}</td>
      <td>${item.daysSinceModify} dias (${formatDate(item.lastModified)})</td>
      <td>${renderSizeWithBar(item.size, maxBytes)}</td>
      <td>
        <div class="action-group">
          ${item.uninstallerPath ? `<button class="btn-danger btn-sm btn-run-unins" title="Executar ${escapeHtml(item.uninstallerPath)}">Desinstalar</button>` : ''}
          <button class="btn-primary btn-sm btn-migrate-ghost" title="Mover pasta para outro disco (ex: C: para E:) sem quebrar o funcionamento">Mover Disco</button>
          <button class="btn-secondary btn-sm btn-open-dir" title="Abrir no Windows Explorer">Pasta</button>
        </div>
      </td>
    `;

    const checkbox = tr.querySelector('.row-check');
    checkbox.addEventListener('change', (e) => {
      toggleItemSelection({ path: item.path, name: item.name, size: item.size, sourceTab: 'ghost' }, e.target.checked);
    });

    const runUninsBtn = tr.querySelector('.btn-run-unins');
    if (runUninsBtn) {
      runUninsBtn.addEventListener('click', async () => {
        await window.deepCleanAPI.runExecutable(item.uninstallerPath);
      });
    }

    tr.querySelector('.btn-migrate-ghost').addEventListener('click', () => {
      openMigrateModal({
        name: item.name,
        path: item.path,
        size: item.size,
        isDirectory: true,
        defaultMode: 'junction'
      });
    });

    tr.querySelector('.btn-open-dir').addEventListener('click', () => {
      window.deepCleanAPI.revealInExplorer(item.path);
    });

    ghostTbody.appendChild(tr);
  }
}

ghostSearch.addEventListener('input', renderGhostTable);
ghostFilterType.addEventListener('change', renderGhostTable);
ghostSort.addEventListener('change', renderGhostTable);

ghostSelectAll.addEventListener('change', (e) => {
  const checked = e.target.checked;
  const visible = getFilteredGhostItems();
  visible.forEach(item => {
    toggleItemSelection({ path: item.path, name: item.name, size: item.size, sourceTab: 'ghost' }, checked);
  });
  renderGhostTable();
});

// ==========================================
// TAB 2: UNUSED OLD FILES & DEV CACHES
// ==========================================
const btnScanUnused = document.getElementById('btn-scan-unused');
const btnCancelUnused = document.getElementById('btn-cancel-unused');
const unusedProgress = document.getElementById('unused-progress');
const unusedTbody = document.getElementById('unused-tbody');
const unusedSearch = document.getElementById('unused-search');
const unusedExtFilter = document.getElementById('unused-ext-filter');
const unusedSelectAll = document.getElementById('unused-select-all');
const btnPickFolder = document.getElementById('btn-pick-folder');
const btnResetFolder = document.getElementById('btn-reset-folder');
const customFolderLabel = document.getElementById('custom-folder-label');

btnCancelUnused.addEventListener('click', () => window.deepCleanAPI.cancelScan());

btnPickFolder.addEventListener('click', async () => {
  const folder = await window.deepCleanAPI.selectFolder();
  if (folder) {
    customUnusedFolder = folder;
    customFolderLabel.textContent = folder;
    customFolderLabel.title = folder;
    btnResetFolder.classList.remove('hidden');
  }
});

btnResetFolder.addEventListener('click', () => {
  customUnusedFolder = null;
  customFolderLabel.textContent = 'Pastas do Usuário (Downloads, Docs, Desktop...)';
  btnResetFolder.classList.add('hidden');
});

btnScanUnused.addEventListener('click', async () => {
  btnScanUnused.disabled = true;
  btnCancelUnused.classList.remove('hidden');
  unusedProgress.classList.remove('hidden');
  unusedTbody.innerHTML = '';

  const minDays = Number(document.getElementById('unused-days').value);
  const minSizeMB = Number(document.getElementById('unused-min-size').value);
  const dateMetric = document.getElementById('unused-metric').value;

  try {
    unusedItems = await window.deepCleanAPI.scanUnusedFiles({
      minDays,
      minSizeMB,
      dateMetric,
      includeDevCaches: true,
      paths: customUnusedFolder ? [customUnusedFolder] : null
    });
    document.getElementById('badge-count-unused').textContent = unusedItems.length;
    renderUnusedTable();
  } catch (err) {
    console.error(err);
  } finally {
    btnScanUnused.disabled = false;
    btnCancelUnused.classList.add('hidden');
    unusedProgress.classList.add('hidden');
  }
});

function getFilteredUnusedItems() {
  const q = unusedSearch.value.trim().toLowerCase();
  const extGroup = unusedExtFilter.value;

  const groups = {
    installers: ['.exe', '.msi', '.iso', '.img', '.cab'],
    archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'],
    media: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.mp3', '.wav', '.flac'],
    dev: ['dev_cache']
  };

  return unusedItems.filter(item => {
    if (extGroup !== 'all' && groups[extGroup]) {
      if (!groups[extGroup].includes(item.extension)) return false;
    }
    if (q && !item.name.toLowerCase().includes(q) && !item.path.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderUnusedTable() {
  const list = getFilteredUnusedItems();
  unusedTbody.innerHTML = '';

  if (list.length === 0) {
    unusedTbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty-state">Nenhum arquivo inativo encontrado para os critérios selecionados.</div>
        </td>
      </tr>
    `;
    return;
  }

  const maxBytes = Math.max(...list.map(i => i.size || 0), 1);

  for (const item of list) {
    const tr = document.createElement('tr');
    const isChecked = selectedMap.has(item.path);

    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" ${isChecked ? 'checked' : ''} /></td>
      <td>
        <div class="item-cell">
          ${renderItemIcon(item, 'unused')}
          <div class="item-meta">
            <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="item-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
          </div>
        </div>
      </td>
      <td>${escapeHtml(item.directory)}</td>
      <td><span class="badge badge-amber">${item.daysUnused} dias sem uso</span></td>
      <td>${formatDate(item.lastModified)}</td>
      <td>${renderSizeWithBar(item.size, maxBytes)}</td>
      <td>
        <div class="action-group">
          <button class="btn-primary btn-sm btn-migrate-unused" title="Mover arquivo/pasta para outro disco (ex: C: <-> E:)">Mover Disco</button>
          <button class="btn-secondary btn-sm btn-open-dir">Ver Local</button>
        </div>
      </td>
    `;

    const checkbox = tr.querySelector('.row-check');
    checkbox.addEventListener('change', (e) => {
      toggleItemSelection({ path: item.path, name: item.name, size: item.size, sourceTab: 'unused' }, e.target.checked);
    });

    tr.querySelector('.btn-migrate-unused').addEventListener('click', () => {
      openMigrateModal({
        name: item.name,
        path: item.path,
        size: item.size,
        isDirectory: !!item.isDirectory,
        defaultMode: item.isDirectory ? 'junction' : 'direct'
      });
    });

    tr.querySelector('.btn-open-dir').addEventListener('click', () => {
      window.deepCleanAPI.revealInExplorer(item.path);
    });

    unusedTbody.appendChild(tr);
  }
}

unusedSearch.addEventListener('input', renderUnusedTable);
unusedExtFilter.addEventListener('change', renderUnusedTable);

unusedSelectAll.addEventListener('change', (e) => {
  const checked = e.target.checked;
  const visible = getFilteredUnusedItems();
  visible.forEach(item => {
    toggleItemSelection({ path: item.path, name: item.name, size: item.size, sourceTab: 'unused' }, checked);
  });
  renderUnusedTable();
});

// ==========================================
// TAB 3: QUICK SYSTEM JUNK (CCLEANER STYLE)
// ==========================================
const btnScanJunk = document.getElementById('btn-scan-junk');
const junkTbody = document.getElementById('junk-tbody');
const junkSelectAll = document.getElementById('junk-select-all');

btnScanJunk.addEventListener('click', async () => {
  btnScanJunk.disabled = true;
  junkTbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Calculando caches temporários do sistema...</div></td></tr>`;

  try {
    junkItems = await window.deepCleanAPI.scanSystemJunk();
    document.getElementById('badge-count-junk').textContent = junkItems.length;
    renderJunkTable();
  } catch (err) {
    console.error(err);
  } finally {
    btnScanJunk.disabled = false;
  }
});

function renderJunkTable() {
  junkTbody.innerHTML = '';
  if (junkItems.length === 0) {
    junkTbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">Os caches temporários do sistema já estão limpos!</div>
        </td>
      </tr>
    `;
    return;
  }

  const maxBytes = Math.max(...junkItems.map(i => i.size || 0), 1);

  for (const item of junkItems) {
    const tr = document.createElement('tr');
    const isChecked = selectedMap.has(item.path);

    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" ${isChecked ? 'checked' : ''} /></td>
      <td>
        <div class="item-cell">
          ${renderItemIcon(item, 'junk')}
          <div class="item-meta">
            <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="item-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
          </div>
        </div>
      </td>
      <td>${escapeHtml(item.desc)}</td>
      <td><span class="badge badge-purple">${item.fileCount} arquivos</span></td>
      <td>${renderSizeWithBar(item.size, maxBytes)}</td>
      <td>
        <button class="btn-secondary btn-sm btn-open-dir">Abrir</button>
      </td>
    `;

    const checkbox = tr.querySelector('.row-check');
    checkbox.addEventListener('change', (e) => {
      toggleItemSelection({
        path: item.path,
        name: item.name,
        size: item.size,
        cleanContentsOnly: item.cleanContentsOnly,
        sourceTab: 'junk'
      }, e.target.checked);
    });

    tr.querySelector('.btn-open-dir').addEventListener('click', () => {
      window.deepCleanAPI.revealInExplorer(item.path);
    });

    junkTbody.appendChild(tr);
  }
}

junkSelectAll.addEventListener('change', (e) => {
  const checked = e.target.checked;
  junkItems.forEach(item => {
    toggleItemSelection({
      path: item.path,
      name: item.name,
      size: item.size,
      cleanContentsOnly: item.cleanContentsOnly,
      sourceTab: 'junk'
    }, checked);
  });
  renderJunkTable();
});

// ==========================================
// DELETION & CONFIRMATION FLOW
// ==========================================
const btnClearSelection = document.getElementById('btn-clear-selection');
const btnDeleteSelected = document.getElementById('btn-delete-selected');
const confirmModal = document.getElementById('confirm-modal');
const modalCount = document.getElementById('modal-count');
const modalSize = document.getElementById('modal-size');
const modalList = document.getElementById('modal-list');
const modalCancel = document.getElementById('modal-cancel');
const modalTrash = document.getElementById('modal-trash');
const modalConfirm = document.getElementById('modal-confirm');

btnClearSelection.addEventListener('click', () => {
  selectedMap.clear();
  ghostSelectAll.checked = false;
  unusedSelectAll.checked = false;
  junkSelectAll.checked = false;
  updateSelectionUI();
  renderGhostTable();
  renderUnusedTable();
  renderJunkTable();
});

btnDeleteSelected.addEventListener('click', () => {
  if (selectedMap.size === 0) return;

  let totalBytes = 0;
  modalList.innerHTML = '';

  for (const item of selectedMap.values()) {
    totalBytes += item.size;
    const div = document.createElement('div');
    div.className = 'modal-file-item';
    div.innerHTML = `
      <span title="${escapeHtml(item.path)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:430px;">
        ${escapeHtml(item.path)}
      </span>
      <strong>${formatBytes(item.size)}</strong>
    `;
    modalList.appendChild(div);
  }

  modalCount.textContent = selectedMap.size;
  modalSize.textContent = formatBytes(totalBytes);
  confirmModal.classList.remove('hidden');
});

modalCancel.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
});

async function executeCleanup(useTrash) {
  modalConfirm.disabled = true;
  modalTrash.disabled = true;

  const itemsArray = Array.from(selectedMap.values());
  try {
    const res = await window.deepCleanAPI.deleteItemsPermanently({
      items: itemsArray,
      useTrash
    });
    const deletedSet = new Set(res.deleted);

    ghostItems = ghostItems.filter(i => !deletedSet.has(i.path));
    unusedItems = unusedItems.filter(i => !deletedSet.has(i.path));
    junkItems = junkItems.filter(i => !deletedSet.has(i.path));

    for (const p of res.deleted) {
      selectedMap.delete(p);
    }

    totalSessionFreed += res.totalFreed;
    document.getElementById('freed-size-display').textContent = formatBytes(totalSessionFreed);
    document.getElementById('badge-count-ghost').textContent = ghostItems.length;
    document.getElementById('badge-count-unused').textContent = unusedItems.length;
    document.getElementById('badge-count-junk').textContent = junkItems.length;

    updateSelectionUI();
    renderGhostTable();
    renderUnusedTable();
    renderJunkTable();
    await refreshSystemStatus();
    confirmModal.classList.add('hidden');

    if (res.failed && res.failed.length > 0) {
      alert(`${res.deleted.length} item(ns) limpos com sucesso.\n${res.failed.length} item(ns) não puderam ser removidos (podem estar em uso ou exigir Modo Administrador).`);
    }
  } catch (err) {
    alert('Erro ao limpar itens: ' + err.message);
  } finally {
    modalConfirm.disabled = false;
    modalTrash.disabled = false;
  }
}

modalTrash.addEventListener('click', () => executeCleanup(true));
modalConfirm.addEventListener('click', () => executeCleanup(false));

// ==========================================
// DRIVE MIGRATION MODAL LOGIC (C: <-> E:)
// ==========================================
const migrateModal = document.getElementById('migrate-modal');
const migrateItemName = document.getElementById('migrate-item-name');
const migrateItemSize = document.getElementById('migrate-item-size');
const migrateSourcePath = document.getElementById('migrate-source-path');
const migrateDestQuickDrives = document.getElementById('migrate-dest-QuickDrives');
const btnPickMigrateDest = document.getElementById('btn-pick-migrate-dest');
const migrateDestPath = document.getElementById('migrate-dest-path');
const migrateModeGroup = document.getElementById('migrate-mode-group');
const migrateModeSelect = document.getElementById('migrate-mode-select');
const migrateProgressBox = document.getElementById('migrate-progress-box');
const migrateCancel = document.getElementById('migrate-cancel');
const migrateConfirm = document.getElementById('migrate-confirm');

let currentMigrateItem = null;
let selectedDestinationRoot = null;

function openMigrateModal(item) {
  currentMigrateItem = item;
  selectedDestinationRoot = null;

  migrateItemName.textContent = item.name;
  migrateItemSize.textContent = formatBytes(item.size);
  migrateSourcePath.textContent = item.path;
  migrateDestPath.textContent = 'Selecione uma unidade abaixo ou clique em "Escolher Pasta..."';

  if (item.isDirectory) {
    migrateModeGroup.classList.remove('hidden');
    migrateModeSelect.value = item.defaultMode || 'junction';
  } else {
    migrateModeGroup.classList.add('hidden');
    migrateModeSelect.value = 'direct';
  }

  // Render quick drive buttons (e.g. E:\DeepClean_Movidos, D:\DeepClean_Movidos, C:\DeepClean_Movidos)
  migrateDestQuickDrives.innerHTML = '';
  const sourceDrive = (item.path || '').slice(0, 2).toUpperCase();

  for (const drv of availableDrives) {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary btn-sm';
    const suggestedPath = `${drv.name}\\DeepClean_Movidos`;
    const isOtherDrive = drv.name.toUpperCase() !== sourceDrive;
    btn.innerHTML = `Disco <strong>${escapeHtml(drv.name)}</strong> (${formatBytes(drv.freeBytes)} livres)${isOtherDrive ? ' ★' : ''}`;
    btn.addEventListener('click', () => {
      selectedDestinationRoot = suggestedPath;
      migrateDestPath.textContent = `${suggestedPath}\\${item.name.replace(/^\[Pasta Dev\]\s*/, '')}`;
    });
    migrateDestQuickDrives.appendChild(btn);

    // Pre-select the first drive that is different from source drive
    if (isOtherDrive && !selectedDestinationRoot) {
      selectedDestinationRoot = suggestedPath;
      migrateDestPath.textContent = `${suggestedPath}\\${item.name.replace(/^\[Pasta Dev\]\s*/, '')}`;
    }
  }

  migrateProgressBox.classList.add('hidden');
  migrateConfirm.disabled = false;
  migrateCancel.disabled = false;
  migrateModal.classList.remove('hidden');
}

btnPickMigrateDest.addEventListener('click', async () => {
  const folder = await window.deepCleanAPI.selectFolder();
  if (folder && currentMigrateItem) {
    selectedDestinationRoot = folder;
    migrateDestPath.textContent = `${folder}\\${currentMigrateItem.name.replace(/^\[Pasta Dev\]\s*/, '')}`;
  }
});

migrateCancel.addEventListener('click', () => {
  migrateModal.classList.add('hidden');
});

migrateConfirm.addEventListener('click', async () => {
  if (!currentMigrateItem || !selectedDestinationRoot) {
    alert('Escolha uma unidade ou pasta de destino primeiro.');
    return;
  }

  migrateConfirm.disabled = true;
  migrateCancel.disabled = true;
  migrateProgressBox.classList.remove('hidden');

  try {
    const res = await window.deepCleanAPI.migrateBetweenDrives({
      sourcePath: currentMigrateItem.path,
      destinationRoot: selectedDestinationRoot,
      mode: currentMigrateItem.isDirectory ? migrateModeSelect.value : 'direct'
    });

    if (!res.success) {
      alert('Não foi possível concluir a transferência:\n' + res.error);
    } else {
      totalSessionFreed += (currentMigrateItem.size || 0);
      document.getElementById('freed-size-display').textContent = formatBytes(totalSessionFreed);
      await refreshSystemStatus();
      await loadInstalledPrograms();
      migrateModal.classList.add('hidden');
      alert(
        res.mode === 'junction'
          ? `Sucesso! Os arquivos foram movidos para:\n${res.targetFullPath}\n\nE uma Junção NTFS transparente foi criada em:\n${res.sourcePath}\n\nO programa e todos os atalhos continuarão funcionando normalmente!`
          : `Sucesso! Movido diretamente para:\n${res.targetFullPath}`
      );
    }
  } catch (err) {
    alert('Erro durante a migração: ' + err.message);
  } finally {
    migrateConfirm.disabled = false;
    migrateCancel.disabled = false;
    migrateProgressBox.classList.add('hidden');
  }
});

// Auto-load on startup
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  refreshSystemStatus();
  loadInstalledPrograms();
});
