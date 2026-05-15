# Parser validation against provided sample exports

The parser logic was validated against the provided upstream / middle / downstream scenario and the modified upstream scenario where the ProcessDirect call is triggered from a Local Integration Process.

## Expected dependencies

```text
iFlow_upstream
  downstream -> iFlow_middle_1 via iFlowRecv1
    downstream -> iFlow_downstream via iFlow_receiverx
```

Reverse:

```text
iFlow_downstream
  upstream -> iFlow_middle_1 via iFlow_receiverx
    upstream -> iFlow_upstream via iFlowRecv1
```

## Key validation points

- `iFlow_upstream` receiver address `{{EX_iFlowMid1}}` resolves to `iFlowRecv1` from `parameters.prop`.
- `iFlow_middle_1` has a hardcoded ProcessDirect sender address `iFlowRecv1`.
- `iFlow_middle_1` has a hardcoded ProcessDirect receiver address `iFlow_receiverx`.
- `iFlow_downstream` sender address `{{sender1}}` resolves to `iFlow_receiverx` from `parameters.prop`.
- Modified `iFlow_upstream` still exposes the same ProcessDirect receiver `messageFlow`, but its source step is inside `Process_8 / Local Integration Process 1`.
- Therefore the parser scans all `messageFlow` elements globally and does not restrict extraction to the main Integration Process.

## v0.2.0 diagram validation

- Added **Generate Diagram** action in the Explore Dependencies tab.
- The generated diagram uses the same dependency matching rules as the upstream/downstream tree views.
- For a selected iFlow, upstream dependencies are rendered on the left, the selected/root iFlow is rendered in the center, and downstream dependencies are rendered on the right.
- Resolved ProcessDirect addresses are shown inside target iFlow cards to avoid overlap.
- Diagram nodes use the fixed SAP IS route `{uiBaseUrl}/shell/design/contentpackage/{packageId}/integrationflows/{iflowId}` and are clickable when package/iFlow metadata is available.

## v0.2.1 anonymization and URL validation

- Removed iFlow URL Template from Configuration.
- Replaced tenant-specific examples with neutral placeholders.
- Updated generated iFlow links to the fixed SAP IS route `/shell/design/contentpackage/{packageId}/integrationflows/{iflowId}`.

## v1.0.0 branding and source-available metadata validation

- Manifest version updated to `1.0.0`.
- Added author metadata: SEKO Consulting - Lukasz Sekowski.
- Added product owner/contact information in the top-right corner of the main extension UI.
- Added copyright and source-available license headers to source files.
- Added source-available free internal use license file.


## Version 1.0.1

- Improved diagram layout so iFlow names and ProcessDirect connection addresses are no longer hidden by overlapping SVG labels.
- ProcessDirect connection addresses are now displayed inside the target iFlow card.
- Diagram cards are wider, wrap long names/IDs, and use dynamic card height and spacing.


## Version 1.0.3

- Added diagram zoom toolbar with Zoom Out, Reset, Zoom In, and Fit width actions.
- Added Ctrl + mouse wheel zoom support inside the diagram viewport.
- Verified that scaled diagrams resize the scrollable layer, keeping large dependency diagrams navigable.
- Verified JavaScript syntax with `node --check app.js`.


## Version 1.0.3

- Added **Download Diagram PNG** button next to **Generate Diagram**.
- The button is enabled after a diagram is generated and disabled when switching back to tree views.
- PNG export renders the full diagram canvas, including nodes, arrows, and ProcessDirect address badges.
- Export is based on the unscaled diagram dimensions, so zoom level and scroll position do not crop the downloaded PNG.

## Version 1.0.4

- Removed active SAP IS tab lookup button from `app.html`.
- Removed active tab lookup event binding and URL parsing functions from `app.js`.
- Updated manifest version to `1.0.4`.
- Removed `tabs` permission from manifest because active-tab URL reading is no longer used.
- Verified JavaScript syntax with `node --check app.js`.

## Version 1.0.5

- Restored clickable behavior for generated diagram nodes.
- Clickable diagram nodes use the fixed SAP IS route `/shell/design/contentpackage/{packageId}/integrationflows/{iflowId}`.
- Added explicit click and keyboard handlers for diagram nodes, independent of default anchor behavior.
- Verified JavaScript syntax with `node --check app.js`.

## Version 1.0.8

- Removed false ambiguity warnings for valid many-to-one and one-to-many ProcessDirect relationships.
- Verified the uploaded database case where `/em/cn/dwms/inbounddeliveryconfirmation` has two Receiver adapters and one matching Sender adapter; this is now treated as valid.
- Receiver adapters with no matching Sender adapter are marked as missing target errors in the Database tab.
- Updated JavaScript syntax validation.

- Manifest version updated to `1.0.8`.
- Visible version number added to the main application header and popup owner block.
- Source file headers include version metadata.
- Verified JavaScript syntax with `node --check app.js`.
