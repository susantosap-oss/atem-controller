/**
 * System Tray — creates tray icon with context menu.
 * Exposes show/hide window and quit actions.
 */
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;

function createTray(mainWindow) {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    // Resize to 16x16 for tray
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  } catch (_) {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('ATEM Controller Server');

  const updateMenu = (status = 'Disconnected') => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: `ATEM Status: ${status}`,
        enabled: false,
        icon: statusIcon(status),
      },
      { type: 'separator' },
      {
        label: 'Show Window',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        label: 'Hide Window',
        click: () => mainWindow.hide(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  };

  updateMenu();

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  return { tray, updateMenu };
}

function statusIcon(status) {
  // Return a colored circle as NativeImage based on status
  const colors = {
    Connected: '#22c55e',
    Connecting: '#f59e0b',
    Disconnected: '#6b7280',
    Error: '#ef4444',
  };
  const color = colors[status] || colors.Disconnected;
  // 12x12 colored circle as data URI
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">
    <circle cx="6" cy="6" r="5" fill="${color}"/>
  </svg>`;
  try {
    return nativeImage.createFromDataURL(
      'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
    );
  } catch (_) {
    return undefined;
  }
}

module.exports = { createTray };
