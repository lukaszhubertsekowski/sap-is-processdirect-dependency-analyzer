# SAP IS ProcessDirect Dependency Explorer

**Version:** 1.0.6  
**Author / Product owner:** SEKO Consulting - Lukasz Sekowski  
**Contact:** lukasz.hubert.sekowski@gmail.com  
**License:** MIT open-source license

Chrome Extension MVP for SAP Integration Suite / Cloud Integration iFlow dependency visibility based on ProcessDirect adapter addresses.

## What it does

- Stores SAP IS tenant/API/OAuth configuration locally in Chrome extension storage.
- Synchronizes all Integration Packages and Integration Design-Time Artifacts through Integration Content APIs.
- Downloads each iFlow ZIP export from:
  - `/api/v1/IntegrationPackages()` or `/api/v1/IntegrationPackages`
  - `/api/v1/IntegrationPackages('<PackageId>')/IntegrationDesigntimeArtifacts`
  - `/api/v1/IntegrationDesigntimeArtifacts(Id='<iFlowId>',Version='active')/$value`
- Extracts only relevant files from the iFlow ZIP:
  - `*.iflw`
  - `src/main/resources/parameters.prop`
  - `src/main/resources/parameters.propdef`
  - `.project`
  - `META-INF/MANIFEST.MF`
- Parses all BPMN `messageFlow` elements globally, including message flows originating in Local Integration Processes.
- Detects ProcessDirect adapters by `ComponentType = ProcessDirect`.
- Resolves hardcoded and externalized adapter addresses.
- Stores iFlow and adapter metadata in local IndexedDB.
- Builds downstream and upstream dependency trees up to configurable depth, default 4.
- Generates a combined upstream + selected iFlow + downstream visual diagram with ProcessDirect address labels inside target iFlow cards.
- Downloads the generated dependency diagram as a PNG file.
- Provides clickable iFlow links using the fixed SAP IS route `{uiBaseUrl}/shell/design/contentpackage/{packageId}/integrationflows/{iflowId}`.
- Includes an offline developer import for local ZIP files.

## Diagram export

After clicking **Generate Diagram**, use **Download Diagram PNG** to export the full diagram as a PNG image. The export uses the full base diagram size, not only the currently visible scroll/zoom viewport.

## Installation

1. Unzip the extension package.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `sap-is-pd-dependency-extension` folder.
6. Pin the extension and open **ProcessDirect Explorer**.

## Configuration

Recommended fields:

- **SAP IS UI Base URL**  
  Example: `https://<tenant>.integrationsuite.<region>.hana.ondemand.com/`

- **Integration Content API Base URL**  
  Example: `https://<tenant>.<runtime-host>.hana.ondemand.com/api/v1`

- **OAuth2 Access Token URL**  
  Your XSUAA or OAuth token endpoint.

- **Client ID / Client Secret**  
  Stored locally in Chrome extension storage. The secret field is masked in the UI.

- **OAuth2 Client Authentication**  
  Default is HTTP Basic Authorization header. If your OAuth endpoint requires `client_id` and `client_secret` in the form body, change the mode.

- **iFlow URL**  
  The extension uses a fixed SAP IS route and no longer requires a configurable URL template:  
  `{uiBaseUrl}/shell/design/contentpackage/{packageId}/integrationflows/{iflowId}`

## Dependency rules implemented

### Adapter extraction

The extension scans the whole `.iflw` XML document for:

```text
bpmn2:messageFlow
  where ComponentType = ProcessDirect
```

It does **not** limit detection to the main Integration Process. This means ProcessDirect calls from Local Integration Processes are also detected.

### Address resolution

Supported address forms:

```text
<value>hardcodedAddress</value>
<value>{{EXTERNALIZED_PARAMETER}}</value>
```

Externalized values are resolved from `parameters.prop`. `parameters.propdef` is used as supporting metadata, not as the primary dependency source.

### Downstream matching

```text
Current iFlow ProcessDirect Receiver resolvedAddress
=
Other iFlow ProcessDirect Sender resolvedAddress
```

### Upstream matching

```text
Current iFlow ProcessDirect Sender resolvedAddress
=
Other iFlow ProcessDirect Receiver resolvedAddress
```

### Combined diagram

The **Generate Diagram** button renders the selected iFlow in the center, upstream iFlows on the left, and downstream iFlows on the right. Resolved ProcessDirect addresses are shown inside target iFlow cards. Nodes are clickable when package and iFlow metadata is available. The diagram frame supports zoom in, zoom out, reset, fit-to-width, and Ctrl + mouse wheel zoom.

### Cascade

The default cascade depth is 4 and can be changed in configuration.

## Known MVP limitations

- The extension uses Chrome IndexedDB and does not synchronize data between users.
- OAuth credentials are stored locally by Chrome extension storage, with masked UI field. For production enterprise rollout, consider managed extension policy or a backend proxy if stricter credential handling is required.
- ZIP64 archives are not supported. Standard SAP iFlow ZIP exports are expected to work.
- The extension assumes the iFlow ZIP contains UTF-8 XML/properties files.
- If the SAP API host rejects browser-origin calls despite extension permissions, a lightweight backend proxy may be needed. In many Chrome extension deployments, host permissions are sufficient.

## Suggested production hardening

- Restrict `host_permissions` in `manifest.json` from `https://*/*` to exact SAP tenant and OAuth hosts.
- Add managed enterprise configuration for tenant URLs and OAuth mode.
- Add delta synchronization if SAP API timestamps are reliable for the tenant.
- Add duplicate-address governance warnings, because multiple senders for the same ProcessDirect address are ambiguous.
- Add export/import of dependency database for support diagnostics.


## Version 1.0.0

- Added product owner information in the top-right corner of the extension UI.
- Set Chrome extension manifest version to `1.0.0`.
- Added copyright/open-source headers to source files.
- Added MIT open-source license file.


## Version 1.0.1

- Improved diagram layout so iFlow names and ProcessDirect connection addresses are no longer hidden by overlapping SVG labels.
- ProcessDirect connection addresses are now displayed inside the target iFlow card.
- Diagram cards are wider, wrap long names/IDs, and use dynamic card height and spacing.


## Version 1.0.3

- Added zoom controls to the generated diagram frame.
- Supported actions: zoom in, zoom out, reset to 100%, fit to frame width.
- Added Ctrl + mouse wheel zoom inside the diagram frame.
- Scaled diagram keeps scrollbars so large dependency graphs remain navigable.

## Version 1.0.4

- Removed the active SAP IS tab lookup action from the Explore Dependencies tab.
- Current iFlow ID is now entered or selected manually from the local synchronized iFlow list.
- Removed active tab URL parsing logic and reduced extension permissions accordingly.

## Version 1.0.5

- Restored clickable iFlow cards in the generated diagram frame.
- Diagram nodes now open the fixed SAP IS iFlow URL using an explicit click/keyboard handler.
- Added visible "Open iFlow" hint on clickable diagram cards.

## Version 1.0.6

- Added visible version number to the application header and popup.
- Added version metadata to source file headers.

