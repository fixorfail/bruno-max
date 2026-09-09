const { revealMainWindow } = require('./window');

const fakeWindow = () => ({ show: jest.fn(), showInactive: jest.fn() });

describe('revealing the main window', () => {
  it('shows it, and takes focus, when not under Playwright', () => {
    const win = fakeWindow();
    const app = { dock: { hide: jest.fn() } };

    revealMainWindow(win, { app, env: {} });

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(app.dock.hide).not.toHaveBeenCalled();
  });

  /** The tests drive the page over CDP; a window in front of the developer buys them nothing. */
  it('shows it inactive and off the Dock under Playwright', () => {
    const win = fakeWindow();
    const app = { dock: { hide: jest.fn() } };

    revealMainWindow(win, { app, env: { PLAYWRIGHT: 'true' } });

    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(app.dock.hide).toHaveBeenCalledTimes(1);
  });

  /** Linux and Windows have no Dock; the inactive reveal still applies. */
  it('copes with a platform that has no dock', () => {
    const win = fakeWindow();

    revealMainWindow(win, { app: {}, env: { PLAYWRIGHT: 'true' } });

    expect(win.showInactive).toHaveBeenCalledTimes(1);
  });
});
