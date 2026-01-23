# Story Listener (Forge)

Template: `1_dev`

## What it does
This Forge app listens to **Story** issue create/update events and keeps the parent Epic's **Impacted Application/s** values synchronized with its Story children. It also cascades Epic values down to a Story when the Story is empty, and sends notifications when **US Travel Rule Impact** is set to `Yes`.

Key behaviors:
- **Story-only gating**: the trigger exits immediately if the issue type is not `Story`.
- **Impacted Application/s sync**:
  - Updates the Epic with unique additions/removals when a Story's impacted applications change.
  - When a Story moves between Epics, it adds values to the new Epic and removes from the old Epic only if no other Stories still use those values.
- **Cascade Epic ➜ Story**: if a Story is empty and the Epic has values, it copies Epic values down **excluding** `No CSI App ID`.
- **US Travel Rule Impact notifications**: when set to `Yes`, sends a Jira notify email and writes an audit property.
- **Loop guard**: issue property flag + TTL prevents recursive updates.

## Configurable defaults
Edit `src/index.js` to adjust defaults:
- `storyIssueType`: `Story`
- `impactedFieldId`: `customfield_10602`
- `impactedFieldName`: `Impacted Application/s`
- `sentinelValue`: `No CSI App ID`
- `travelRuleFieldName`: `US Travel Rule Impact`
- `loopGuardProperty` + `loopGuardTtlMs`
- notification subject/body

The field parsing utilities support both:
- **Array of option objects** (Jira REST responses)
- **Semicolon-delimited strings**

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

## Provisioning the custom field via Forge (admin-only)
This app exposes a **web trigger** that creates the `Impacted Application/s` multi-select field using Jira’s REST API. This requires admin access (which you have) and the `manage:jira-configuration` scope.

1. Deploy the app, then run:
   ```bash
   forge webtrigger --function story-listener-provision
   ```
2. Invoke the URL once as an admin. The response includes the created field id and stores it in Forge storage.
3. Configure field options for CSI Applications in Jira settings after creation.

If you prefer manual creation, you can still create the field in Jira admin and set `customfield_10602` accordingly.

## Deployment
From the `story-listener` directory:
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

## Custom field provisioning (Impacted Application/s)
The app **can** create the custom field via Jira’s REST API (`/rest/api/3/field`) because it already requests `manage:jira-configuration`, but Jira Cloud only allows this when an **admin** installs/authorizes the app. Forge does not auto-provision fields during install, so you typically have two options:
1. **Manual creation (recommended):** An admin creates a multi-select field named `Impacted Application/s` with tooltip text “Display Impacted CSI Applications,” then configures options for CSI Applications in Jira settings.
2. **One-time REST provisioning (optional):** Add a scripted/admin-only step that calls the field create API, then adds field options (via the custom field context/option endpoints). This is feasible within the same Forge app, but should be run explicitly by an admin because it changes Jira configuration.
