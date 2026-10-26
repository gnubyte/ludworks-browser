// Background entry point (Chrome: MV3 service worker; Firefox: MV3 event page). All listeners are registered
// synchronously at top level so the browser can wake us for them.

import { ext } from '../lib/browser.js';
import { BUILD } from '../lib/build-info.js';
import { ApiError } from '../lib/api.js';
import { createMessageHandler, errorPayload } from './handlers.js';
import { createCore } from './core.js';
import { fillTab } from './autofill.js';
import { CLIPBOARD_ALARM, scheduleClipboardClear, clearClipboard } from './clipboard.js';
import { CAPTURE_ORIGINS, syncCaptureRegistration } from './capture.js';
import { createCertObserver } from './certpin.js';

const AUTOLOCK_ALARM = 'ludworks-autolock';
const TITLE = 'Ludworks Passwords';

const certObserver = createCertObserver(ext);
const core = createCore({
  storage: { local: ext.storage.local, session: ext.storage.session },
  browserName: BUILD.browser,
  version: BUILD.version,
  certObserver,
  emit: onCoreEvent,
});

function onCoreEvent(event) {
  if (event === 'locked' || event === 'logged_out') {
    ext.alarms.clear(AUTOLOCK_ALARM).catch(() => {});
    updateAction(false);
    clearCaptureBadges().catch(() => {}); // pending captures are dropped when locking
  } else if (event === 'unlocked') {
    scheduleAutoLock().catch(() => {});
    updateAction(true);
  }
  // Tell an open popup to refresh. No receiver (popup closed) is normal.
  Promise.resolve()
    .then(() => ext.runtime.sendMessage({ event }))
    .catch(() => {});
}

function updateAction(unlocked) {
  try {
    ext.action.setTitle({ title: unlocked ? TITLE : `${TITLE} (locked)` });
  } catch {
    /* ignore */
  }
}

async function activeTab() {
  const tabs = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

/** @returns {Promise<boolean>} whether the popup could be opened */
async function openPopup() {
  try {
    if (ext.action && typeof ext.action.openPopup === 'function') {
      await ext.action.openPopup();
      return true;
    }
  } catch {
    /* not allowed in this context; the user can click the toolbar button */
  }
  return false;
}

async function flashBadge(tabId, text) {
  try {
    await ext.action.setBadgeBackgroundColor({ color: '#b91c1c', tabId });
    await ext.action.setBadgeText({ text, tabId });
    setTimeout(() => ext.action.setBadgeText({ text: '', tabId }).catch(() => {}), 4000);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------------------- offer-to-save badge

const CAPTURE_BADGE = '+';

/** A captured login waits for the user's decision in the popup (nothing is shown inside the page). */
async function setCaptureBadge(tabId, pending) {
  try {
    if (pending) {
      await ext.action.setBadgeBackgroundColor({ color: '#4f46e5', tabId });
      await ext.action.setBadgeText({ text: CAPTURE_BADGE, tabId });
    } else {
      // leave other badges ("?" / "!" from the fill shortcut) alone
      const current = typeof ext.action.getBadgeText === 'function' ? await ext.action.getBadgeText({ tabId }) : CAPTURE_BADGE;
      if (current === CAPTURE_BADGE) await ext.action.setBadgeText({ text: '', tabId });
    }
  } catch {
    /* tab gone */
  }
}

async function clearCaptureBadges() {
  const tabs = await ext.tabs.query({});
  await Promise.all((tabs || []).map((t) => (typeof t.id === 'number' ? setCaptureBadge(t.id, false) : null)));
}

// ------------------------------------------------------------------------------- auto-lock

async function scheduleAutoLock() {
  const s = await core.autoLockStatus();
  if (s.deadline) await ext.alarms.create(AUTOLOCK_ALARM, { when: s.deadline });
}

function applyIdleInterval(lockMinutes) {
  try {
    ext.idle.setDetectionInterval(Math.max(60, Math.round(lockMinutes * 60)));
  } catch {
    /* ignore */
  }
}

async function noteActivity() {
  if (await core.isUnlocked()) {
    await core.touch();
    await scheduleAutoLock();
  }
}

ext.alarms.onAlarm.addListener((alarm) => {
  (async () => {
    if (alarm.name === AUTOLOCK_ALARM) {
      const s = await core.autoLockStatus();
      if (s.due) await core.lock();
      else if (s.deadline) await ext.alarms.create(AUTOLOCK_ALARM, { when: s.deadline });
    } else if (alarm.name === CLIPBOARD_ALARM) {
      await clearClipboard(ext);
    }
  })().catch(() => {});
});

ext.idle.onStateChanged.addListener((state) => {
  if (state === 'locked' || state === 'idle') core.lock().catch(() => {});
});

// ------------------------------------------------------------------------------- autofill

async function doFill(tab, id, allowInsecure, allowOtherHost = false) {
  if (!tab || typeof tab.id !== 'number' || !tab.url) {
    throw new ApiError({ code: 'no_tab', message: 'No web page is active in this window.' });
  }
  const creds = await core.resolveFill(id, tab.url, { allowOtherHost });
  const res = await fillTab(ext, tab, creds, { allowInsecure });
  await core.markUsed(id);
  return res;
}

/**
 * Fill shortcut: fills without any UI only a login saved for this very host. When the only matches were
 * saved for other hosts of the same site, the popup opens instead (it names the saved host and asks).
 */
async function fillBestMatch(tabArg) {
  const tab = tabArg && typeof tabArg.id === 'number' && tabArg.url ? tabArg : await activeTab();
  if (!tab || !tab.url) return;
  if (!(await core.isUnlocked())) {
    await openPopup();
    return;
  }
  await noteActivity();
  const id = await core.bestMatchFor(tab.url);
  if (!id) {
    const { matches } = await core.listItems({ url: tab.url });
    if (!matches.length || !(await openPopup())) await flashBadge(tab.id, '?');
    return;
  }
  try {
    await doFill(tab, id, false);
  } catch {
    await flashBadge(tab.id, '!');
  }
}

ext.commands.onCommand.addListener((command, tab) => {
  if (command === 'fill-login') fillBestMatch(tab).catch(() => {});
});

// ------------------------------------------------------------------------------- messages

const handleMessage = createMessageHandler({
  core,
  runtimeId: ext.runtime.id,
  extensionOrigin: ext.runtime.getURL(''),
  fill: async (id, allowInsecure, allowOtherHost) => doFill(await activeTab(), id, allowInsecure, allowOtherHost),
  onActivity: noteActivity,
  onCaptureBadge: setCaptureBadge,
  onSettingsChanged: async (patch, s) => {
    if (patch.lockMinutes !== undefined) {
      applyIdleInterval(s.lockMinutes);
      await scheduleAutoLock();
    }
    const active = await syncCaptureRegistration(ext, s.saveLogins);
    if (s.saveLogins && !active) return core.updateSettings({ saveLogins: false });
    return s;
  },
  onClipboardCopied: () => scheduleClipboardClear(ext),
  onClearData: () => syncCaptureRegistration(ext, false),
});

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && typeof msg === 'object' && (msg.target === 'offscreen' || 'event' in msg)) return false;
  handleMessage(msg, sender).then(
    (data) => sendResponse({ ok: true, data: data === undefined ? null : data }),
    (e) => sendResponse({ ok: false, error: errorPayload(e) }),
  );
  return true;
});

// ------------------------------------------------------------------------------- lifecycle

ext.tabs.onRemoved.addListener((tabId) => {
  core.dropPending(tabId).catch(() => {});
});

ext.permissions.onRemoved.addListener((perms) => {
  const origins = (perms && perms.origins) || [];
  if (origins.some((o) => CAPTURE_ORIGINS.includes(o) || o === '<all_urls>')) {
    core
      .updateSettings({ saveLogins: false })
      .then(() => syncCaptureRegistration(ext, false))
      .catch(() => {});
  }
});

ext.runtime.onStartup.addListener(() => {
  // storage.session is already empty after a browser restart; lock explicitly anyway.
  core.lock().catch(() => {});
});

async function init() {
  try {
    if (ext.storage.session.setAccessLevel) {
      await ext.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
  } catch {
    /* Firefox versions without setAccessLevel already restrict session storage */
  }
  const s = await core.getSettings();
  applyIdleInterval(s.lockMinutes);
  await syncCaptureRegistration(ext, s.saveLogins).catch(() => {});
  updateAction(await core.isUnlocked());
}

ext.runtime.onInstalled.addListener(() => {
  init().catch(() => {});
});
init().catch(() => {});
