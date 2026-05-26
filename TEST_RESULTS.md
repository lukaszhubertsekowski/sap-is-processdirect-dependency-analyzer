# Validation notes

## Sample dependency parsing

The parser logic was validated against the provided upstream / middle / downstream scenario and the modified upstream scenario where the ProcessDirect call is triggered from a Local Integration Process.

Expected chain:

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

Validated points:

- Externalized ProcessDirect Receiver addresses are resolved from `parameters.prop`.
- Hardcoded ProcessDirect Sender and Receiver addresses are read directly from `.iflw`.
- ProcessDirect calls from Local Integration Processes are detected because the parser scans all BPMN `messageFlow` elements globally.
- Unused parameters in `parameters.prop` are not treated as dependencies unless they are referenced by an actual adapter property.

## Version 1.1.1 maintenance validation

- Manifest version updated to `1.1.1`.
- Source headers, popup and application header updated to `1.1.1`.
- JavaScript syntax validation completed for `app.js`, `background.js` and `popup.js`.
- JSON validation completed for `manifest.json`.
- Delta synchronization logic reviewed and changed from package-level timestamp reuse to artifact-level timestamp comparison.
- Added artifact-level delta index metadata validation.
- ZIP package integrity validation completed.

## Feature validation retained from 1.0.6 - 1.0.13

- Version label is visible in the main header and popup.
- Many-to-one and one-to-many ProcessDirect relationships are treated as valid.
- Missing downstream target iFlows are highlighted as missing-target issues.
- Database summary boxes work as clickable filter buttons.
- Delta synchronization action is available and uses iFlow / IntegrationDesigntimeArtifact timestamp fingerprinting when reliable.
- Duplicate static ProcessDirect Sender address validation is available.
- Security Material and Keystore where-used views scan all adapter/component metadata globally, not only ProcessDirect adapters.
- Where-used views show resolved entry, externalized/raw value and source.
