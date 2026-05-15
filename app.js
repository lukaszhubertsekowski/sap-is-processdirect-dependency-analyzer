/*
 * SAP IS ProcessDirect Dependency Explorer
 * Copyright (c) 2026 SEKO Consulting - Lukasz Sekowski
 * Contact: lukasz.hubert.sekowski@gmail.com
 * Version: 1.0.8
 *
 * This product is source-available and free for personal, consulting, corporate, and enterprise internal use.
 * Resale, sublicensing, marketplace publication, or inclusion in paid products/services requires prior written permission.
 * SPDX-License-Identifier: LicenseRef-SEKO-Free-Internal-Use
 */

const DEFAULT_CONFIG = {
  uiBaseUrl: '',
  apiBaseUrl: '',
  tokenUrl: '',
  clientId: '',
  clientSecret: '',
  clientAuthMode: 'basic',
  maxDepth: 4
};

const DB_NAME = 'sap-is-processdirect-dependency-db';
const DB_VERSION = 1;
const STORE_IFLOWS = 'iflows';
const STORE_ADAPTERS = 'adapters';
const STORE_META = 'meta';

const state = {
  config: { ...DEFAULT_CONFIG },
  syncAbortController: null,
  lastDiagramModel: null,
  dbView: 'adapters'
};

const $ = (id) => document.getElementById(id);

window.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindActions();
  await loadConfig();
  await refreshDbSummary();
  await populateIflowList();
});

function bindTabs() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('visible'));
      button.classList.add('active');
      $(`tab-${button.dataset.tab}`).classList.add('visible');
    });
  });
}

function bindActions() {
  $('saveConfig').addEventListener('click', saveConfig);
  $('testAuth').addEventListener('click', testAuth);
  $('syncNow').addEventListener('click', syncFromApi);
  $('cancelSync').addEventListener('click', cancelSync);
  $('importZips').addEventListener('click', importLocalZips);
  $('showDownstream').addEventListener('click', () => renderGraph('downstream'));
  $('showUpstream').addEventListener('click', () => renderGraph('upstream'));
  $('generateDiagram').addEventListener('click', generateDependencyDiagram);
  $('downloadDiagramPng').addEventListener('click', downloadDiagramAsPng);
  $('refreshDb').addEventListener('click', refreshDbSummary);
  $('dbSummary').addEventListener('click', handleDbSummaryClick);
  $('dbSummary').addEventListener('keydown', handleDbSummaryKeydown);
  $('exportDb').addEventListener('click', exportDatabaseJson);
  $('clearDb').addEventListener('click', clearDatabaseWithConfirm);
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(['pdExplorerConfig']);
  state.config = { ...DEFAULT_CONFIG, ...(stored.pdExplorerConfig || {}) };
  $('uiBaseUrl').value = state.config.uiBaseUrl || '';
  $('apiBaseUrl').value = state.config.apiBaseUrl || '';
  $('tokenUrl').value = state.config.tokenUrl || '';
  $('clientId').value = state.config.clientId || '';
  $('clientSecret').value = state.config.clientSecret || '';
  $('clientAuthMode').value = state.config.clientAuthMode || 'basic';
  $('maxDepth').value = state.config.maxDepth || 4;
}

async function saveConfig() {
  state.config = readConfigFromForm();
  await chrome.storage.local.set({ pdExplorerConfig: state.config });
  setResult('configResult', 'Configuration saved locally in Chrome extension storage.', 'ok');
}

function readConfigFromForm() {
  return {
    uiBaseUrl: normalizeBaseUrl($('uiBaseUrl').value.trim()),
    apiBaseUrl: normalizeApiBaseUrl($('apiBaseUrl').value.trim()),
    tokenUrl: $('tokenUrl').value.trim(),
    clientId: $('clientId').value.trim(),
    clientSecret: $('clientSecret').value,
    clientAuthMode: $('clientAuthMode').value,
    maxDepth: Math.max(1, Math.min(10, Number($('maxDepth').value || 4)))
  };
}

async function testAuth() {
  try {
    state.config = readConfigFromForm();
    const token = await getAccessToken(state.config);
    setResult('configResult', `OAuth test successful. Access token received (${token.length} characters).`, 'ok');
  } catch (error) {
    setResult('configResult', `OAuth test failed: ${error.message}`, 'error');
  }
}

async function getAccessToken(config) {
  if (!config.tokenUrl) throw new Error('Access Token URL is missing.');
  if (!config.clientId) throw new Error('Client ID is missing.');
  if (!config.clientSecret) throw new Error('Client Secret is missing.');

  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

  if (config.clientAuthMode === 'basic' || config.clientAuthMode === 'both') {
    headers.Authorization = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
  }
  if (config.clientAuthMode === 'body' || config.clientAuthMode === 'both') {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  }

  const response = await fetch(config.tokenUrl, { method: 'POST', headers, body });
  const responseText = await response.text();
  let payload = {};
  try { payload = responseText ? JSON.parse(responseText) : {}; } catch (_) { /* ignore */ }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${payload.error_description || payload.error || responseText}`);
  }
  if (!payload.access_token) throw new Error('Token response does not contain access_token.');
  return payload.access_token;
}

async function syncFromApi() {
  state.config = readConfigFromForm();
  await chrome.storage.local.set({ pdExplorerConfig: state.config });

  const abortController = new AbortController();
  state.syncAbortController = abortController;
  $('syncNow').disabled = true;
  $('cancelSync').disabled = false;
  resetProgress();
  clearLog();

  try {
    log('Starting synchronization from SAP Integration Content API...');
    const token = await getAccessToken(state.config);
    log('OAuth token acquired.');

    const api = createApiClient(state.config, token, abortController.signal);
    const packages = await api.getIntegrationPackages();
    log(`Packages received: ${packages.length}`);

    const nextDb = { iflows: [], adapters: [], meta: {} };
    let artifactTotal = 0;
    const packageArtifacts = [];

    for (let pIndex = 0; pIndex < packages.length; pIndex++) {
      const pkg = normalizePackage(packages[pIndex]);
      setProgress(pIndex / Math.max(1, packages.length) * 25, `Reading package ${pIndex + 1}/${packages.length}: ${pkg.id}`);
      try {
        const artifacts = await api.getPackageIflows(pkg.id);
        const iflowArtifacts = artifacts.map((a) => normalizeArtifact(a)).filter((a) => a.id);
        artifactTotal += iflowArtifacts.length;
        packageArtifacts.push({ pkg, artifacts: iflowArtifacts });
        log(`Package ${pkg.id}: ${iflowArtifacts.length} integration design-time artifacts.`);
      } catch (error) {
        log(`Package ${pkg.id}: failed to read artifacts: ${error.message}`, 'WARN');
      }
    }

    log(`Total iFlow artifacts to download: ${artifactTotal}`);

    let processed = 0;
    for (const { pkg, artifacts } of packageArtifacts) {
      for (const artifact of artifacts) {
        processed += 1;
        const pct = 25 + (processed / Math.max(1, artifactTotal)) * 70;
        setProgress(pct, `Downloading and parsing iFlow ${processed}/${artifactTotal}: ${artifact.id}`);
        try {
          const zipBuffer = await api.getIflowZip(artifact.id, artifact.version || 'active');
          const parsed = await parseIflowZip(zipBuffer, {
            id: artifact.id,
            name: artifact.name || artifact.id,
            version: artifact.version || 'active',
            packageId: pkg.id,
            packageName: pkg.name || pkg.id,
            source: 'SAP_API'
          });
          nextDb.iflows.push(parsed.iflow);
          nextDb.adapters.push(...parsed.adapters);
          log(`Parsed ${artifact.id}: ${parsed.adapters.length} ProcessDirect adapter(s).`);
        } catch (error) {
          log(`Failed to parse ${artifact.id}: ${error.message}`, 'ERROR');
          nextDb.iflows.push({
            id: artifact.id,
            name: artifact.name || artifact.id,
            version: artifact.version || 'active',
            packageId: pkg.id,
            packageName: pkg.name || pkg.id,
            source: 'SAP_API',
            parseStatus: 'ERROR',
            parseError: error.message,
            syncedAt: new Date().toISOString()
          });
        }
      }
    }

    nextDb.meta = {
      lastSyncAt: new Date().toISOString(),
      source: 'SAP_API',
      packages: packages.length,
      iflows: nextDb.iflows.length,
      adapters: nextDb.adapters.length
    };

    await replaceDatabase(nextDb);
    setProgress(100, 'Synchronization completed.');
    log(`Synchronization completed. iFlows: ${nextDb.iflows.length}, ProcessDirect adapters: ${nextDb.adapters.length}.`);
    await refreshDbSummary();
    await populateIflowList();
  } catch (error) {
    if (error.name === 'AbortError') {
      log('Synchronization cancelled by user.', 'WARN');
      setProgress(0, 'Cancelled');
    } else {
      log(`Synchronization failed: ${error.message}`, 'ERROR');
      setProgress(0, 'Failed');
    }
  } finally {
    $('syncNow').disabled = false;
    $('cancelSync').disabled = true;
    state.syncAbortController = null;
  }
}

function cancelSync() {
  if (state.syncAbortController) state.syncAbortController.abort();
}

function createApiClient(config, token, signal) {
  const base = normalizeApiBaseUrl(config.apiBaseUrl);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  };

  async function fetchJson(pathCandidates) {
    const paths = Array.isArray(pathCandidates) ? pathCandidates : [pathCandidates];
    let lastError;
    for (const path of paths) {
      const url = joinUrl(base, pathWithJsonFormat(path));
      try {
        const response = await fetch(url, { headers, signal });
        const text = await response.text();
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
        return normalizeODataList(JSON.parse(text));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async function fetchArrayBuffer(path) {
    const url = joinUrl(base, path);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/zip, application/octet-stream, */*' }, signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    return await response.arrayBuffer();
  }

  return {
    async getIntegrationPackages() {
      return await fetchJson(['/IntegrationPackages()', '/IntegrationPackages']);
    },
    async getPackageIflows(packageId) {
      const id = odataLiteral(packageId);
      return await fetchJson(`/IntegrationPackages(${id})/IntegrationDesigntimeArtifacts`);
    },
    async getIflowZip(iflowId, version) {
      const id = odataLiteral(iflowId);
      const candidates = ['active'];
      if (version && String(version).toLowerCase() !== 'active') candidates.push(version);
      let lastError;
      for (const candidate of candidates) {
        try {
          const ver = odataLiteral(candidate);
          return await fetchArrayBuffer(`/IntegrationDesigntimeArtifacts(Id=${id},Version=${ver})/$value`);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }
  };
}

async function importLocalZips() {
  const files = Array.from($('zipFiles').files || []);
  if (!files.length) {
    log('No local ZIP files selected.', 'WARN');
    return;
  }
  resetProgress();
  clearLog();
  log(`Importing ${files.length} local ZIP file(s)...`);
  const nextDb = { iflows: [], adapters: [], meta: {} };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setProgress((i / files.length) * 95, `Parsing ${file.name}`);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const fallbackId = file.name.replace(/\.zip$/i, '');
      const parsed = await parseIflowZip(arrayBuffer, {
        id: fallbackId,
        name: fallbackId,
        version: 'local',
        packageId: 'LOCAL_IMPORT',
        packageName: 'Local Import',
        source: 'LOCAL_ZIP'
      });
      nextDb.iflows.push(parsed.iflow);
      nextDb.adapters.push(...parsed.adapters);
      log(`Parsed ${file.name}: iFlow=${parsed.iflow.id}, adapters=${parsed.adapters.length}.`);
    } catch (error) {
      log(`Failed to parse ${file.name}: ${error.message}`, 'ERROR');
    }
  }

  nextDb.meta = {
    lastSyncAt: new Date().toISOString(),
    source: 'LOCAL_ZIP',
    packages: 1,
    iflows: nextDb.iflows.length,
    adapters: nextDb.adapters.length
  };
  await replaceDatabase(nextDb);
  setProgress(100, 'Local import completed.');
  await refreshDbSummary();
  await populateIflowList();
}

async function parseIflowZip(zipArrayBuffer, metadata) {
  const files = await unzipTextFiles(zipArrayBuffer, (name) => /\.iflw$/i.test(name) || name === 'src/main/resources/parameters.prop' || name === 'src/main/resources/parameters.propdef' || name === '.project' || name === 'META-INF/MANIFEST.MF');
  const fileNames = Object.keys(files);
  const iflwPath = fileNames.find((n) => /scenarioflows\/integrationflow\/.*\.iflw$/i.test(n)) || fileNames.find((n) => /\.iflw$/i.test(n));
  if (!iflwPath) throw new Error('No .iflw file found in ZIP export.');

  const iflwXml = files[iflwPath];
  const parametersText = files['src/main/resources/parameters.prop'] || '';
  const propdefXml = files['src/main/resources/parameters.propdef'] || '';
  const projectXml = files['.project'] || '';
  const manifestText = files['META-INF/MANIFEST.MF'] || '';

  const parameters = parseProperties(parametersText);
  const paramReferences = parseParameterReferences(propdefXml);
  const projectName = parseProjectName(projectXml);
  const manifestName = parseManifestValue(manifestText, 'Bundle-SymbolicName') || parseManifestValue(manifestText, 'Bundle-Name');

  const iflowIdFromPath = decodeURIComponent(iflwPath.split('/').pop().replace(/\.iflw$/i, ''));
  const iflowId = metadata.id && metadata.source !== 'LOCAL_ZIP' ? metadata.id : (projectName || iflowIdFromPath || metadata.id);
  const iflowName = metadata.name && metadata.name !== metadata.id ? metadata.name : (iflowIdFromPath || metadata.name || iflowId);

  const parsedBpmn = parseProcessDirectAdapters(iflwXml, parameters, paramReferences);
  const syncedAt = new Date().toISOString();

  const iflow = {
    id: iflowId,
    name: iflowName,
    version: metadata.version || 'active',
    packageId: metadata.packageId || '',
    packageName: metadata.packageName || '',
    projectName: projectName || '',
    manifestName: manifestName || '',
    iflwPath,
    source: metadata.source || 'UNKNOWN',
    parameterCount: Object.keys(parameters).length,
    processCount: parsedBpmn.processCount,
    localIntegrationProcessCount: parsedBpmn.localIntegrationProcessCount,
    processCallCount: parsedBpmn.processCallCount,
    parseStatus: 'OK',
    syncedAt
  };

  const adapters = parsedBpmn.adapters.map((a, idx) => ({
    ...a,
    key: `${iflowId}|${a.adapterMessageFlowId || idx}`,
    iflowId,
    iflowName,
    packageId: metadata.packageId || '',
    packageName: metadata.packageName || '',
    version: metadata.version || 'active',
    syncedAt
  }));

  return { iflow, adapters };
}

function parseProcessDirectAdapters(iflwXml, parameters, paramReferences) {
  const xml = parseXml(iflwXml, 'iflw');
  const processIndex = buildProcessIndex(xml);
  const adapters = [];
  const messageFlows = elementsByLocalName(xml, 'messageFlow');

  for (const mf of messageFlows) {
    const props = extractIflProperties(mf);
    if ((props.ComponentType || '').trim() !== 'ProcessDirect') continue;

    const rawAddress = (props.address || '').trim();
    const resolved = resolveAddress(rawAddress, parameters);
    const sourceRef = mf.getAttribute('sourceRef') || '';
    const targetRef = mf.getAttribute('targetRef') || '';
    const location = resolveMessageFlowLocation(sourceRef, targetRef, processIndex, props.direction);
    const direction = normalizeDirection(props.direction || inferDirectionFromCmdUri(props.cmdVariantUri));

    const adapter = {
      adapterMessageFlowId: mf.getAttribute('id') || '',
      adapterName: mf.getAttribute('name') || props.Name || '',
      direction,
      rawAddress,
      resolvedAddress: resolved.value,
      addressSource: resolved.source,
      parameterName: resolved.parameterName,
      parameterReference: resolved.parameterName ? (paramReferences[resolved.parameterName] || null) : null,
      componentType: props.ComponentType || '',
      transportProtocol: props.TransportProtocol || '',
      messageProtocol: props.MessageProtocol || '',
      cmdVariantUri: props.cmdVariantUri || '',
      systemProperty: props.system || '',
      sourceRef,
      targetRef,
      stepRef: location.stepRef || '',
      sourceStepId: location.step?.id || '',
      sourceStepName: location.step?.name || '',
      sourceStepType: location.step?.type || '',
      sourceProcessId: location.process?.id || '',
      sourceProcessName: location.process?.name || '',
      sourceProcessKind: location.process?.kind || '',
      calledFromMainProcess: location.calledFromMainProcess || false,
      mainProcessCallStepId: location.mainProcessCallStep?.id || '',
      mainProcessCallStepName: location.mainProcessCallStep?.name || '',
      properties: props
    };
    adapters.push(adapter);
  }

  return {
    adapters,
    processCount: processIndex.processes.length,
    localIntegrationProcessCount: processIndex.processes.filter((p) => p.kind === 'LOCAL_INTEGRATION_PROCESS').length,
    processCallCount: processIndex.processCalls.length
  };
}

function buildProcessIndex(xml) {
  const participants = elementsByLocalName(xml, 'participant').map((p) => ({
    id: p.getAttribute('id') || '',
    name: p.getAttribute('name') || '',
    processRef: p.getAttribute('processRef') || '',
    type: p.getAttribute('ifl:type') || p.getAttribute('type') || ''
  }));
  const participantByProcessRef = new Map(participants.map((p) => [p.processRef, p]));
  const processes = elementsByLocalName(xml, 'process').map((p, index) => {
    const id = p.getAttribute('id') || '';
    const participant = participantByProcessRef.get(id);
    const name = p.getAttribute('name') || participant?.name || '';
    const isLocal = /local/i.test(name) || /^Process_/.test(id) && index > 0;
    return {
      id,
      name: name || id,
      kind: isLocal ? 'LOCAL_INTEGRATION_PROCESS' : 'MAIN_INTEGRATION_PROCESS',
      element: p,
      participant
    };
  });

  const stepById = new Map();
  const processById = new Map(processes.map((p) => [p.id, p]));
  const processCalls = [];

  for (const process of processes) {
    for (const child of Array.from(process.element.children || [])) {
      const id = child.getAttribute?.('id');
      if (!id) continue;
      const type = child.localName;
      const props = extractIflProperties(child);
      const step = {
        id,
        name: child.getAttribute('name') || props.Name || id,
        type,
        processId: process.id,
        processName: process.name,
        processKind: process.kind,
        properties: props
      };
      stepById.set(id, step);
      if (type === 'callActivity') {
        const calledProcessId = props.processId || props.ProcessId || props.processID || '';
        if (calledProcessId) {
          processCalls.push({
            id,
            name: step.name,
            fromProcessId: process.id,
            fromProcessName: process.name,
            toProcessId: calledProcessId,
            element: child,
            step
          });
        }
      }
    }
  }

  return { participants, processes, processById, stepById, processCalls };
}

function resolveMessageFlowLocation(sourceRef, targetRef, processIndex, direction) {
  // Receiver adapter call usually originates from a service task: sourceRef = step.
  // Sender adapter usually targets a start/message event: targetRef = step.
  // Use any endpoint that maps to a BPMN step; do not filter by main/local process.
  const candidateRefs = normalizeDirection(direction) === 'Sender' ? [targetRef, sourceRef] : [sourceRef, targetRef];
  const stepRef = candidateRefs.find((ref) => processIndex.stepById.has(ref)) || '';
  const step = stepRef ? processIndex.stepById.get(stepRef) : null;
  const process = step ? processIndex.processById.get(step.processId) : null;

  let mainProcessCallStep = null;
  let calledFromMainProcess = false;
  if (process?.kind === 'LOCAL_INTEGRATION_PROCESS') {
    const caller = processIndex.processCalls.find((c) => c.toProcessId === process.id);
    if (caller) {
      calledFromMainProcess = true;
      mainProcessCallStep = caller.step;
    }
  }

  return { stepRef, step, process, calledFromMainProcess, mainProcessCallStep };
}

function extractIflProperties(element) {
  const props = {};
  const propertyElements = Array.from(element.getElementsByTagName('*')).filter((e) => e.localName === 'property');
  for (const property of propertyElements) {
    const keyEl = Array.from(property.children || []).find((c) => c.localName === 'key');
    const valueEl = Array.from(property.children || []).find((c) => c.localName === 'value');
    const key = keyEl?.textContent?.trim();
    if (key) props[key] = valueEl?.textContent?.trim() || '';
  }
  return props;
}

function inferDirectionFromCmdUri(uri) {
  const match = /direction::([^/]+)/i.exec(uri || '');
  return match ? match[1] : '';
}

function normalizeDirection(direction) {
  const d = String(direction || '').toLowerCase();
  if (d.includes('sender')) return 'Sender';
  if (d.includes('receiver')) return 'Receiver';
  return direction || 'Unknown';
}

function resolveAddress(rawAddress, parameters) {
  const raw = String(rawAddress || '').trim();
  const paramMatch = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(raw);
  if (paramMatch) {
    const parameterName = paramMatch[1];
    if (Object.prototype.hasOwnProperty.call(parameters, parameterName)) {
      return { value: String(parameters[parameterName] || '').trim(), source: 'EXTERNALIZED_PARAMETER', parameterName };
    }
    return { value: '', source: 'UNRESOLVED_PARAMETER', parameterName };
  }
  return { value: raw, source: raw ? 'HARDCODED_IFLW' : 'EMPTY', parameterName: null };
}

function parseParameterReferences(propdefXml) {
  const references = {};
  if (!propdefXml?.trim()) return references;
  try {
    const xml = parseXml(propdefXml, 'parameters.propdef');
    const refElements = elementsByLocalName(xml, 'reference');
    for (const ref of refElements) {
      const key = ref.getAttribute('param_key');
      if (!key) continue;
      references[key] = {
        attributeCategory: ref.getAttribute('attribute_category') || '',
        attributeId: ref.getAttribute('attribute_id') || '',
        attributeUiLabel: ref.getAttribute('attribute_uilabel') || ''
      };
    }
  } catch (_) {
    // parameters.propdef may be absent or malformed; parsing still continues.
  }
  return references;
}

function parseProjectName(projectXml) {
  if (!projectXml?.trim()) return '';
  try {
    const xml = parseXml(projectXml, '.project');
    const nameEl = elementsByLocalName(xml, 'name')[0];
    return nameEl?.textContent?.trim() || '';
  } catch (_) {
    return '';
  }
}

function parseManifestValue(manifestText, key) {
  const lines = String(manifestText || '').split(/\r?\n/);
  const prefix = `${key}:`;
  const line = lines.find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}

function parseProperties(text) {
  const result = {};
  const lines = String(text || '').replace(/\\\r?\n/g, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const idx = findPropertySeparator(trimmed);
    if (idx < 0) {
      result[unescapeProperty(trimmed)] = '';
    } else {
      const key = unescapeProperty(trimmed.slice(0, idx).trim());
      const value = unescapeProperty(trimmed.slice(idx + 1).trim());
      result[key] = value;
    }
  }
  return result;
}

function findPropertySeparator(line) {
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '=' || c === ':') return i;
  }
  return -1;
}

function unescapeProperty(value) {
  return String(value || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\f/g, '\f')
    .replace(/\\([:=\\ ])/g, '$1');
}

function parseXml(text, label) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) throw new Error(`Failed to parse XML ${label}: ${parserError.textContent.slice(0, 200)}`);
  return doc;
}

function elementsByLocalName(root, localName) {
  return Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === localName);
}

async function unzipTextFiles(arrayBuffer, includePredicate) {
  const entries = parseZipCentralDirectory(arrayBuffer);
  const result = {};
  for (const entry of entries) {
    if (entry.fileName.endsWith('/')) continue;
    if (includePredicate && !includePredicate(entry.fileName)) continue;
    const bytes = await readZipEntry(arrayBuffer, entry);
    result[entry.fileName] = new TextDecoder('utf-8').decode(bytes);
  }
  return result;
}

function parseZipCentralDirectory(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const maxSearch = Math.max(0, view.byteLength - 0x10000 - 22);
  let eocdOffset = -1;
  for (let i = view.byteLength - 22; i >= maxSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('Invalid ZIP: End of Central Directory not found.');

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  let offset = centralDirOffset;
  const entries = [];
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid ZIP: Central Directory header mismatch.');
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const fileNameBytes = new Uint8Array(arrayBuffer, offset + 46, fileNameLength);
    const fileName = decoder.decode(fileNameBytes);
    entries.push({ fileName, flags, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(arrayBuffer, entry) {
  const view = new DataView(arrayBuffer);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`Invalid ZIP: local header mismatch for ${entry.fileName}`);
  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = new Uint8Array(arrayBuffer, dataStart, entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This Chrome version does not expose DecompressionStream required for ZIP deflate extraction.');
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.fileName}`);
}

async function renderGraph(direction) {
  setDiagramDownloadAvailability(false);
  const rootIflowId = $('currentIflowId').value.trim();
  if (!rootIflowId) {
    $('graphResult').innerHTML = '<div class="empty">Provide current iFlow ID first.</div>';
    return;
  }

  const db = await readDatabaseSnapshot();
  const iflowById = new Map(db.iflows.map((i) => [i.id, i]));
  const adaptersByIflow = groupBy(db.adapters, (a) => a.iflowId);
  const senderByAddress = groupBy(db.adapters.filter((a) => a.direction === 'Sender' && a.resolvedAddress), (a) => normalizeAddressKey(a.resolvedAddress));
  const receiverByAddress = groupBy(db.adapters.filter((a) => a.direction === 'Receiver' && a.resolvedAddress), (a) => normalizeAddressKey(a.resolvedAddress));
  const maxDepth = state.config.maxDepth || 4;
  const warnings = [];

  const root = buildDependencyTree({
    rootIflowId,
    direction,
    depth: 0,
    maxDepth,
    iflowById,
    adaptersByIflow,
    senderByAddress,
    receiverByAddress,
    path: [],
    warnings
  });

  renderWarnings(warnings);
  $('graphResult').innerHTML = renderTreeHtml(root, direction);
}


async function generateDependencyDiagram() {
  setDiagramDownloadAvailability(false);
  const rootIflowId = $('currentIflowId').value.trim();
  if (!rootIflowId) {
    $('graphResult').innerHTML = '<div class="empty">Provide current iFlow ID first.</div>';
    return;
  }

  const db = await readDatabaseSnapshot();
  const context = createDependencyContext(db);
  const warnings = [];
  const model = buildBidirectionalDiagramModel({
    rootIflowId,
    ...context,
    maxDepth: state.config.maxDepth || 4,
    warnings
  });

  state.lastDiagramModel = model;
  renderWarnings(warnings);
  $('graphResult').innerHTML = renderDependencyDiagramHtml(model);
  bindDiagramZoomControls();
  bindDiagramNodeLinks();
  setDiagramDownloadAvailability(true);
}


function createDependencyContext(db) {
  const iflowById = new Map(db.iflows.map((i) => [i.id, i]));
  const adaptersByIflow = groupBy(db.adapters, (a) => a.iflowId);
  const senderByAddress = groupBy(db.adapters.filter((a) => a.direction === 'Sender' && a.resolvedAddress), (a) => normalizeAddressKey(a.resolvedAddress));
  const receiverByAddress = groupBy(db.adapters.filter((a) => a.direction === 'Receiver' && a.resolvedAddress), (a) => normalizeAddressKey(a.resolvedAddress));
  return { iflowById, adaptersByIflow, senderByAddress, receiverByAddress };
}

function buildBidirectionalDiagramModel(ctx) {
  const { rootIflowId, iflowById, adaptersByIflow, senderByAddress, receiverByAddress, maxDepth, warnings } = ctx;
  const nodes = new Map();
  const edges = [];

  function addNode(iflowId, side, level) {
    const safeLevel = side === 'root' ? 0 : level;
    const key = side === 'root' ? 'root' : `${side}:${safeLevel}:${iflowId}`;
    if (!nodes.has(key)) {
      const iflow = iflowById.get(iflowId) || { id: iflowId, name: iflowId, packageId: '' };
      nodes.set(key, {
        key,
        iflow,
        side,
        level: safeLevel,
        column: side === 'upstream' ? -safeLevel : side === 'downstream' ? safeLevel : 0
      });
    }
    return key;
  }

  function addMissingTargetNode(adapter, side, level) {
    const address = adapter.resolvedAddress || adapter.rawAddress || 'unknown-address';
    const key = `missing:${side}:${level}:${adapter.iflowId}:${adapter.adapterMessageFlowId}:${address}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        iflow: {
          id: address,
          name: 'Missing target iFlow',
          packageId: '',
          missingReason: 'Missing target'
        },
        side,
        level,
        column: side === 'upstream' ? -level : level,
        missingTarget: true
      });
    }
    return key;
  }

  const rootKey = addNode(rootIflowId, 'root', 0);

  function walk(currentIflowId, currentKey, side, level, path) {
    if (level > maxDepth) return;
    const currentAdapters = adaptersByIflow.get(currentIflowId) || [];
    const outboundAdapters = side === 'downstream'
      ? currentAdapters.filter((a) => a.direction === 'Receiver')
      : currentAdapters.filter((a) => a.direction === 'Sender');

    for (const adapter of outboundAdapters) {
      if (!adapter.resolvedAddress) {
        warnings.push(`${currentIflowId}: ${adapter.direction} adapter ${adapter.adapterName || adapter.adapterMessageFlowId} has unresolved/empty address ${adapter.rawAddress || ''}.`);
        continue;
      }

      const addressKey = normalizeAddressKey(adapter.resolvedAddress);
      const matches = side === 'downstream'
        ? (senderByAddress.get(addressKey) || [])
        : (receiverByAddress.get(addressKey) || []);
      const realMatches = matches.filter((m) => !(m.iflowId === adapter.iflowId && m.adapterMessageFlowId === adapter.adapterMessageFlowId));

      if (realMatches.length === 0) {
        if (side === 'downstream') {
          warnings.push({
            severity: 'error',
            text: `${currentIflowId}: missing target iFlow. Receiver ProcessDirect address ${adapter.resolvedAddress} does not match any Sender adapter in the synchronized database.`
          });
          const missingKey = addMissingTargetNode(adapter, side, level);
          const edge = {
            from: currentKey,
            to: missingKey,
            side,
            address: adapter.resolvedAddress,
            fromAdapter: adapter,
            toAdapter: null,
            missingTarget: true
          };
          const edgeKey = `${edge.from}|${edge.to}|${edge.address}|missing-target`;
          if (!edges.some((e) => e.key === edgeKey)) edges.push({ ...edge, key: edgeKey });
        }
        continue;
      }
      for (const match of realMatches) {
        const nextIflowId = match.iflowId;
        const nextKey = addNode(nextIflowId, side, level);
        const edge = {
          from: side === 'downstream' ? currentKey : nextKey,
          to: side === 'downstream' ? nextKey : currentKey,
          side,
          address: adapter.resolvedAddress,
          fromAdapter: side === 'downstream' ? adapter : match,
          toAdapter: side === 'downstream' ? match : adapter
        };
        const edgeKey = `${edge.from}|${edge.to}|${edge.address}|${side}`;
        if (!edges.some((e) => e.key === edgeKey)) edges.push({ ...edge, key: edgeKey });

        if (path.includes(nextIflowId)) {
          warnings.push(`Cycle detected at iFlow ${nextIflowId}; diagram branch was stopped.`);
          continue;
        }
        walk(nextIflowId, nextKey, side, level + 1, [...path, currentIflowId]);
      }
    }
  }

  walk(rootIflowId, rootKey, 'upstream', 1, []);
  walk(rootIflowId, rootKey, 'downstream', 1, []);

  return { rootIflowId, nodes: Array.from(nodes.values()), edges, maxDepth };
}

function renderDependencyDiagramHtml(model) {
  const layout = calculateDiagramLayout(model);
  const rootNode = layout.nodes.find((n) => n.key === 'root');
  const upstreamCount = layout.nodes.filter((n) => n.side === 'upstream' && !n.missingTarget).length;
  const downstreamCount = layout.nodes.filter((n) => n.side === 'downstream' && !n.missingTarget).length;
  const missingTargetCount = layout.nodes.filter((n) => n.missingTarget).length;
  const edgeCount = layout.edges.length;
  const incomingAddresses = collectIncomingDiagramAddresses(layout.edges);

  const nodeHtml = layout.nodes.map((node) => {
    const iflow = node.iflow;
    const url = node.missingTarget ? '' : buildIflowUrl(iflow);
    const sideLabel = node.missingTarget ? 'missing target' : (node.side === 'root' ? 'selected' : `${node.side} L${node.level}`);
    const packageLine = node.missingTarget
      ? `<div class="diagram-node-package issue-text"><span>Issue:</span> ${escapeHtml(iflow.missingReason || 'No matching target Sender adapter found.')}</div>`
      : (iflow.packageId ? `<div class="diagram-node-package"><span>Package:</span> ${escapeHtml(iflow.packageId)}</div>` : '');
    const addressList = incomingAddresses.get(node.key) || [];
    const addressHtml = node.side === 'root' || addressList.length === 0
      ? ''
      : `<div class="diagram-node-links">${addressList.map((address) => `<span title="${escapeAttr(address)}">via ${escapeHtml(address)}</span>`).join('')}</div>`;
    const content = `
      <div class="diagram-node-header">
        <div class="diagram-node-title">${escapeHtml(iflow.name || iflow.id)}</div>
        <span class="diagram-node-badge ${escapeAttr(node.side)}">${escapeHtml(sideLabel)}</span>
      </div>
      <div class="diagram-node-id"><span>ID:</span> ${escapeHtml(iflow.id)}</div>
      ${packageLine}
      ${addressHtml}`;
    const style = `left:${node.x}px;top:${node.y}px;width:${layout.nodeWidth}px;min-height:${layout.nodeHeight}px;`;
    const nodeClasses = `diagram-node ${node.missingTarget ? 'missing-target' : escapeAttr(node.side)}`;
    if (url) {
      return `<div class="${nodeClasses} diagram-node-clickable" data-url="${escapeAttr(url)}" role="link" tabindex="0" title="Open iFlow in SAP Integration Suite" style="${style}">${content}<div class="diagram-open-hint">Open iFlow ↗</div></div>`;
    }
    return `<div class="${nodeClasses}" style="${style}">${content}</div>`;
  }).join('');

  const edgePaths = layout.edges.map((edge) => {
    const from = layout.nodeByKey.get(edge.from);
    const to = layout.nodeByKey.get(edge.to);
    if (!from || !to) return '';
    const sx = from.x + layout.nodeWidth;
    const sy = from.y + layout.nodeHeight / 2;
    const tx = to.x;
    const ty = to.y + layout.nodeHeight / 2;
    const midX = sx + Math.max(80, (tx - sx) / 2);
    const path = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`;
    return `<path class="diagram-edge ${edge.missingTarget ? 'missing-target' : escapeAttr(edge.side)}" d="${path}" marker-end="url(#arrowHead)" />`;
  }).join('');

  const emptyNote = edgeCount === 0
    ? '<div class="empty">No upstream or downstream ProcessDirect dependencies found for the selected iFlow.</div>'
    : '';

  return `
    <div class="diagram-summary">
      <strong>${escapeHtml(rootNode?.iflow?.name || model.rootIflowId)}</strong>
      <span>${upstreamCount} upstream iFlow(s)</span>
      <span>${downstreamCount} downstream iFlow(s)</span>
      <span>${edgeCount} ProcessDirect connection(s)</span>
      ${missingTargetCount ? `<span class="diagram-summary-error">${missingTargetCount} missing target(s)</span>` : ''}
      <span>Connection addresses are shown inside target iFlow cards to avoid label overlap.</span>
    </div>
    ${emptyNote}
    <div class="diagram-toolbar" aria-label="Diagram zoom controls">
      <button type="button" id="diagramZoomOut" class="zoom-button" title="Zoom out">−</button>
      <button type="button" id="diagramZoomReset" class="zoom-button" title="Reset zoom">100%</button>
      <button type="button" id="diagramZoomIn" class="zoom-button" title="Zoom in">+</button>
      <button type="button" id="diagramZoomFit" class="zoom-button" title="Fit diagram to frame width">Fit width</button>
      <button type="button" id="diagramDownloadPng" class="zoom-button download-button" title="Download the current diagram as PNG">Download PNG</button>
      <span id="diagramZoomValue" class="diagram-zoom-value">100%</span>
      <span class="diagram-zoom-hint">Tip: hold Ctrl and use mouse wheel inside the frame.</span>
    </div>
    <div class="diagram-scroll" id="diagramViewport">
      <div class="diagram-zoom-layer" id="diagramZoomLayer" data-base-width="${layout.width}" data-base-height="${layout.height}" data-scale="1" style="width:${layout.width}px;height:${layout.height}px;">
        <div class="diagram-canvas" id="diagramCanvas" style="width:${layout.width}px;height:${layout.height}px;">
          <svg class="diagram-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">
            <defs>
              <marker id="arrowHead" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
                <path d="M 0 0 L 9 4.5 L 0 9 z" class="diagram-arrow" />
              </marker>
            </defs>
            ${edgePaths}
          </svg>
          ${nodeHtml}
        </div>
      </div>
    </div>`;
}


function setDiagramDownloadAvailability(enabled) {
  const button = $('downloadDiagramPng');
  if (button) button.disabled = !enabled;
}

async function downloadDiagramAsPng() {
  const diagramCanvas = $('diagramCanvas');
  const zoomLayer = $('diagramZoomLayer');
  if (!diagramCanvas || !zoomLayer) {
    alert('Generate the diagram first, then download it as PNG.');
    setDiagramDownloadAvailability(false);
    return;
  }

  const baseWidth = Math.max(1, Math.ceil(Number(zoomLayer.dataset.baseWidth || diagramCanvas.offsetWidth || diagramCanvas.scrollWidth)));
  const baseHeight = Math.max(1, Math.ceil(Number(zoomLayer.dataset.baseHeight || diagramCanvas.offsetHeight || diagramCanvas.scrollHeight)));
  const exportScale = Math.min(3, Math.max(2, window.devicePixelRatio || 1));

  const clone = diagramCanvas.cloneNode(true);
  clone.id = 'diagramCanvasExport';
  clone.style.width = `${baseWidth}px`;
  clone.style.height = `${baseHeight}px`;
  clone.style.transform = 'none';
  clone.style.position = 'relative';
  clone.style.background = '#fbfcfe';

  // Keep export deterministic: links are rendered as normal cards, not active browser links.
  clone.querySelectorAll('a.diagram-node').forEach((link) => {
    link.removeAttribute('target');
    link.removeAttribute('rel');
  });

  const css = getDiagramExportCss();
  const xhtml = `
    <div xmlns="http://www.w3.org/1999/xhtml" class="diagram-export-root">
      <style>${css}</style>
      ${clone.outerHTML}
    </div>`;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${baseWidth}" height="${baseHeight}" viewBox="0 0 ${baseWidth} ${baseHeight}">
      <foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject>
    </svg>`;

  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadImage(svgUrl);
    const output = document.createElement('canvas');
    output.width = Math.ceil(baseWidth * exportScale);
    output.height = Math.ceil(baseHeight * exportScale);
    const ctx = output.getContext('2d');
    ctx.fillStyle = '#fbfcfe';
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.scale(exportScale, exportScale);
    ctx.drawImage(image, 0, 0, baseWidth, baseHeight);

    const pngBlob = await canvasToPngBlob(output);
    const rootIflowId = sanitizeFileName($('currentIflowId')?.value || 'iflow');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(pngBlob, `sap-is-processdirect-diagram-${rootIflowId}-${timestamp}.png`);
  } catch (error) {
    alert(`PNG export failed: ${error.message}`);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function getDiagramExportCss() {
  const css = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules || [])) css.push(rule.cssText);
    } catch (error) {
      // Ignore inaccessible stylesheets. Extension-local stylesheets are accessible.
    }
  }
  css.push(`
    .diagram-export-root { --bg: #f6f8fb; --panel: #ffffff; --text: #172033; --muted: #5d697c; --border: #d9e0eb; --primary: #0a6ed1; --primary-dark: #0854a0; --secondary: #354a5f; --danger: #bb0000; --ok: #107e3e; --warn-bg: #fff4ce; --warn: #8a6a00; --shadow: 0 12px 32px rgba(23, 32, 51, 0.08); margin: 0; width: 100%; height: 100%; background: #fbfcfe; font-family: Arial, Helvetica, sans-serif; }
    #diagramCanvasExport { transform: none !important; }
    #diagramCanvasExport .diagram-node { box-sizing: border-box; }
    #diagramCanvasExport .diagram-node:hover { border-color: var(--border); box-shadow: 0 8px 22px rgba(23,32,51,0.08); }
  `);
  return css.join('\n');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not render the diagram image.'));
    image.src = url;
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not create PNG file.'));
    }, 'image/png');
  });
}

function sanitizeFileName(value) {
  return String(value || 'iflow')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'iflow';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openExternalUrl(url) {
  if (!url) return;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      });
      return;
    }
  } catch (error) {
    console.warn('Could not open URL through chrome.tabs.create, falling back to window.open.', error);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function bindDiagramNodeLinks() {
  const canvas = $('diagramCanvas');
  if (!canvas) return;

  canvas.querySelectorAll('.diagram-node-clickable').forEach((node) => {
    const url = node.dataset.url;
    if (!url) return;

    node.addEventListener('click', (event) => {
      const interactiveElement = event.target.closest('a, button, input, textarea, select');
      if (interactiveElement) return;
      event.preventDefault();
      openExternalUrl(url);
    });

    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openExternalUrl(url);
    });
  });
}

function bindDiagramZoomControls() {
  const viewport = $('diagramViewport');
  const layer = $('diagramZoomLayer');
  const canvas = $('diagramCanvas');
  const value = $('diagramZoomValue');
  const zoomIn = $('diagramZoomIn');
  const zoomOut = $('diagramZoomOut');
  const zoomReset = $('diagramZoomReset');
  const zoomFit = $('diagramZoomFit');
  const downloadPng = $('diagramDownloadPng');
  if (!viewport || !layer || !canvas || !value) return;

  const baseWidth = Number(layer.dataset.baseWidth || 0);
  const baseHeight = Number(layer.dataset.baseHeight || 0);
  if (!baseWidth || !baseHeight) return;

  let scale = Number(layer.dataset.scale || 1);
  const minScale = 0.25;
  const maxScale = 3;
  const step = 0.15;

  function applyZoom(nextScale, keepViewportCenter = true) {
    const previousScale = scale;
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / previousScale;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / previousScale;

    scale = Math.max(minScale, Math.min(maxScale, Number(nextScale.toFixed(3))));
    layer.dataset.scale = String(scale);
    layer.style.width = `${Math.ceil(baseWidth * scale)}px`;
    layer.style.height = `${Math.ceil(baseHeight * scale)}px`;
    canvas.style.transform = `scale(${scale})`;
    value.textContent = `${Math.round(scale * 100)}%`;

    if (zoomOut) zoomOut.disabled = scale <= minScale + 0.001;
    if (zoomIn) zoomIn.disabled = scale >= maxScale - 0.001;

    if (keepViewportCenter) {
      viewport.scrollLeft = Math.max(0, centerX * scale - viewport.clientWidth / 2);
      viewport.scrollTop = Math.max(0, centerY * scale - viewport.clientHeight / 2);
    }
  }

  zoomIn?.addEventListener('click', () => applyZoom(scale + step));
  zoomOut?.addEventListener('click', () => applyZoom(scale - step));
  zoomReset?.addEventListener('click', () => applyZoom(1));
  downloadPng?.addEventListener('click', downloadDiagramAsPng);
  zoomFit?.addEventListener('click', () => {
    const availableWidth = Math.max(300, viewport.clientWidth - 32);
    applyZoom(Math.min(1, availableWidth / baseWidth), false);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  });
  viewport.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    applyZoom(scale + (event.deltaY < 0 ? step : -step));
  }, { passive: false });

  applyZoom(1, false);
}



async function downloadDiagramAsPng() {
  const model = state.lastDiagramModel;
  if (!model) {
    alert('Generate the diagram first.');
    return;
  }

  const layout = calculateDiagramLayout(model);
  const incomingAddresses = collectIncomingDiagramAddresses(layout.edges);
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(layout.width * scale);
  canvas.height = Math.ceil(layout.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    alert('Could not create PNG canvas.');
    return;
  }

  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.width, layout.height);

  drawCanvasDiagramEdges(ctx, layout);
  for (const node of layout.nodes) {
    drawCanvasDiagramNode(ctx, node, incomingAddresses, layout.nodeWidth);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    alert('Could not export diagram as PNG.');
    return;
  }

  const fileName = `processdirect-dependencies-${sanitizeFilename(model.rootIflowId || 'diagram')}.png`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawCanvasDiagramEdges(ctx, layout) {
  for (const edge of layout.edges) {
    const from = layout.nodeByKey.get(edge.from);
    const to = layout.nodeByKey.get(edge.to);
    if (!from || !to) continue;

    const sx = from.x + layout.nodeWidth;
    const sy = from.y + Math.max(layout.nodeHeight, from.height) / 2;
    const tx = to.x;
    const ty = to.y + Math.max(layout.nodeHeight, to.height) / 2;
    const midX = sx + Math.max(80, (tx - sx) / 2);
    const color = edge.side === 'upstream' ? '#1f7a49' : '#6e7d90';

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(midX, sy, midX, ty, tx, ty);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    drawCanvasArrowHead(ctx, tx, ty, Math.atan2(ty - sy, tx - midX), color);
    ctx.restore();
  }
}

function drawCanvasArrowHead(ctx, x, y, angle, color) {
  const size = 9;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, size / 2);
  ctx.lineTo(-size, -size / 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawCanvasDiagramNode(ctx, node, incomingAddresses, nodeWidth) {
  const x = node.x;
  const y = node.y;
  const w = nodeWidth;
  const h = Math.max(138, node.height || 138);
  const accent = node.side === 'root' ? '#0a6ed1' : node.side === 'upstream' ? '#107e3e' : '#b45f06';
  const badgeFill = node.side === 'root' ? '#edf5ff' : node.side === 'upstream' ? '#eef9f1' : '#fff3e8';
  const badgeStroke = node.side === 'root' ? '#c9e4ff' : node.side === 'upstream' ? '#ccebd6' : '#ffdcb8';
  const badgeText = node.side === 'root' ? '#154b92' : node.side === 'upstream' ? '#107e3e' : '#b45f06';

  ctx.save();
  drawRoundedRect(ctx, x, y, w, h, 16, node.side === 'root' ? '#f5faff' : '#ffffff', node.side === 'root' ? '#0a6ed1' : '#d7dfea', node.side === 'root' ? 2 : 1);
  if (node.side !== 'root') {
    drawRoundedRect(ctx, x, y, 5, h, 16, accent, accent, 1, true);
  }
  ctx.restore();

  const sideLabel = node.side === 'root' ? 'selected' : `${node.side} L${node.level}`;
  ctx.font = '700 14px Arial';
  const badgeWidth = Math.min(118, Math.max(68, ctx.measureText(sideLabel).width + 18));
  const badgeHeight = 24;
  const badgeX = x + w - 14 - badgeWidth;
  const badgeY = y + 12;
  drawRoundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 999, badgeFill, badgeStroke, 1);
  ctx.fillStyle = badgeText;
  ctx.font = '11px Arial';
  ctx.textBaseline = 'middle';
  ctx.fillText(sideLabel, badgeX + 9, badgeY + badgeHeight / 2);

  const titleX = x + 14;
  const titleY = y + 17;
  const titleMaxWidth = Math.max(120, badgeX - titleX - 10);
  ctx.fillStyle = '#16212f';
  ctx.font = '700 14px Arial';
  const titleLines = wrapCanvasText(ctx, String(node.iflow?.name || node.iflow?.id || ''), titleMaxWidth, 3);
  drawCanvasTextLines(ctx, titleLines, titleX, titleY, 18, '#16212f');

  let cursorY = titleY + titleLines.length * 18 + 2;
  ctx.font = '11px Arial';
  ctx.fillStyle = '#3e4b5d';
  ctx.fillText('ID:', titleX, cursorY + 10);
  ctx.font = '11px Consolas, Monaco, monospace';
  const idLines = wrapCanvasText(ctx, String(node.iflow?.id || ''), w - 28, 3);
  drawCanvasTextLines(ctx, idLines, titleX + 22, cursorY, 15, '#617387');
  cursorY += Math.max(18, idLines.length * 15) + 3;

  if (node.iflow?.packageId) {
    ctx.font = '11px Arial';
    ctx.fillStyle = '#3e4b5d';
    ctx.fillText('Package:', titleX, cursorY + 10);
    ctx.font = '11px Arial';
    const pkgLines = wrapCanvasText(ctx, String(node.iflow.packageId), w - 74, 3);
    drawCanvasTextLines(ctx, pkgLines, titleX + 60, cursorY, 15, '#617387');
    cursorY += Math.max(18, pkgLines.length * 15) + 6;
  }

  const addresses = node.side === 'root' ? [] : (incomingAddresses.get(node.key) || []);
  if (addresses.length) {
    ctx.font = '10.5px Consolas, Monaco, monospace';
    for (const address of addresses.slice(0, 6)) {
      const pillLines = wrapCanvasText(ctx, `via ${address}`, w - 42, 2);
      const pillHeight = Math.max(22, 10 + pillLines.length * 13);
      drawRoundedRect(ctx, titleX, cursorY, w - 28, pillHeight, 999, '#eef2f7', '#d7dfea', 1);
      drawCanvasTextLines(ctx, pillLines, titleX + 8, cursorY + 6, 13, '#263548');
      cursorY += pillHeight + 6;
    }
  }
}

function drawRoundedRect(ctx, x, y, w, h, r, fill, stroke, lineWidth, leftStripOnly = false) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.save();
  ctx.beginPath();
  if (leftStripOnly) {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, Math.min(radius, 4));
    ctx.arcTo(x + w, y + h, x, y + h, Math.min(radius, 4));
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
  }
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke && lineWidth > 0) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  ctx.restore();
}

function wrapCanvasText(ctx, text, maxWidth, maxLines = 99) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
      if (lines.length >= maxLines) return trimCanvasLines(ctx, lines, maxWidth, maxLines);
    }
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
      continue;
    }
    let chunk = '';
    for (const ch of word) {
      const chunkCandidate = `${chunk}${ch}`;
      if (ctx.measureText(chunkCandidate).width <= maxWidth) {
        chunk = chunkCandidate;
      } else {
        lines.push(chunk);
        if (lines.length >= maxLines) return trimCanvasLines(ctx, lines, maxWidth, maxLines);
        chunk = ch;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return trimCanvasLines(ctx, lines, maxWidth, maxLines);
}

function trimCanvasLines(ctx, lines, maxWidth, maxLines) {
  const limited = lines.slice(0, maxLines);
  if (lines.length <= maxLines) return limited;
  let last = limited[maxLines - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1);
  }
  limited[maxLines - 1] = `${last}…`;
  return limited;
}

function drawCanvasTextLines(ctx, lines, x, y, lineHeight, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, y + i * lineHeight);
  }
  ctx.restore();
}

function sanitizeFilename(value) {
  return String(value || 'diagram').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'diagram';
}

function collectIncomingDiagramAddresses(edges) {
  const incoming = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    const addresses = incoming.get(edge.to);
    if (edge.address && !addresses.includes(edge.address)) addresses.push(edge.address);
  }
  return incoming;
}

function estimateDiagramNodeHeight(node, incomingCount) {
  const name = String(node.iflow?.name || node.iflow?.id || '');
  const id = String(node.iflow?.id || '');
  const pkg = String(node.iflow?.packageId || '');
  const longestText = Math.max(name.length, id.length, pkg.length);
  const wrappedLines = Math.max(1, Math.ceil(longestText / 42));
  const baseHeight = 118;
  const textHeight = Math.max(0, wrappedLines - 2) * 18;
  const addressHeight = incomingCount > 0 ? 30 + Math.max(0, incomingCount - 1) * 24 : 0;
  return Math.min(230, baseHeight + textHeight + addressHeight);
}

function calculateDiagramLayout(model) {
  const nodeWidth = 380;
  const minNodeHeight = 138;
  const colGap = 270;
  const rowGap = 72;
  const paddingX = 44;
  const paddingY = 44;
  const nodes = model.nodes.slice();
  const columns = new Map();
  const incomingAddresses = collectIncomingDiagramAddresses(model.edges);

  for (const node of nodes) {
    node.height = Math.max(minNodeHeight, estimateDiagramNodeHeight(node, (incomingAddresses.get(node.key) || []).length));
    if (!columns.has(node.column)) columns.set(node.column, []);
    columns.get(node.column).push(node);
  }

  const sortedColumns = Array.from(columns.keys()).sort((a, b) => a - b);
  const columnHeights = Array.from(columns.values()).map((items) => items.reduce((sum, node) => sum + node.height, 0) + Math.max(0, items.length - 1) * rowGap);
  const maxColumnHeight = Math.max(...columnHeights, minNodeHeight);
  const width = paddingX * 2 + sortedColumns.length * nodeWidth + Math.max(0, sortedColumns.length - 1) * colGap;
  const height = paddingY * 2 + maxColumnHeight;

  sortedColumns.forEach((column, colIndex) => {
    const items = columns.get(column);
    items.sort((a, b) => `${a.level}|${a.iflow.name || ''}|${a.iflow.id}`.localeCompare(`${b.level}|${b.iflow.name || ''}|${b.iflow.id}`));
    const columnHeight = items.reduce((sum, node) => sum + node.height, 0) + Math.max(0, items.length - 1) * rowGap;
    let y = paddingY + (maxColumnHeight - columnHeight) / 2;
    const x = paddingX + colIndex * (nodeWidth + colGap);
    items.forEach((node) => {
      node.x = x;
      node.y = y;
      y += node.height + rowGap;
    });
  });

  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  return { nodes, edges: model.edges, nodeByKey, width, height, nodeWidth, nodeHeight: minNodeHeight };
}

function buildDependencyTree(ctx) {
  const { rootIflowId, direction, depth, maxDepth, iflowById, adaptersByIflow, senderByAddress, receiverByAddress, path, warnings } = ctx;
  const iflow = iflowById.get(rootIflowId) || { id: rootIflowId, name: rootIflowId };
  const node = {
    iflow,
    depth,
    edges: [],
    children: [],
    cycle: path.includes(rootIflowId),
    truncated: depth >= maxDepth
  };

  if (node.cycle) {
    warnings.push(`Cycle detected at iFlow ${rootIflowId}; branch was stopped.`);
    return node;
  }
  if (depth >= maxDepth) return node;

  const currentAdapters = adaptersByIflow.get(rootIflowId) || [];
  const outboundAdapters = direction === 'downstream'
    ? currentAdapters.filter((a) => a.direction === 'Receiver')
    : currentAdapters.filter((a) => a.direction === 'Sender');

  for (const adapter of outboundAdapters) {
    if (!adapter.resolvedAddress) {
      warnings.push(`${rootIflowId}: ${adapter.direction} adapter ${adapter.adapterName || adapter.adapterMessageFlowId} has unresolved/empty address ${adapter.rawAddress || ''}.`);
      continue;
    }
    const addressKey = normalizeAddressKey(adapter.resolvedAddress);
    const matches = direction === 'downstream'
      ? (senderByAddress.get(addressKey) || [])
      : (receiverByAddress.get(addressKey) || []);
    const realMatches = matches.filter((m) => !(m.iflowId === adapter.iflowId && m.adapterMessageFlowId === adapter.adapterMessageFlowId));

    if (realMatches.length === 0) {
      if (direction === 'downstream') {
        node.edges.push({ adapter, match: null, address: adapter.resolvedAddress, unresolved: true, missingTarget: true });
        warnings.push({
          severity: 'error',
          text: `${rootIflowId}: missing target iFlow. Receiver ProcessDirect address ${adapter.resolvedAddress} does not match any Sender adapter in the synchronized database.`
        });
      }
      continue;
    }
    for (const match of realMatches) {
      const child = buildDependencyTree({
        ...ctx,
        rootIflowId: match.iflowId,
        depth: depth + 1,
        path: [...path, rootIflowId]
      });
      node.edges.push({ adapter, match, address: adapter.resolvedAddress, unresolved: false });
      node.children.push({ edge: { adapter, match, address: adapter.resolvedAddress }, node: child });
    }
  }

  return node;
}

function renderWarnings(warnings) {
  $('graphWarnings').innerHTML = warnings.map((warning) => {
    const normalized = normalizeWarning(warning);
    return `<div class="warning ${escapeAttr(normalized.severity)}">${escapeHtml(normalized.text)}</div>`;
  }).join('');
}

function normalizeWarning(warning) {
  if (warning && typeof warning === 'object') {
    return {
      severity: warning.severity || 'warning',
      text: warning.text || ''
    };
  }
  return { severity: 'warning', text: String(warning || '') };
}

function renderTreeHtml(root, direction) {
  if (!root.iflow?.id) return '<div class="empty">No graph data available.</div>';
  return renderNode(root, direction);
}

function renderNode(node, direction) {
  const iflow = node.iflow;
  const url = buildIflowUrl(iflow);
  const title = url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(iflow.name || iflow.id)}</a>` : escapeHtml(iflow.name || iflow.id);
  const badges = [];
  if (node.depth === 0) badges.push('<span class="badge">root</span>');
  if (node.cycle) badges.push('<span class="badge unresolved">cycle</span>');
  if (node.truncated) badges.push('<span class="badge unresolved">max depth</span>');

  const meta = [
    `iFlow ID: <code>${escapeHtml(iflow.id)}</code>`,
    iflow.packageId ? `Package: <code>${escapeHtml(iflow.packageId)}</code>` : '',
    iflow.localIntegrationProcessCount ? `Local Integration Processes: ${iflow.localIntegrationProcessCount}` : ''
  ].filter(Boolean).join('<br/>');

  const children = node.children.map(({ edge, node: child }) => {
    const adapter = edge.adapter;
    const match = edge.match;
    const location = adapter.sourceProcessName ? ` from ${adapter.sourceProcessKind === 'LOCAL_INTEGRATION_PROCESS' ? 'Local Integration Process' : 'Integration Process'}: ${adapter.sourceProcessName}` : '';
    const edgeHtml = `
      <div class="node-meta">
        <div>${direction === 'downstream' ? 'Receiver call' : 'Sender endpoint'}: <strong>${escapeHtml(adapter.adapterName || adapter.adapterMessageFlowId)}</strong>${escapeHtml(location)}</div>
        <div>ProcessDirect address: <code>${escapeHtml(edge.address)}</code> <span class="badge ${adapter.addressSource === 'UNRESOLVED_PARAMETER' ? 'unresolved' : ''}">${escapeHtml(adapter.addressSource)}</span></div>
        ${match ? `<div>Matched ${escapeHtml(match.direction)} adapter: <strong>${escapeHtml(match.adapterName || match.adapterMessageFlowId)}</strong></div>` : ''}
      </div>`;
    return `<div class="children"><div class="tree-node">${edgeHtml}${renderNode(child, direction)}</div></div>`;
  }).join('');

  let unresolvedEdges = '';
  if (node.edges.some((e) => e.unresolved)) {
    unresolvedEdges = node.edges.filter((e) => e.unresolved).map((e) => `
      <div class="children"><div class="tree-node">
        <div class="node-card">
          <div class="node-header"><div class="node-title">No matching iFlow found</div><span class="badge unresolved">unmatched</span></div>
          <div class="node-meta">ProcessDirect address: <code>${escapeHtml(e.address)}</code><br/>Adapter: ${escapeHtml(e.adapter.adapterName || e.adapter.adapterMessageFlowId)}</div>
        </div>
      </div></div>`).join('');
  }

  return `
    <div class="node-card">
      <div class="node-header">
        <div class="node-title">${title}</div>
        <div>${badges.join(' ')}</div>
      </div>
      <div class="node-meta">${meta}</div>
    </div>
    ${children || unresolvedEdges || (node.depth === 0 ? '<div class="empty">No matching ProcessDirect dependencies found for this direction.</div>' : '')}
  `;
}

function buildIflowUrl(iflow) {
  if (!iflow || iflow.missingReason) return '';
  if (!state.config.uiBaseUrl || !iflow.packageId || !iflow.id) return '';
  const uiBaseUrl = normalizeBaseUrl(state.config.uiBaseUrl).replace(/\/$/, '');
  return `${uiBaseUrl}/shell/design/contentpackage/${encodeURIComponent(iflow.packageId)}/integrationflows/${encodeURIComponent(iflow.id)}`;
}

async function replaceDatabase(nextDb) {
  const db = await openDb();
  await txDone(db.transaction([STORE_IFLOWS, STORE_ADAPTERS, STORE_META], 'readwrite'), (tx) => {
    tx.objectStore(STORE_IFLOWS).clear();
    tx.objectStore(STORE_ADAPTERS).clear();
    tx.objectStore(STORE_META).clear();
  });

  await txDone(db.transaction([STORE_IFLOWS, STORE_ADAPTERS, STORE_META], 'readwrite'), (tx) => {
    const iflowStore = tx.objectStore(STORE_IFLOWS);
    const adapterStore = tx.objectStore(STORE_ADAPTERS);
    const metaStore = tx.objectStore(STORE_META);
    for (const iflow of nextDb.iflows) iflowStore.put(iflow);
    for (const adapter of nextDb.adapters) adapterStore.put(adapter);
    metaStore.put({ key: 'summary', value: nextDb.meta });
  });
  db.close();
}

async function readDatabaseSnapshot() {
  const db = await openDb();
  const [iflows, adapters, metaEntries] = await Promise.all([
    getAll(db, STORE_IFLOWS),
    getAll(db, STORE_ADAPTERS),
    getAll(db, STORE_META)
  ]);
  db.close();
  const meta = Object.fromEntries(metaEntries.map((m) => [m.key, m.value]));
  return { iflows, adapters, meta };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_IFLOWS)) {
        const store = db.createObjectStore(STORE_IFLOWS, { keyPath: 'id' });
        store.createIndex('packageId', 'packageId', { unique: false });
        store.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ADAPTERS)) {
        const store = db.createObjectStore(STORE_ADAPTERS, { keyPath: 'key' });
        store.createIndex('iflowId', 'iflowId', { unique: false });
        store.createIndex('direction', 'direction', { unique: false });
        store.createIndex('resolvedAddress', 'resolvedAddress', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx, work) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    work(tx);
  });
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function handleDbSummaryClick(event) {
  const metric = event.target.closest('[data-db-view]');
  if (!metric) return;
  state.dbView = metric.dataset.dbView || 'adapters';
  refreshDbSummary();
}

function handleDbSummaryKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const metric = event.target.closest('[data-db-view]');
  if (!metric) return;
  event.preventDefault();
  state.dbView = metric.dataset.dbView || 'adapters';
  refreshDbSummary();
}

async function refreshDbSummary() {
  const db = await readDatabaseSnapshot();
  const senderCount = db.adapters.filter((a) => a.direction === 'Sender').length;
  const receiverCount = db.adapters.filter((a) => a.direction === 'Receiver').length;
  const unresolvedAdapters = getUnresolvedAddressAdapters(db.adapters);
  const missingTargetAdapters = getMissingTargetAdapters(db.adapters);
  const lastSync = db.meta.summary?.lastSyncAt || 'Never';

  $('dbStatus').textContent = `${db.iflows.length} iFlows / ${db.adapters.length} PD adapters`;
  $('dbSummary').innerHTML = `
    ${renderMetricButton('iflows', db.iflows.length, 'iFlows')}
    ${renderMetricButton('adapters', db.adapters.length, 'ProcessDirect adapters')}
    ${renderMetricButton('senders', senderCount, 'Senders')}
    ${renderMetricButton('receivers', receiverCount, 'Receivers')}
    ${renderMetricButton('missingTargets', missingTargetAdapters.length, 'Missing target iFlow(s)', missingTargetAdapters.length ? 'metric-error' : '')}
    ${renderMetricButton('unresolved', unresolvedAdapters.length, 'Unresolved addresses')}
    <div class="metric"><strong>${escapeHtml(db.meta.summary?.source || '-')}</strong>Source</div>
    <div class="metric"><strong>${lastSync === 'Never' ? 'Never' : new Date(lastSync).toLocaleString()}</strong>Last sync</div>
  `;

  state.cachedDbAdaptersForStatus = db.adapters || [];
  renderDatabaseView(db, state.dbView || 'adapters');
}

function renderMetricButton(view, count, label, extraClass = '') {
  const active = state.dbView === view ? 'metric-active' : '';
  return `
    <button type="button" class="metric metric-click ${active} ${extraClass}" data-db-view="${escapeAttr(view)}" aria-pressed="${active ? 'true' : 'false'}" title="Show ${escapeAttr(label)}">
      <strong>${escapeHtml(String(count))}</strong>
      <span>${escapeHtml(label)}</span>
    </button>`;
}

function renderDatabaseView(db, view) {
  const adapters = db.adapters || [];
  const normalizedView = view || 'adapters';

  if (normalizedView === 'iflows') {
    renderIflowTable(db.iflows || []);
    return;
  }

  if (normalizedView === 'senders') {
    renderAdapterTable(adapters.filter((a) => a.direction === 'Sender'), 'ProcessDirect Sender adapters');
    return;
  }

  if (normalizedView === 'receivers') {
    renderAdapterTable(adapters.filter((a) => a.direction === 'Receiver'), 'ProcessDirect Receiver adapters');
    return;
  }

  if (normalizedView === 'missingTargets') {
    renderAdapterTable(getMissingTargetAdapters(adapters), 'Missing target iFlow(s)');
    return;
  }

  if (normalizedView === 'unresolved') {
    renderUnresolvedAddressTable(getUnresolvedAddressAdapters(adapters));
    return;
  }

  renderAdapterTable(adapters, 'ProcessDirect adapters');
}

function getSenderByAddress(adapters) {
  return groupBy(adapters.filter((a) => a.direction === 'Sender' && a.resolvedAddress), (a) => normalizeAddressKey(a.resolvedAddress));
}

function getMissingTargetAdapters(adapters) {
  const senderByAddress = getSenderByAddress(adapters);
  return adapters.filter((a) => getAdapterLinkStatus(a, senderByAddress).severity === 'error');
}

function getUnresolvedAddressAdapters(adapters) {
  return adapters.filter((a) => !a.resolvedAddress || a.addressSource === 'UNRESOLVED_PARAMETER');
}

function getAdapterLinkStatus(adapter, senderByAddress) {
  if (adapter.direction !== 'Receiver') {
    return {
      severity: 'neutral',
      label: 'Endpoint',
      comment: ''
    };
  }

  if (!adapter.resolvedAddress) {
    return {
      severity: 'warning',
      label: 'Unresolved address',
      comment: ''
    };
  }

  const matches = senderByAddress.get(normalizeAddressKey(adapter.resolvedAddress)) || [];
  if (matches.length === 0) {
    return {
      severity: 'error',
      label: 'Missing target',
      comment: ''
    };
  }

  return {
    severity: 'ok',
    label: 'Target found',
    comment: ''
  };
}

function renderIflowTable(iflows) {
  if (!iflows.length) {
    $('adapterTable').innerHTML = '<div class="empty">No iFlows in local database.</div>';
    return;
  }

  const rows = iflows
    .slice()
    .sort((a, b) => `${a.packageId || ''}|${a.id || ''}`.localeCompare(`${b.packageId || ''}|${b.id || ''}`))
    .map((i) => {
      const rowClass = i.parseStatus === 'ERROR' ? 'adapter-row-error' : '';
      const statusClass = i.parseStatus === 'ERROR' ? 'unresolved' : 'ok';
      return `
      <tr class="${rowClass}">
        <td>${escapeHtml(i.id || '')}</td>
        <td>${escapeHtml(i.name || '')}</td>
        <td>${escapeHtml(i.packageId || '')}</td>
        <td>${escapeHtml(i.packageName || '')}</td>
        <td>${escapeHtml(i.version || '')}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(i.parseStatus || '')}</span></td>
        <td>${escapeHtml(i.syncedAt ? new Date(i.syncedAt).toLocaleString() : '')}</td>
      </tr>`;
    }).join('');

  $('adapterTable').innerHTML = `
    <h3 class="table-title">iFlows</h3>
    <table>
      <thead><tr><th>iFlow ID</th><th>Name</th><th>Package ID</th><th>Package name</th><th>Version</th><th>Parse status</th><th>Synced at</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderUnresolvedAddressTable(adapters) {
  if (!adapters.length) {
    $('adapterTable').innerHTML = '<div class="empty">No unresolved ProcessDirect addresses found.</div>';
    return;
  }

  const rows = adapters
    .slice()
    .sort((a, b) => `${a.iflowId}|${a.direction}|${a.rawAddress}`.localeCompare(`${b.iflowId}|${b.direction}|${b.rawAddress}`))
    .map((a) => `
      <tr>
        <td>${escapeHtml(a.iflowId || '')}</td>
        <td><span class="badge ${a.direction === 'Sender' ? 'sender' : 'receiver'}">${escapeHtml(a.direction || '')}</span></td>
        <td>${escapeHtml(a.adapterName || a.adapterMessageFlowId || '')}</td>
        <td>${escapeHtml(a.rawAddress || '')}</td>
        <td>${escapeHtml(a.parameterName || '')}</td>
        <td><span class="badge unresolved">${escapeHtml(a.addressSource || '')}</span></td>
        <td>${escapeHtml(a.sourceProcessName || '')}</td>
        <td>${escapeHtml(a.sourceStepName || '')}</td>
      </tr>`).join('');

  $('adapterTable').innerHTML = `
    <h3 class="table-title">Unresolved ProcessDirect addresses</h3>
    <table>
      <thead><tr><th>iFlow</th><th>Direction</th><th>Adapter</th><th>Raw address</th><th>Parameter</th><th>Source</th><th>Process</th><th>Step</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderAdapterTable(adapters, title = 'ProcessDirect adapters') {
  if (!adapters.length) {
    $('adapterTable').innerHTML = `<div class="empty">No records found for ${escapeHtml(title)}.</div>`;
    return;
  }

  const senderByAddress = getSenderByAddress(adapters.concat([]));
  const allDbAdapters = state.cachedDbAdaptersForStatus || adapters;
  const allSenderByAddress = getSenderByAddress(allDbAdapters);
  const rows = adapters
    .slice()
    .sort((a, b) => `${a.iflowId}|${a.direction}|${a.resolvedAddress}`.localeCompare(`${b.iflowId}|${b.direction}|${b.resolvedAddress}`))
    .map((a) => {
      const status = getAdapterLinkStatus(a, allSenderByAddress);
      const rowClass = status.severity === 'error' ? 'adapter-row-error' : '';
      const statusBadgeClass = status.severity === 'error' ? 'unresolved' : status.severity === 'ok' ? 'ok' : status.severity === 'warning' ? 'unresolved' : 'neutral';
      const statusComment = status.comment ? `<div class="status-comment">${escapeHtml(status.comment)}</div>` : '';
      return `
      <tr class="${rowClass}">
        <td>${escapeHtml(a.iflowId || '')}</td>
        <td><span class="badge ${a.direction === 'Sender' ? 'sender' : 'receiver'}">${escapeHtml(a.direction || '')}</span></td>
        <td>${escapeHtml(a.adapterName || a.adapterMessageFlowId || '')}</td>
        <td><code>${escapeHtml(a.resolvedAddress || '')}</code></td>
        <td>${escapeHtml(a.rawAddress || '')}</td>
        <td><span class="badge ${a.addressSource === 'UNRESOLVED_PARAMETER' ? 'unresolved' : ''}">${escapeHtml(a.addressSource || '')}</span></td>
        <td><span class="badge ${statusBadgeClass}">${escapeHtml(status.label)}</span>${statusComment}</td>
        <td>${escapeHtml(a.sourceProcessName || '')}</td>
        <td>${escapeHtml(a.sourceStepName || '')}</td>
      </tr>`;
    }).join('');
  $('adapterTable').innerHTML = `
    <h3 class="table-title">${escapeHtml(title)}</h3>
    <table>
      <thead><tr><th>iFlow</th><th>Direction</th><th>Adapter</th><th>Resolved address</th><th>Raw address</th><th>Source</th><th>Target status</th><th>Process</th><th>Step</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function populateIflowList() {
  const db = await readDatabaseSnapshot();
  $('iflowList').innerHTML = db.iflows
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((i) => `<option value="${escapeAttr(i.id)}">${escapeHtml(i.name || i.id)}</option>`)
    .join('');
}

async function exportDatabaseJson() {
  const db = await readDatabaseSnapshot();
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sap-is-processdirect-db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function clearDatabaseWithConfirm() {
  if (!confirm('Clear the local iFlow dependency database? Configuration will remain saved.')) return;
  await replaceDatabase({ iflows: [], adapters: [], meta: { lastSyncAt: new Date().toISOString(), source: 'CLEARED', packages: 0, iflows: 0, adapters: 0 } });
  await refreshDbSummary();
  await populateIflowList();
}

function normalizePackage(pkg) {
  return {
    id: pkg.Id || pkg.id || pkg.PackageId || '',
    name: pkg.Name || pkg.name || pkg.PackageName || pkg.Id || ''
  };
}

function normalizeArtifact(artifact) {
  return {
    id: artifact.Id || artifact.id || artifact.ArtifactId || '',
    name: artifact.Name || artifact.name || artifact.Id || '',
    version: artifact.Version || artifact.version || 'active'
  };
}

function normalizeODataList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.value)) return payload.value;
  if (Array.isArray(payload?.d?.results)) return payload.d.results;
  if (payload?.d && typeof payload.d === 'object') return Array.isArray(payload.d) ? payload.d : [payload.d];
  return [];
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function normalizeAddressKey(address) {
  return String(address || '').trim();
}

function odataLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function pathWithJsonFormat(path) {
  return path.includes('?') ? `${path}&$format=json` : `${path}?$format=json`;
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '/');
}

function normalizeApiBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function joinUrl(base, path) {
  const cleanBase = normalizeApiBaseUrl(base);
  const cleanPath = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

function setResult(elementId, message, type) {
  const el = $(elementId);
  el.textContent = message;
  el.className = `result ${type || ''}`;
}

function resetProgress() {
  $('progressBar').style.width = '0%';
  $('progressText').textContent = 'Idle';
}

function setProgress(percent, text) {
  $('progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('progressText').textContent = text;
}

function clearLog() {
  $('syncLog').textContent = '';
}

function log(message, level = 'INFO') {
  const line = `[${new Date().toLocaleTimeString()}] ${level.padEnd(5)} ${message}\n`;
  $('syncLog').textContent += line;
  $('syncLog').scrollTop = $('syncLog').scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
