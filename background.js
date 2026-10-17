// Inietta (o ri-attiva) l'overlay nella scheda corrente al click sull'icona / Alt+Shift+R.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    // Pagine come chrome://, Chrome Web Store o il PDF viewer non permettono l'iniezione.
    console.warn('Align Ruler: impossibile attivarsi su questa pagina.', err);
  }
});

// Schede con il righello acceso. Sta in storage.session perché il service worker
// viene terminato quando è inattivo e perderebbe le variabili globali.
async function getActiveTabs() {
  const { activeTabs = [] } = await chrome.storage.session.get('activeTabs');
  return activeTabs;
}

async function setActiveTabs(tabs) {
  await chrome.storage.session.set({ activeTabs: tabs });
}

// Il content script segnala lo stato on/off. Un OFF dato dall'utente spegne tutte le altre schede:
// l'interruttore è unico, non per scheda.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || typeof msg?.alignRulerOn !== 'boolean') return;
  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: msg.alignRulerOn ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e0249a' });
  updateTabs(tabId, msg.alignRulerOn, msg.propagate !== false);
});

async function updateTabs(tabId, on, propagate) {
  const tabs = (await getActiveTabs()).filter((id) => id !== tabId);
  if (on) {
    await setActiveTabs([...tabs, tabId]);
    return;
  }
  await setActiveTabs(propagate ? [] : tabs);
  if (!propagate) return;
  for (const id of tabs) {
    // La scheda può aver cambiato pagina nel frattempo: lo script non c'è più, quindi è già spenta.
    chrome.tabs.sendMessage(id, { alignRulerOff: true }).catch(() => {});
    chrome.action.setBadgeText({ tabId: id, text: '' }).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setActiveTabs((await getActiveTabs()).filter((id) => id !== tabId));
});
