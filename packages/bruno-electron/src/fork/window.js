/**
 * How the main window is revealed once it can paint.
 *
 * Under Playwright — `PLAYWRIGHT=true`, which `playwright/index.ts` sets on every launch — the
 * window is shown *inactive* and the app stays off the macOS Dock. Electron has no headless mode,
 * but the tests drive the page over CDP and need neither focus nor the foreground; what a `show()`
 * bought them was a dozen windows each stealing focus from whoever was using the machine while the
 * suite ran. Everywhere else the window is shown exactly as before.
 *
 * `app` and `env` are parameters rather than imports so the rule is testable without Electron.
 */
const revealMainWindow = (mainWindow, { app, env = process.env } = {}) => {
  if (env.PLAYWRIGHT !== 'true') {
    mainWindow.show();
    return;
  }

  if (app && app.dock) {
    app.dock.hide();
  }
  mainWindow.showInactive();
};

module.exports = { revealMainWindow };
