# Story Listener Custom Field (Forge)

Template: `1_dev`

## What it does
This Forge app **creates and owns** a custom field named **Impacted Applications** and listens to **Story** issue create/update events. It keeps parent Epics synchronized with their Story children and cascades Epic values down only when a Story is empty.

## Custom field
- **Name:** Impacted Applications
- **Legacy name:** Impacted Application/s
- **Type:** multi-value string list (Forge custom field)
- **Description/tooltip:** Display Impacted CSI Applications

The custom field is declared in `manifest.yml` under `jira:customField` and is managed by this Forge app.

## Configurable defaults
Edit `src/config.ts` to adjust defaults:
- `storyIssueType`: `Story`
- `impactedFieldName`: `Impacted Applications`
- `impactedFieldLegacyName`: `Impacted Application/s`
- `impactedFieldDefaultId`: `customfield_10602`
- `sentinelValue`: `No CSI App ID`
- `travelRuleFieldName`: `US Travel Rule Impact`
- `loopGuardProperty` + `loopGuardTtlMs`
- notification subject/body

## Key behaviors
- **Story-only gating**: ignores non-Story issues.
- **Impacted Applications sync**:
  - updates the Epic with unique additions/removals when a Story changes
  - on Epic link changes, adds to the new Epic and removes from the old Epic only if no other Stories still use those values
- **Cascade Epic ➜ Story**: when a Story is empty, copies Epic values down **excluding** `No CSI App ID`.
- **US Travel Rule Impact notifications**: when set to `Yes`, sends a Jira notify email and stores an audit property.
- **Loop guard**: issue property + TTL prevents recursion.

## Required permissions / scopes
Defined in `manifest.yml`:
- `read:jira-work`
- `write:jira-work`
- `manage:jira-configuration`
- `storage:app`

## Jira events
Triggers are configured for:
- `avi:jira:created:issue`
- `avi:jira:updated:issue`

## Deployment
From the `story-listener-custom` directory:
1. Install dependencies:
   ```bash
   npm install
   ```
2. Login and deploy:
   ```bash
   forge login
   forge deploy
   ```
3. Install the app into a Jira site:
   ```bash
   forge install
   ```

## Testing & validation tips
- Create a Story with impacted applications and link it to an Epic; verify the Epic updates.
- Update Story impacted applications; verify additions/removals and unique values on the Epic.
- Move the Story between Epics; verify old Epic only loses values not present in other Stories.
- Set **US Travel Rule Impact** to `Yes`; verify a notification and audit property.

## Notes
- Jira Cloud indexing is asynchronous; changes may take a short time to appear in search results.
- If Jira notify is blocked, wire a real SMTP integration in `sendTravelRuleEmailPlaceholder`.
