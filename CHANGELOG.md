# Changelog

## Version 1.1.1

- Corrected delta synchronization to use iFlow / IntegrationDesigntimeArtifact `ModifiedDate` instead of package-level `ModifiedDate`.
- Delta synchronization now always reads package artifact lists, compares each iFlow artifact timestamp with the local cache, and downloads only changed or timestamp-less iFlows.
- Added artifact-level delta metadata: `artifactModifiedDate`, `artifactDeltaFingerprint`, and `artifactIndex` in the local database summary.
- Removed package-level reuse logic that could miss changed iFlows when the package timestamp was not updated.
- Updated extension metadata, visible header, popup and source headers to version 1.1.1.

## Version 1.0.13

- Improved Security Material and Keystore where-used views.
- Added separate columns for resolved entry, externalized/raw value and source.
- Resolved externalized parameters with spaces, such as `{{AfterShip Credentials}}`, from `parameters.prop`.
- Added unresolved-parameter visibility instead of silently displaying placeholders as real entries.

## Version 1.0.12

- Fixed where-used resolution for externalized Security Material and Keystore entries whose parameter names contain spaces.
- Reused the exact-parameter resolver for ProcessDirect and where-used resolution.

## Version 1.0.11

- Reinforced Security Material and Keystore where-used scanning as adapter-agnostic.
- Scans all BPMN `ifl:property` metadata globally, not only ProcessDirect adapters.
- Extended recognition of credential, OAuth, certificate, private/public key, PGP, known-hosts and TLS/SSL related aliases.

## Version 1.0.10

- Added left-side navigation options for Where Used analysis.
- Added **Where Used: Security Material**.
- Added **Where Used: Keystore**.
- Added `references` collection to exported local database JSON.

## Version 1.0.9

- Added delta synchronization from SAP Integration Suite API.
- Delta sync reuses unchanged package data when package `ModifiedDate` is available and reliable.
- Added duplicate static ProcessDirect Sender address validation.
- Added **Duplicate Sender address(es)** database filter.
- Ignored dynamic runtime expressions and unresolved generic handler patterns from duplicate Sender validation.

## Version 1.0.8

- Reworked Database summary boxes into real clickable filter buttons.
- Added active selection highlighting and keyboard activation.
- Added filters for iFlows, adapters, Senders, Receivers, Missing Targets and Unresolved addresses.

## Version 1.0.7

- Removed false ambiguity warnings for valid many-to-one and one-to-many ProcessDirect relationships.
- Added missing-target validation for Receiver adapters without matching Sender adapters.
- Added red highlighting and compact **Missing Target** badge.
- Added missing-target nodes in dependency diagrams.
- Updated licensing model to source-available, free for internal corporate/enterprise use, with resale restrictions.

## Version 1.0.6

- Added visible version number to the application header and popup.
- Added version metadata to source file headers.
