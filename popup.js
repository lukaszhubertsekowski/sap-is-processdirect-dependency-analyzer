/*
 * SAP IS ProcessDirect Dependency Explorer
 * Copyright (c) 2026 SEKO Consulting - Lukasz Sekowski
 * Contact: lukasz.hubert.sekowski@gmail.com
 * Version: 1.1.1
 * SPDX-License-Identifier: LicenseRef-SEKO-Free-Internal-Use
 */

document.getElementById('openApp').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('app.html');
  await chrome.tabs.create({ url });
  window.close();
});
