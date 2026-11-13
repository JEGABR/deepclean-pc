const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

let mainWindow;
let activeScanAbortController = null;
let cachedAdminStatus = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#0b0f19',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0f19',
      symbolColor: '#94a3b8',
      height: 38
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Helper: Run PowerShell safely via UTF-16LE Base64 EncodedCommand
async function runPowerShell(psScript, timeoutMs = 45000) {
  const fullScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${psScript}`;
  const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
  const { stdout } = await execAsync(
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    { maxBuffer: 1024 * 1024 * 30, encoding: 'utf8', timeout: timeoutMs }
  );
  return stdout ? stdout.trim() : '';
}

// Helper: Check if running elevated + get all filesystem drives (C:, D:, E:, etc.)
ipcMain.handle('get-system-status', async () => {
  const psScript = `
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$drives = @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
  Where-Object { ($_.Free -gt 0) -or ($_.Used -gt 0) } |
  Select-Object @{N='name';E={$_.Name + ':'}},
                @{N='root';E={$_.Root}},
                @{N='freeBytes';E={[int64]$_.Free}},
                @{N='usedBytes';E={[int64]$_.Used}},
                @{N='totalBytes';E={[int64]($_.Free + $_.Used)}})
$cDrive = $drives | Where-Object { $_.name -eq 'C:' } | Select-Object -First 1
[PSCustomObject]@{
  isAdmin = [bool]$isAdmin
  freeBytes = if ($cDrive) { [int64]$cDrive.freeBytes } else { 0 }
  usedBytes = if ($cDrive) { [int64]$cDrive.usedBytes } else { 0 }
  totalBytes = if ($cDrive) { [int64]$cDrive.totalBytes } else { 0 }
  drives = $drives
} | ConvertTo-Json -Compress -Depth 4
`;
  try {
    const out = await runPowerShell(psScript, 15000);
    const parsed = JSON.parse(out);
    cachedAdminStatus = !!parsed.isAdmin;
    return parsed;
  } catch (err) {
    return { isAdmin: false, freeBytes: 0, usedBytes: 0, totalBytes: 0, drives: [] };
  }
});

// Helper: Concurrency limiter for fast parallel I/O
async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Helper: Calculate folder stats with parallel directory walking and abort support
async function getFolderStats(dirPath, maxDepth = 3, signal = null) {
  let totalSize = 0;
  let fileCount = 0;
  let latestAccess = 0;
  let latestModify = 0;
  let exeFiles = [];
  let uninstallerPath = null;

  try {
    const stat = await fsp.stat(dirPath);
    latestAccess = stat.atimeMs || stat.mtimeMs;
    latestModify = stat.mtimeMs;
  } catch {
    return { totalSize: 0, fileCount: 0, latestAccess: 0, latestModify: 0, exeFiles: [], uninstallerPath: null };
  }

  async function walk(currentPath, depth) {
    if (depth > maxDepth || (signal && signal.aborted)) return;
    let entries;
    try {
      entries = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    const subDirs = [];
    for (const entry of entries) {
      if (signal && signal.aborted) return;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        subDirs.push(fullPath);
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(fullPath);
          totalSize += st.size;
          fileCount++;
          if (st.atimeMs > latestAccess) latestAccess = st.atimeMs;
          if (st.mtimeMs > latestModify) latestModify = st.mtimeMs;

          const lower = entry.name.toLowerCase();
          if (lower.endsWith('.exe')) {
            if (exeFiles.length < 5) exeFiles.push(fullPath);
            if (!uninstallerPath && (lower.includes('unins') || lower.includes('uninstall') || lower.includes('setup'))) {
              uninstallerPath = fullPath;
            }
          }
        } catch {
          // ignore locked files
        }
      }
    }

    if (subDirs.length > 0 && depth < maxDepth) {
      await mapConcurrent(subDirs, 6, (sub) => walk(sub, depth + 1));
    }
  }

  await walk(dirPath, 0);
  return { totalSize, fileCount, latestAccess, latestModify, exeFiles, uninstallerPath };
}

function normalizeToken(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

// Critical folders that must NEVER be deleted or flagged as orphan
const PROTECTED_FOLDER_NAMES = new Set([
  'microsoft', 'windows', 'google', 'mozilla', 'packages', 'connecteddevicesplatform',
  'comms', 'd3dscache', 'diagnostics', 'elevateddiagnostics', 'fontcache', 'history',
  'iecompatcache', 'iecompatua', 'iedownloadhistory', 'inetcache', 'inetcookies',
  'lxss', 'microsoftedge', 'onenote', 'peerdistrepub', 'placeholdertilelogofolder',
  'publishers', 'realtek', 'squirreltemp', 'temp', 'temporary internet files',
  'tiledatalayer', 'unrealengine', 'virtualstore', 'windowsapps', 'windowspowershell',
  'pip', 'npm', 'npm-cache', 'yarn', 'nuget', 'cache', 'crashdumps', 'assembly',
  'common files', 'internet explorer', 'msbuild', 'reference assemblies', 'windows defender',
  'windows defender advanced threat protection', 'windows mail', 'windows media player',
  'windows multimedia platform', 'windows nt', 'windows photo viewer', 'windows portable devices',
  'windows security', 'windows sidebar', 'modifiablewindowsapps', 'uninstall information',
  'package cache', 'usoshared', 'usoprivate', 'ssh', 'system32', 'syswow64', 'drivers', 'boot'
].map(s => normalizeToken(s)));

// Validate if a path is safe to delete (not root, not Windows system folder)
function isSafeDeletionTarget(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);
  const lower = resolved.toLowerCase();

  // Never allow deleting drive roots or top-level system directories
  if (/^[a-z]:\\?$/i.test(resolved)) return false;

  const forbiddenExact = new Set([
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\users',
    (process.env.USERPROFILE || '').toLowerCase(),
    path.join(process.env.USERPROFILE || '', 'appdata').toLowerCase(),
    path.join(process.env.USERPROFILE || '', 'appdata', 'local').toLowerCase(),
    path.join(process.env.USERPROFILE || '', 'appdata', 'roaming').toLowerCase()
  ]);

  if (forbiddenExact.has(lower)) return false;
  if (lower.startsWith('c:\\windows\\') && !lower.startsWith('c:\\windows\\temp\\') && !lower.startsWith('c:\\windows\\prefetch\\')) {
    return false;
  }
  return true;
}

// Icon Cache & Native Windows Shell Icon Extractor
const iconCache = new Map();

function cleanIconTargetPath(rawStr, fallbackInstallLoc) {
  if (rawStr && typeof rawStr === 'string') {
    let cleaned = rawStr.trim();
    // Strip trailing icon index like ",0" or ",-101"
    cleaned = cleaned.replace(/,\s*-?\d+\s*$/, '').trim();
    // Strip surrounding quotes
    cleaned = cleaned.replace(/^"+|"+$/g, '').trim();
    // If it contains arguments after .exe or .ico, extract the file path
    const match = cleaned.match(/^([a-zA-Z]:\\[^"*?<>|]+\.(?:exe|ico|dll|msi))/i);
    if (match && match[1] && fs.existsSync(match[1])) {
      return match[1];
    }
    if (fs.existsSync(cleaned)) {
      return cleaned;
    }
  }
  if (fallbackInstallLoc && fs.existsSync(fallbackInstallLoc)) {
    try {
      const files = fs.readdirSync(fallbackInstallLoc);
      const exe = files.find(f => f.toLowerCase().endsWith('.exe') && !f.toLowerCase().includes('unins'));
      if (exe) return path.join(fallbackInstallLoc, exe);
    } catch {
      // ignore
    }
  }
  return null;
}

async function getNativeFileIconDataUrl(targetPath) {
  if (!targetPath) return null;
  const key = targetPath.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);

  try {
    if (!fs.existsSync(targetPath)) return null;
    const ext = path.extname(targetPath).toLowerCase();
    // Direct .ico file can be read or extracted via getFileIcon
    const nativeImg = await app.getFileIcon(targetPath, { size: 'normal' });
    if (nativeImg && !nativeImg.isEmpty()) {
      const dataUrl = nativeImg.toDataURL();
      iconCache.set(key, dataUrl);
      return dataUrl;
    }
  } catch {
    // ignore icon extraction failures
  }
  iconCache.set(key, null);
  return null;
}

// Get Registry Installed Programs + Appx Packages via PowerShell
async function getRegistryInstalledApps(includeStoreApps = false) {
  const psScript = `
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$regItems = @(Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -ne $null -and $_.SystemComponent -ne 1 } |
  Select-Object @{N='DisplayName';E={[string]$_.DisplayName}},
                @{N='DisplayVersion';E={[string]$_.DisplayVersion}},
                @{N='Publisher';E={[string]$_.Publisher}},
                @{N='InstallLocation';E={[string]$_.InstallLocation}},
                @{N='DisplayIcon';E={[string]$_.DisplayIcon}},
                @{N='UninstallString';E={[string]$_.UninstallString}},
                @{N='QuietUninstallString';E={[string]$_.QuietUninstallString}},
                @{N='EstimatedSize';E={[int64]($_.EstimatedSize)}},
                @{N='InstallDate';E={[string]$_.InstallDate}},
                @{N='PSPath';E={[string]$_.PSPath}},
                @{N='IsStoreApp';E={$false}})

${includeStoreApps ? `
$storeItems = @(Get-AppxPackage -ErrorAction SilentlyContinue |
  Where-Object { $_.IsFramework -eq $false -and $_.NonRemovable -eq $false -and $_.SignatureKind -eq 'Store' } |
  Select-Object @{N='DisplayName';E={[string]$_.Name}},
                @{N='DisplayVersion';E={[string]$_.Version}},
                @{N='Publisher';E={[string]$_.Publisher}},
                @{N='InstallLocation';E={[string]$_.InstallLocation}},
                @{N='UninstallString';E={'APPX:' + [string]$_.PackageFullName}},
                @{N='QuietUninstallString';E={''}},
                @{N='EstimatedSize';E={0}},
                @{N='InstallDate';E={''}},
                @{N='PSPath';E={'APPX::' + [string]$_.PackageFullName}},
                @{N='IsStoreApp';E={$true}})
$all = $regItems + $storeItems
` : `$all = $regItems`}

$all | ConvertTo-Json -Compress
`;

  try {
    const stdout = await runPowerShell(psScript, 45000);
    if (!stdout) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error('Error reading registry apps:', err);
    return [];
  }
}

function psPathToRegKey(psPath) {
  if (!psPath || psPath.startsWith('APPX::')) return null;
  const idx = psPath.indexOf('::');
  const raw = idx !== -1 ? psPath.slice(idx + 2) : psPath;
  return raw
    .replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\')
    .replace(/^HKEY_CURRENT_USER\\/i, 'HKCU\\');
}

// IPC: Cancel any running scan
ipcMain.handle('cancel-scan', async () => {
  if (activeScanAbortController) {
    activeScanAbortController.abort();
    activeScanAbortController = null;
    return { canceled: true };
  }
  return { canceled: false };
});

// IPC: List all installed programs with parallel folder size calculation
ipcMain.handle('get-installed-programs', async (event, options = {}) => {
  const includeStore = !!options.includeStore;
  const rawApps = await getRegistryInstalledApps(includeStore);
  const seen = new Set();
  const candidates = [];

  for (const appItem of rawApps) {
    const name = (appItem.DisplayName || '').trim();
    if (!name) continue;

    const dedupKey = `${name.toLowerCase()}|${(appItem.DisplayVersion || '').toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    let installLoc = (appItem.InstallLocation || '').replace(/^"+|"+$/g, '').trim();
    const uninstallStr = (appItem.UninstallString || '').trim();
    const quietUninstallStr = (appItem.QuietUninstallString || '').trim();

    if (!installLoc && uninstallStr && !uninstallStr.startsWith('APPX:')) {
      const match = uninstallStr.match(/^"?([a-zA-Z]:\\[^"*?<>|]+\.exe)"?/i);
      if (match && match[1]) {
        const candidateDir = path.dirname(match[1]);
        if (!candidateDir.toLowerCase().includes('windows\\system32') && !candidateDir.toLowerCase().includes('windows\\syswow64')) {
          installLoc = candidateDir;
        }
      }
    }

    candidates.push({ appItem, name, installLoc, uninstallStr, quietUninstallStr });
  }

  const list = await mapConcurrent(candidates, 8, async ({ appItem, name, installLoc, uninstallStr, quietUninstallStr }) => {
    let sizeBytes = (Number(appItem.EstimatedSize) || 0) * 1024;
    const locExists = installLoc ? fs.existsSync(installLoc) : false;
    let isJunction = false;
    let realTarget = null;

    if (locExists) {
      try {
        const lst = await fsp.lstat(installLoc);
        if (lst.isSymbolicLink()) {
          isJunction = true;
          realTarget = await fsp.realpath(installLoc).catch(() => null);
        }
      } catch {
        // ignore
      }
    }

    if (sizeBytes === 0 && locExists) {
      try {
        const st = await getFolderStats(installLoc, 2);
        sizeBytes = st.totalSize;
      } catch {
        // ignore
      }
    }

    let brokenUninstaller = false;
    const isStoreApp = !!appItem.IsStoreApp;
    const isMsi = /msiexec/i.test(uninstallStr);

    if (!isStoreApp && !isMsi && uninstallStr) {
      const exeMatch = uninstallStr.match(/^"?([a-zA-Z]:\\[^"*?<>|]+\.exe)"?/i);
      if (exeMatch && exeMatch[1] && !fs.existsSync(exeMatch[1])) {
        brokenUninstaller = true;
      }
    }
    if (!isStoreApp && installLoc && !locExists && !isMsi) {
      brokenUninstaller = true;
    }

    const regKey = psPathToRegKey(appItem.PSPath);
    let scope = 'Sistema (Todos)';
    if (isStoreApp) scope = 'Microsoft Store';
    else if (regKey && regKey.startsWith('HKCU')) scope = 'Usuário Atual';

    const iconTarget = cleanIconTargetPath(appItem.DisplayIcon || uninstallStr, installLoc);
    const iconDataUrl = await getNativeFileIconDataUrl(iconTarget);

    return {
      id: Buffer.from((appItem.PSPath || name)).toString('base64'),
      name,
      version: appItem.DisplayVersion || '-',
      publisher: appItem.Publisher || 'Desconhecido',
      installDate: appItem.InstallDate || '',
      installLocation: installLoc || null,
      locationExists: locExists,
      uninstallString: uninstallStr,
      quietUninstallString: quietUninstallStr,
      size: sizeBytes,
      isMsi,
      isStoreApp,
      brokenUninstaller,
      regKey,
      scope,
      iconDataUrl,
      isJunction,
      realTarget
    };
  });

  list.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  return list;
});

// Helper: Find leftover folders for an uninstalled program
async function findProgramLeftovers(appInfo) {
  const leftovers = [];
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';

  if (appInfo.installLocation && fs.existsSync(appInfo.installLocation) && isSafeDeletionTarget(appInfo.installLocation)) {
    const st = await getFolderStats(appInfo.installLocation, 2);
    leftovers.push({
      type: 'folder',
      label: 'Pasta de Instalação Restante',
      path: appInfo.installLocation,
      size: st.totalSize
    });
  }

  const stopWords = new Set(['microsoft', 'windows', 'google', 'driver', 'update', 'runtime', 'redistributable', 'package', 'client', 'server', 'player', 'studio', 'desktop', 'application', 'software', 'version', 'common', 'system', 'service']);
  const tokens = new Set();

  const cleanName = normalizeToken(appInfo.name.replace(/\b(v?\d+(\.\d+)*|x64|x86|64-bit|32-bit)\b/gi, ''));
  if (cleanName.length >= 4 && !PROTECTED_FOLDER_NAMES.has(cleanName) && !stopWords.has(cleanName)) {
    tokens.add(cleanName);
  }

  const nameParts = appInfo.name.split(/[\s\-_().]+/).map(normalizeToken).filter(t => t.length >= 5 && !PROTECTED_FOLDER_NAMES.has(t) && !stopWords.has(t));
  nameParts.forEach(t => tokens.add(t));

  if (appInfo.installLocation) {
    const base = normalizeToken(path.basename(appInfo.installLocation));
    if (base.length >= 4 && !PROTECTED_FOLDER_NAMES.has(base) && !stopWords.has(base)) {
      tokens.add(base);
    }
  }

  const searchDirs = [
    { label: 'AppData\\Roaming', dir: path.join(userProfile, 'AppData', 'Roaming') },
    { label: 'AppData\\Local', dir: path.join(userProfile, 'AppData', 'Local') },
    { label: 'AppData\\Local\\Programs', dir: path.join(userProfile, 'AppData', 'Local', 'Programs') },
    { label: 'ProgramData', dir: process.env.ProgramData || 'C:\\ProgramData' },
    { label: 'Program Files', dir: process.env.ProgramFiles || 'C:\\Program Files' },
    { label: 'Program Files (x86)', dir: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)' }
  ];

  const addedPaths = new Set(leftovers.map(l => l.path.toLowerCase()));

  for (const sDir of searchDirs) {
    if (!fs.existsSync(sDir.dir)) continue;
    let entries = [];
    try {
      entries = await fsp.readdir(sDir.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const normEntry = normalizeToken(entry.name);
      if (!normEntry || PROTECTED_FOLDER_NAMES.has(normEntry)) continue;

      let matched = false;
      for (const tok of tokens) {
        if (normEntry === tok || (tok.length >= 6 && normEntry.includes(tok))) {
          matched = true;
          break;
        }
      }

      if (matched) {
        const fullPath = path.join(sDir.dir, entry.name);
        if (!addedPaths.has(fullPath.toLowerCase()) && isSafeDeletionTarget(fullPath)) {
          addedPaths.add(fullPath.toLowerCase());
          const st = await getFolderStats(fullPath, 2);
          leftovers.push({
            type: 'folder',
            label: `Resíduo em ${sDir.label}`,
            path: fullPath,
            size: st.totalSize
          });
        }
      }
    }
  }

  return leftovers;
}

// IPC: Run official uninstaller and then scan for leftovers
ipcMain.handle('uninstall-program', async (event, appInfo) => {
  if (!appInfo || !appInfo.uninstallString) {
    return { success: false, error: 'Comando de desinstalação não encontrado.' };
  }

  let launchedOk = true;
  let errorMessage = null;

  try {
    if (appInfo.uninstallString.startsWith('APPX:')) {
      const pkgFullName = appInfo.uninstallString.slice(5);
      await runPowerShell(`Remove-AppxPackage -Package '${pkgFullName.replace(/'/g, "''")}'`, 120000);
    } else {
      await execAsync(`cmd.exe /c "${appInfo.uninstallString}"`, { timeout: 1000 * 60 * 10 });
    }
  } catch (err) {
    launchedOk = false;
    errorMessage = err.message;
  }

  await new Promise(r => setTimeout(r, 1500));
  const leftovers = await findProgramLeftovers(appInfo);

  return {
    success: true,
    launchedOk,
    errorMessage,
    leftovers
  };
});

// IPC: Force remove broken registry entry + scan leftovers
ipcMain.handle('force-remove-program', async (event, appInfo) => {
  let regRemoved = false;
  let regError = null;

  if (appInfo.regKey) {
    try {
      await execAsync(`reg delete "${appInfo.regKey}" /f`);
      regRemoved = true;
    } catch (err) {
      regError = 'Permissão negada ao remover chave HKLM (execute o DeepClean como Administrador).';
    }
  }

  const leftovers = await findProgramLeftovers(appInfo);
  return { regRemoved, regError, leftovers };
});

// IPC: Scan Ghost Programs & Orphan Folders (with Parallelism & AbortController)
ipcMain.handle('scan-ghost-programs', async () => {
  if (activeScanAbortController) activeScanAbortController.abort();
  activeScanAbortController = new AbortController();
  const { signal } = activeScanAbortController;

  const sendProgress = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-progress', { type: 'ghost', message: msg });
    }
  };

  sendProgress('Lendo programas registrados no Windows...');
  const regApps = await getRegistryInstalledApps(true);

  const registeredTokens = new Set();
  const registeredPaths = new Set();

  for (const appItem of regApps) {
    const dn = normalizeToken(appItem.DisplayName);
    const pub = normalizeToken(appItem.Publisher);
    if (dn && dn.length >= 3) registeredTokens.add(dn);
    if (pub && pub.length >= 3) registeredTokens.add(pub);

    if (appItem.DisplayName) {
      const words = appItem.DisplayName.split(/[\s\-_().]+/).map(normalizeToken).filter(w => w.length >= 4);
      words.forEach(w => registeredTokens.add(w));
    }

    if (appItem.InstallLocation && typeof appItem.InstallLocation === 'string') {
      const cleanLoc = appItem.InstallLocation.replace(/^"+|"+$/g, '').trim();
      if (cleanLoc) {
        registeredPaths.add(cleanLoc.toLowerCase());
        const base = normalizeToken(path.basename(cleanLoc));
        if (base.length >= 3) registeredTokens.add(base);
      }
    }
  }

  const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
  const scanRoots = [
    { label: 'Program Files', path: process.env.ProgramFiles || 'C:\\Program Files', category: 'Programas Portáteis / Fora do Painel' },
    { label: 'Program Files (x86)', path: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', category: 'Programas Portáteis / Fora do Painel' },
    { label: 'AppData\\Local\\Programs', path: path.join(userProfile, 'AppData', 'Local', 'Programs'), category: 'Apps Instalados no Usuário' },
    { label: 'AppData\\Roaming', path: path.join(userProfile, 'AppData', 'Roaming'), category: 'Dados / Resíduos de Programas (Roaming)' },
    { label: 'AppData\\Local', path: path.join(userProfile, 'AppData', 'Local'), category: 'Dados / Cache de Programas (Local)' },
    { label: 'ProgramData', path: process.env.ProgramData || 'C:\\ProgramData', category: 'Dados Globais (ProgramData)' }
  ];

  const candidateDirs = [];

  for (const root of scanRoots) {
    if (signal.aborted) break;
    if (!fs.existsSync(root.path)) continue;

    let entries = [];
    try {
      entries = await fsp.readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      const normName = normalizeToken(folderName);
      if (!normName || PROTECTED_FOLDER_NAMES.has(normName) || folderName.startsWith('.')) continue;

      const fullPath = path.join(root.path, folderName);
      const lowerFullPath = fullPath.toLowerCase();

      let isRegistered = false;
      for (const regPath of registeredPaths) {
        if (regPath.startsWith(lowerFullPath) || lowerFullPath.startsWith(regPath)) {
          isRegistered = true;
          break;
        }
      }

      if (!isRegistered) {
        if (registeredTokens.has(normName)) {
          isRegistered = true;
        } else {
          for (const tok of registeredTokens) {
            if (tok.length >= 5 && normName.length >= 5 && (tok.includes(normName) || normName.includes(tok))) {
              isRegistered = true;
              break;
            }
          }
        }
      }

      if (!isRegistered) {
        candidateDirs.push({ root, folderName, fullPath });
      }
    }
  }

  let processed = 0;
  const results = [];

  await mapConcurrent(candidateDirs, 8, async ({ root, folderName, fullPath }) => {
    if (signal.aborted) return;
    processed++;
    if (processed % 5 === 0 || processed === candidateDirs.length) {
      sendProgress(`Analisando (${processed}/${candidateDirs.length}): ${root.label}\\${folderName}...`);
    }

    const stats = await getFolderStats(fullPath, 2, signal);
    if (stats.totalSize < 100 * 1024) return;

    const hasExe = stats.exeFiles.length > 0;
    let classification = 'Pasta Órfã / Resíduo de Desinstalação';
    let statusType = 'orphan';

    if (hasExe || root.label.includes('Program Files') || root.label.includes('Programs')) {
      classification = 'Programa Oculto / Portátil (Fora do Painel do Windows)';
      statusType = 'hidden_program';
    }

    const daysSinceAccess = stats.latestAccess
      ? Math.floor((Date.now() - stats.latestAccess) / (1000 * 60 * 60 * 24))
      : 0;
    const daysSinceModify = stats.latestModify
      ? Math.floor((Date.now() - stats.latestModify) / (1000 * 60 * 60 * 24))
      : 0;

    const firstExe = stats.exeFiles[0] || null;
    const iconDataUrl = firstExe ? await getNativeFileIconDataUrl(firstExe) : null;

    results.push({
      id: Buffer.from(fullPath).toString('base64'),
      name: folderName,
      path: fullPath,
      locationLabel: root.label,
      category: root.category,
      classification,
      statusType,
      size: stats.totalSize,
      fileCount: stats.fileCount,
      lastModified: stats.latestModify,
      lastAccessed: stats.latestAccess,
      daysSinceModify,
      daysSinceAccess,
      exeCount: stats.exeFiles.length,
      sampleExe: firstExe ? path.basename(firstExe) : null,
      uninstallerPath: stats.uninstallerPath,
      iconDataUrl
    });
  });

  results.sort((a, b) => b.size - a.size);
  sendProgress(signal.aborted ? 'Varredura interrompida.' : 'Varredura concluída!');
  return results;
});

// IPC: Scan Old / Unused Files + Developer Heavy Artifacts (node_modules, .venv, target, etc.)
ipcMain.handle('scan-unused-files', async (event, options = {}) => {
  if (activeScanAbortController) activeScanAbortController.abort();
  activeScanAbortController = new AbortController();
  const { signal } = activeScanAbortController;

  const minDays = Number(options.minDays) || 90;
  const minSizeMB = Number(options.minSizeMB) || 10;
  const minSizeBytes = minSizeMB * 1024 * 1024;
  const dateMetric = options.dateMetric || 'mtime';
  const includeDevCaches = options.includeDevCaches !== false;
  const customPaths = options.paths && options.paths.length > 0 ? options.paths : null;

  const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
  const defaultRoots = [
    path.join(userProfile, 'Downloads'),
    path.join(userProfile, 'Documents'),
    path.join(userProfile, 'Desktop'),
    path.join(userProfile, 'Videos'),
    path.join(userProfile, 'Pictures'),
    path.join(userProfile, 'Music')
  ];

  // If user has custom workspace folders like projetosmalucos, include it if inside userProfile
  const rootsToScan = customPaths || defaultRoots.filter(p => fs.existsSync(p));
  const cutoffMs = Date.now() - (minDays * 24 * 60 * 60 * 1000);
  const foundFiles = [];

  const sendProgress = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-progress', { type: 'unused', message: msg });
    }
  };

  const devArtifactFolders = new Set(['node_modules', '.venv', 'venv', 'target', '__pycache__', '.next', 'dist', 'build']);
  const skipDirs = new Set(['.git', 'AppData', '$RECYCLE.BIN', 'System Volume Information', 'Windows']);

  async function scanDir(currentDir, depth = 0) {
    if (depth > 6 || signal.aborted) return;
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal.aborted) return;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) && depth > 0) continue;

        // Check if this is a heavy developer cache directory (like node_modules)
        if (devArtifactFolders.has(entry.name.toLowerCase())) {
          if (includeDevCaches) {
            const st = await getFolderStats(fullPath, 3, signal);
            const relevantTime = dateMetric === 'atime' ? (st.latestAccess || st.latestModify) : st.latestModify;
            if (st.totalSize >= minSizeBytes && relevantTime > 0 && relevantTime <= cutoffMs) {
              const daysUnused = Math.floor((Date.now() - relevantTime) / (1000 * 60 * 60 * 24));
              foundFiles.push({
                id: Buffer.from(fullPath).toString('base64'),
                name: `[Pasta Dev] ${entry.name}`,
                path: fullPath,
                directory: currentDir,
                extension: 'dev_cache',
                isDirectory: true,
                size: st.totalSize,
                lastModified: st.latestModify,
                lastAccessed: st.latestAccess || st.latestModify,
                daysUnused
              });
            }
          }
          // Do not recurse inside node_modules or .venv for individual files
          continue;
        }

        if (depth <= 1) {
          sendProgress(`Escaneando: ${fullPath}`);
        }
        await scanDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(fullPath);
          if (st.size < minSizeBytes) continue;

          const relevantTime = dateMetric === 'atime' ? (st.atimeMs || st.mtimeMs) : st.mtimeMs;
          if (relevantTime <= cutoffMs) {
            const daysUnused = Math.floor((Date.now() - relevantTime) / (1000 * 60 * 60 * 24));
            const ext = path.extname(entry.name).toLowerCase() || 'sem extensão';
            const iconDataUrl = await getNativeFileIconDataUrl(fullPath);
            foundFiles.push({
              id: Buffer.from(fullPath).toString('base64'),
              name: entry.name,
              path: fullPath,
              directory: currentDir,
              extension: ext,
              isDirectory: false,
              size: st.size,
              lastModified: st.mtimeMs,
              lastAccessed: st.atimeMs || st.mtimeMs,
              daysUnused,
              iconDataUrl
            });
          }
        } catch {
          // ignore locked files
        }
      }
    }
  }

  for (const r of rootsToScan) {
    if (signal.aborted) break;
    sendProgress(`Iniciando leitura em ${r}...`);
    await scanDir(r, 0);
  }

  foundFiles.sort((a, b) => b.size - a.size);
  sendProgress(signal.aborted ? 'Busca interrompida.' : 'Análise de arquivos antigos concluída!');
  return foundFiles;
});

// IPC: Scan Quick System Junk (Temp, Windows Temp, Prefetch, CrashDumps, Thumbcache, etc.)
ipcMain.handle('scan-system-junk', async () => {
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
  const localAppData = path.join(userProfile, 'AppData', 'Local');

  const junkTargets = [
    {
      id: 'user_temp',
      name: 'Arquivos Temporários do Usuário (%TEMP%)',
      desc: 'Arquivos temporários criados por instaladores e aplicativos em uso.',
      path: process.env.TEMP || path.join(localAppData, 'Temp'),
      cleanContentsOnly: true
    },
    {
      id: 'win_temp',
      name: 'Arquivos Temporários do Windows (C:\\Windows\\Temp)',
      desc: 'Logs e arquivos temporários de serviços do sistema Windows.',
      path: 'C:\\Windows\\Temp',
      cleanContentsOnly: true
    },
    {
      id: 'prefetch',
      name: 'Cache de Pré-carregamento (Windows Prefetch)',
      desc: 'Arquivos de otimização antigos de programas que já não são usados.',
      path: 'C:\\Windows\\Prefetch',
      cleanContentsOnly: true
    },
    {
      id: 'crash_dumps',
      name: 'Relatórios de Falha e CrashDumps',
      desc: 'Despejos de memória gerados quando programas travam ou fecham sozinhos.',
      path: path.join(localAppData, 'CrashDumps'),
      cleanContentsOnly: true
    },
    {
      id: 'wer_reports',
      name: 'Relatórios de Erros do Windows (WER)',
      desc: 'Logs de erros acumulados pelo Windows Error Reporting.',
      path: path.join(localAppData, 'Microsoft', 'Windows', 'WER'),
      cleanContentsOnly: true
    },
    {
      id: 'npm_cache',
      name: 'Cache de Pacotes NPM (Node.js)',
      desc: 'Pacotes antigos baixados pelo npm que ocupam espaço em disco.',
      path: path.join(localAppData, 'npm-cache'),
      cleanContentsOnly: true
    },
    {
      id: 'pip_cache',
      name: 'Cache de Pacotes PIP (Python)',
      desc: 'Rodas (.whl) e arquivos de instalação antigos do Python.',
      path: path.join(localAppData, 'pip', 'Cache'),
      cleanContentsOnly: true
    },
    {
      id: 'shader_cache',
      name: 'Cache de Shaders DirectX (D3DSCache)',
      desc: 'Shaders compilados antigos de placas de vídeo e jogos.',
      path: path.join(localAppData, 'D3DSCache'),
      cleanContentsOnly: true
    }
  ];

  const results = await mapConcurrent(junkTargets, 6, async (t) => {
    if (!fs.existsSync(t.path)) return null;
    const st = await getFolderStats(t.path, 3);
    if (st.totalSize < 50 * 1024) return null;
    return {
      ...t,
      size: st.totalSize,
      fileCount: st.fileCount
    };
  });

  return results.filter(Boolean).sort((a, b) => b.size - a.size);
});

// IPC: Choose custom folder
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// IPC: Open path in Windows Explorer
ipcMain.handle('reveal-in-explorer', async (event, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return false;
  shell.showItemInFolder(path.resolve(targetPath));
  return true;
});

// IPC: Run custom uninstaller executable inside a ghost/portable folder
ipcMain.handle('run-executable', async (event, exePath) => {
  if (!exePath || typeof exePath !== 'string' || !fs.existsSync(exePath)) {
    return { success: false, error: 'Executável não encontrado.' };
  }
  if (!exePath.toLowerCase().endsWith('.exe')) {
    return { success: false, error: 'Apenas executáveis (.exe) são permitidos.' };
  }
  try {
    await execAsync(`cmd.exe /c "${exePath}"`, { timeout: 1000 * 60 * 10 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: Delete items (supports Permanent Delete OR Move to Windows Recycle Bin + cleanContentsOnly for Temp dirs)
ipcMain.handle('delete-items-permanently', async (event, payload) => {
  const items = Array.isArray(payload) ? payload : (payload?.items || []);
  const useTrash = payload && payload.useTrash === true;

  if (!Array.isArray(items) || items.length === 0) {
    return { deleted: [], failed: [], totalFreed: 0 };
  }

  const deleted = [];
  const failed = [];
  let totalFreed = 0;

  for (const item of items) {
    const targetPath = item.path;
    const itemSize = Number(item.size) || 0;
    const cleanContentsOnly = !!item.cleanContentsOnly;

    if (!isSafeDeletionTarget(targetPath)) {
      failed.push({ path: targetPath, error: 'Bloqueado pela trava de segurança do sistema.' });
      continue;
    }

    try {
      if (!fs.existsSync(targetPath)) {
        failed.push({ path: targetPath, error: 'Caminho já não existe.' });
        continue;
      }

      if (cleanContentsOnly) {
        // Delete children inside the temp/cache folder so the root folder itself remains intact
        const children = await fsp.readdir(targetPath);
        let anyDeleted = false;
        for (const child of children) {
          const childFull = path.join(targetPath, child);
          try {
            if (useTrash) {
              await shell.trashItem(childFull);
            } else {
              await fsp.rm(childFull, { recursive: true, force: true });
            }
            anyDeleted = true;
          } catch {
            // Some temp files are locked by running processes; skip them gracefully
          }
        }
        if (anyDeleted || children.length === 0) {
          deleted.push(targetPath);
          totalFreed += itemSize;
        } else {
          failed.push({ path: targetPath, error: 'Arquivos em uso pelo sistema.' });
        }
      } else {
        if (useTrash) {
          await shell.trashItem(targetPath);
        } else {
          await fsp.rm(targetPath, { recursive: true, force: true });
        }
        deleted.push(targetPath);
        totalFreed += itemSize;
      }
    } catch (err) {
      failed.push({ path: targetPath, error: err.message || 'Permissão negada ou arquivo em uso.' });
    }
  }

  return { deleted, failed, totalFreed };
});

// IPC: Migrate Program / Folder / File between Drives (e.g. C: <-> E:) without breaking paths
// Modes:
// - 'junction' (Recommended for Programs/AppData/Games): Copies folder to target drive, verifies integrity, removes original and creates a transparent NTFS Directory Junction (mklink /J) at the original path so Windows, Registry, and shortcuts continue working seamlessly.
// - 'direct' (For standalone personal files/archives/videos): Copies file/folder to target drive, verifies size, and deletes original.
ipcMain.handle('migrate-between-drives', async (event, payload) => {
  const { sourcePath, destinationRoot, mode = 'junction' } = payload || {};

  if (!sourcePath || !destinationRoot) {
    return { success: false, error: 'Caminho de origem ou destino não informado.' };
  }

  const resolvedSource = path.resolve(sourcePath);
  const resolvedDestRoot = path.resolve(destinationRoot);

  if (!fs.existsSync(resolvedSource)) {
    return { success: false, error: 'O item de origem não existe no disco.' };
  }

  if (!isSafeDeletionTarget(resolvedSource)) {
    return { success: false, error: 'Este diretório é crítico do Windows e não pode ser movido.' };
  }

  const baseName = path.basename(resolvedSource);
  const targetFullPath = path.join(resolvedDestRoot, baseName);

  if (resolvedSource.toLowerCase() === targetFullPath.toLowerCase()) {
    return { success: false, error: 'A origem e o destino são o mesmo caminho.' };
  }

  if (fs.existsSync(targetFullPath)) {
    return { success: false, error: `Já existe um item chamado "${baseName}" em "${resolvedDestRoot}". Escolha outra pasta de destino.` };
  }

  const sendMigrateProgress = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-progress', { type: 'migrate', message: msg });
    }
  };

  try {
    const stat = await fsp.lstat(resolvedSource);
    if (stat.isSymbolicLink()) {
      return { success: false, error: 'Esta pasta já é um Link Simbólico (Junção NTFS) apontando para outro disco.' };
    }

    const isDir = stat.isDirectory();
    await fsp.mkdir(resolvedDestRoot, { recursive: true });

    if (isDir) {
      sendMigrateProgress(`Copiando "${baseName}" para "${targetFullPath}" via Robocopy...`);
      try {
        await execAsync(`robocopy "${resolvedSource}" "${targetFullPath}" /E /COPY:DAT /R:2 /W:1 /MT:8 /NFL /NDL /NJH /NJS`, {
          timeout: 1000 * 60 * 30
        });
      } catch (roboErr) {
        // Robocopy returns exit code 1-7 on normal copy success; >= 8 indicates failure
        if (typeof roboErr.code === 'number' && roboErr.code >= 8) {
          throw new Error(`Falha ao copiar arquivos (Robocopy código ${roboErr.code}). Verifique se algum programa está aberto.`);
        }
      }

      if (!fs.existsSync(targetFullPath)) {
        throw new Error('A pasta de destino não pôde ser validada após a cópia.');
      }

      if (mode === 'junction') {
        sendMigrateProgress(`Validando integridade e criando Junção NTFS transparente (mklink /J)...`);
        const backupTempPath = `${resolvedSource}_deepclean_bak_${Date.now()}`;

        try {
          await fsp.rename(resolvedSource, backupTempPath);
        } catch {
          await fsp.rm(targetFullPath, { recursive: true, force: true }).catch(() => {});
          throw new Error('Não foi possível mover a pasta original porque há arquivos em uso/abertos ou falta permissão de Administrador.');
        }

        try {
          await execAsync(`cmd.exe /c mklink /J "${resolvedSource}" "${targetFullPath}"`);
        } catch (linkErr) {
          // Automatic rollback if junction creation fails
          await fsp.rename(backupTempPath, resolvedSource).catch(() => {});
          throw new Error('Falha ao criar Junção NTFS: ' + linkErr.message);
        }

        sendMigrateProgress(`Limpando espaço no disco de origem...`);
        await fsp.rm(backupTempPath, { recursive: true, force: true });
      } else {
        sendMigrateProgress(`Removendo pasta original após verificação...`);
        await fsp.rm(resolvedSource, { recursive: true, force: true });
      }
    } else {
      sendMigrateProgress(`Copiando arquivo "${baseName}" para "${targetFullPath}"...`);
      await fsp.copyFile(resolvedSource, targetFullPath);

      const srcStat = await fsp.stat(resolvedSource);
      const dstStat = await fsp.stat(targetFullPath);
      if (srcStat.size !== dstStat.size) {
        await fsp.rm(targetFullPath, { force: true }).catch(() => {});
        throw new Error('Tamanho do arquivo copiado diverge do original. Operação cancelada.');
      }

      await fsp.rm(resolvedSource, { force: true });
    }

    sendMigrateProgress('Migração concluída com sucesso!');
    return {
      success: true,
      sourcePath: resolvedSource,
      targetFullPath,
      mode: isDir ? mode : 'direct'
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Erro inesperado durante a migração entre discos.'
    };
  }
});
