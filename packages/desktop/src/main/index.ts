import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from "electron";
import path from "node:path";
import { ipcHandlers } from "./ipc.js";
import { storageManager, isVaultUnlocked } from "./storage.js";
import { syncClient } from "./sync.js";

// Prevent Chromium's network-service sandbox from crashing on macOS
// (known Electron 33 issue: network_service_instance_impl.cc crash in Electron ≤ 33)
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "NetworkServiceInProcess2");
}

const isDev = process.env.NODE_ENV === "development";
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// ─────────────────────────────────────────────
//  Window
// ─────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: "SwarmVault",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", (event) => {
    // Minimise to tray instead of quitting
    event.preventDefault();
    mainWindow?.hide();
  });
}

// ─────────────────────────────────────────────
//  System Tray
// ─────────────────────────────────────────────

function createTray(): void {
  // Fall back to an empty icon if the asset isn't present (dev builds without icon files)
  const iconPath = path.join(__dirname, "../../assets/tray-icon.png");
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  } else {
    icon = icon.resize({ width: 16, height: 16 });
  }
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open SwarmVault",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: "separator" },
    {
      label: "Pause Contribution",
      click: () => storageManager.pauseContribution(),
    },
    {
      label: "Resume Contribution",
      click: () => storageManager.resumeContribution(),
    },
    { type: "separator" },
    {
      label: "Open Sync Folder",
      click: () => {
        const syncDir = storageManager.getSyncDir();
        if (syncDir) shell.openPath(syncDir);
      },
    },
    { type: "separator" },
    {
      label: "Quit SwarmVault",
      click: () => {
        mainWindow?.removeAllListeners("close");
        app.quit();
      },
    },
  ]);

  tray.setToolTip("SwarmVault");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ─────────────────────────────────────────────
//  App lifecycle
// ─────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();
  createTray();

  // Register all IPC handlers
  ipcHandlers.register(ipcMain, mainWindow);

  // Start background services
  await storageManager.init();
  // Only auto-start sync when the vault key is available (i.e. the user logged in
  // during this session).  If the app was restarted with a saved authToken but the
  // vault key has not yet been re-derived from the password, we wait — the
  // renderer will show an unlock prompt and call auth:unlock which runs syncClient.init().
  const startupSettings = storageManager.getSettings();
  if (!startupSettings.authToken || isVaultUnlocked()) {
    await syncClient.init();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});

app.on("window-all-closed", () => {
  // Keep app running in tray on all platforms
});
