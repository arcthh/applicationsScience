import api, { storage } from '@forge/api';

const CONFIG = {
  template: '1_dev',
  storyIssueType: 'Story',
  impactedFieldId: 'customfield_10602',
  impactedFieldName: 'Impacted Application/s',
  impactedFieldDescription: 'Display Impacted CSI Applications',
  sentinelValue: 'No CSI App ID',
  travelRuleFieldName: 'US Travel Rule Impact',
  loopGuardProperty: 'story-listener:loop-guard',
  loopGuardTtlMs: 60000,
  notificationProperty: 'story-listener:travel-rule-notify',
  notifySubject: 'US Travel Rule Impact set to Yes',
  notifyBody:
    'US Travel Rule Impact was set to Yes on this Story. Please review impacted applications and next steps.',
  jqlPageSize: 50,
};

export const run = async (event) => {
  if (!event.issue?.id && !event.issue?.key) {
    console.log('No issue data on event payload.');
    return;
  }

  const issueKeyOrId = event.issue.key ?? event.issue.id ?? '';
  const story = await fetchIssue(issueKeyOrId, [
    'issuetype',
    'parent',
    CONFIG.impactedFieldId,
    CONFIG.travelRuleFieldName,
  ]);

  if (!story) {
    console.log('Unable to fetch issue details.');
    return;
  }

  const issueType = story.fields?.issuetype?.name;
  if (issueType !== CONFIG.storyIssueType) {
    console.log(`Skipping issue ${story.key} because type is ${issueType}.`);
    return;
  }

  const loopGuard = await getLoopGuard(story.key);
  if (loopGuard && Date.now() - loopGuard < CONFIG.loopGuardTtlMs) {
    console.log(`Loop guard active for ${story.key}, skipping.`);
    return;
  }

  const storyImpactedValues = normalizeFieldValues(
    story.fields?.[CONFIG.impactedFieldId]
  );
  const storyImpactedUnique = determineUniqueValues(
    removeWhitespaceInArrayElements(storyImpactedValues)
  );
  logInvalidCsiValues(story.key, storyImpactedUnique);

  const epicChange = getEpicChange(event.changelog?.items ?? []);
  const currentEpicKey = getEpicKeyFromIssue(story);

  if (epicChange?.newEpicKey || epicChange?.oldEpicKey) {
    await handleEpicLinkChange({
      story,
      storyImpactedValues: storyImpactedUnique,
      oldEpicKey: epicChange?.oldEpicKey,
      newEpicKey: epicChange?.newEpicKey ?? currentEpicKey,
    });
  }

  const impactedFieldChanged = hasFieldChanged(
    event.changelog?.items ?? [],
    CONFIG.impactedFieldId,
    CONFIG.impactedFieldName
  );

  if (impactedFieldChanged && currentEpicKey) {
    await syncEpicImpactedApplications({
      story,
      epicKey: currentEpicKey,
      storyImpactedValues: storyImpactedUnique,
      changelogItems: event.changelog?.items ?? [],
    });
  }

  if (storyImpactedUnique.length === 0 && currentEpicKey) {
    await cascadeEpicValuesToStory(currentEpicKey, story);
  }

  await handleTravelRuleNotification(story);
};

const fetchIssue = async (issueKeyOrId, fields) => {
  const response = await api
    .asApp()
    .requestJira(
      `/rest/api/3/issue/${issueKeyOrId}?fields=${fields
        .map(encodeURIComponent)
        .join(',')}`
    );
  if (!response.ok) {
    console.log(`Failed to fetch issue ${issueKeyOrId}: ${response.status}`);
    return null;
  }
  return response.json();
};

const updateIssueField = async (issueKey, fieldId, value) => {
  await setLoopGuard(issueKey);
  const response = await api.asApp().requestJira(`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        [fieldId]: value,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(`Failed updating ${issueKey} ${fieldId}: ${response.status} ${text}`);
  }
};

const getEpicKeyFromIssue = (issue) => {
  const parentKey = issue.fields?.parent?.key;
  if (parentKey) {
    return parentKey;
  }
  return null;
};

const getEpicChange = (items) => {
  const epicItem = items.find(
    (item) => item.field === 'Epic Link' || item.field === 'Parent'
  );
  if (!epicItem) {
    return null;
  }
  return {
    oldEpicKey: epicItem.fromString ?? epicItem.from ?? null,
    newEpicKey: epicItem.toString ?? epicItem.to ?? null,
  };
};

const hasFieldChanged = (items, fieldId, fieldName) =>
  items.some((item) => item.fieldId === fieldId || item.field === fieldName);

const handleEpicLinkChange = async ({
  story,
  storyImpactedValues,
  oldEpicKey,
  newEpicKey,
}) => {
  if (newEpicKey) {
    console.log(`Story ${story.key} moved to epic ${newEpicKey}.`);
    await addValuesToEpic(newEpicKey, storyImpactedValues);
  }

  if (oldEpicKey && oldEpicKey !== newEpicKey) {
    console.log(`Story ${story.key} removed from epic ${oldEpicKey}.`);
    await removeValuesFromEpicIfUnused(oldEpicKey, story, storyImpactedValues);
  }
};

const syncEpicImpactedApplications = async ({
  story,
  epicKey,
  storyImpactedValues,
  changelogItems,
}) => {
  const epicValues = await getEpicImpactedValues(epicKey);
  const epicValuesTrimmed = removeWhitespaceInArrayElements(epicValues);
  const combined = determineUniqueValues([
    ...epicValuesTrimmed,
    ...storyImpactedValues,
  ]);

  const { added, removed } = diffFromChangelog(changelogItems);

  const finalEpicValues = determineUniqueValues([
    ...combined,
    ...added,
  ]);

  const filteredRemoved = await filterRemovalsStillUsed(epicKey, story, removed);
  const afterRemovals = finalEpicValues.filter(
    (value) => !filteredRemoved.includes(value)
  );

  if (arraysEqual(afterRemovals, epicValuesTrimmed)) {
    console.log(`No epic update required for ${epicKey}.`);
    return;
  }

  console.log(
    `Updating epic ${epicKey}: +${added.length} -${filteredRemoved.length} (total ${afterRemovals.length})`
  );
  await updateIssueField(epicKey, CONFIG.impactedFieldId, afterRemovals);
};

const addValuesToEpic = async (epicKey, values) => {
  const epicValues = await getEpicImpactedValues(epicKey);
  const combined = determineUniqueValues([
    ...removeWhitespaceInArrayElements(epicValues),
    ...values,
  ]);
  if (arraysEqual(combined, epicValues)) {
    return;
  }
  console.log(`Adding ${values.length} impacted applications to epic ${epicKey}.`);
  await updateIssueField(epicKey, CONFIG.impactedFieldId, combined);
};

const removeValuesFromEpicIfUnused = async (epicKey, story, values) => {
  const epicValues = await getEpicImpactedValues(epicKey);
  const removals = await filterRemovalsStillUsed(epicKey, story, values);
  const newValues = epicValues.filter((value) => !removals.includes(value));
  if (arraysEqual(newValues, epicValues)) {
    return;
  }
  console.log(`Removing ${removals.length} impacted applications from epic ${epicKey}.`);
  await updateIssueField(epicKey, CONFIG.impactedFieldId, newValues);
};

const filterRemovalsStillUsed = async (epicKey, story, removals) => {
  if (removals.length === 0) {
    return [];
  }
  const stories = await fetchStoriesUnderEpic(epicKey);
  const otherStories = stories.filter((issue) => issue.key !== story.key);
  const valuesStillUsed = new Set();
  for (const issue of otherStories) {
    const values = normalizeFieldValues(issue.fields?.[CONFIG.impactedFieldId]);
    removeWhitespaceInArrayElements(values).forEach((value) =>
      valuesStillUsed.add(value)
    );
  }
  return removals.filter((value) => !valuesStillUsed.has(value));
};

const cascadeEpicValuesToStory = async (epicKey, story) => {
  const epicValues = await getEpicImpactedValues(epicKey);
  const filtered = epicValues.filter(
    (value) => value !== CONFIG.sentinelValue
  );
  if (filtered.length === 0) {
    return;
  }
  console.log(`Cascading epic values to story ${story.key}.`);
  await updateIssueField(story.key, CONFIG.impactedFieldId, filtered);
};

const getEpicImpactedValues = async (epicKey) => {
  const epic = await fetchIssue(epicKey, [CONFIG.impactedFieldId]);
  if (!epic) {
    return [];
  }
  return determineUniqueValues(
    removeWhitespaceInArrayElements(
      normalizeFieldValues(epic.fields?.[CONFIG.impactedFieldId])
    )
  );
};

const fetchStoriesUnderEpic = async (epicKey) => {
  const stories = [];
  let startAt = 0;
  let total = 0;
  const jql = `issuetype = ${CONFIG.storyIssueType} AND ("Epic Link" = ${epicKey} OR parent = ${epicKey})`;

  do {
    const response = await api.asApp().requestJira('/rest/api/3/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: CONFIG.jqlPageSize,
        fields: [CONFIG.impactedFieldId],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(`Failed to search stories for epic ${epicKey}: ${text}`);
      break;
    }

    const data = await response.json();
    stories.push(...(data.issues ?? []));
    total = data.total ?? stories.length;
    startAt += CONFIG.jqlPageSize;
  } while (stories.length < total);

  return stories;
};

const diffFromChangelog = (items) => {
  const impactedItem = items.find(
    (item) =>
      item.fieldId === CONFIG.impactedFieldId ||
      item.field === CONFIG.impactedFieldName
  );

  if (!impactedItem) {
    return { added: [], removed: [] };
  }

  const oldValues = normalizeFieldValues(
    impactedItem.fromString ?? impactedItem.from ?? ''
  );
  const newValues = normalizeFieldValues(
    impactedItem.toString ?? impactedItem.to ?? ''
  );

  const oldUnique = determineUniqueValues(removeWhitespaceInArrayElements(oldValues));
  const newUnique = determineUniqueValues(removeWhitespaceInArrayElements(newValues));

  const added = newUnique.filter((value) => !oldUnique.includes(value));
  const removed = oldUnique.filter((value) => !newUnique.includes(value));

  return { added, removed };
};

const normalizeFieldValues = (rawValue) => {
  if (!rawValue) {
    return [];
  }
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item?.value) {
          return item.value;
        }
        if (item?.name) {
          return item.name;
        }
        return String(item);
      })
      .filter(Boolean);
  }
  if (typeof rawValue === 'string') {
    return rawValue
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [String(rawValue)];
};

const removeWhitespaceInArrayElements = (values) =>
  values.map((value) => value.trim()).filter(Boolean);

const determineUniqueValues = (values) => {
  const unique = new Map();
  values.forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    if (!unique.has(trimmed)) {
      unique.set(trimmed, trimmed);
    }
  });
  return Array.from(unique.values());
};

const logInvalidCsiValues = (issueKey, values) => {
  values.forEach((value) => {
    if (value === CONFIG.sentinelValue) {
      return;
    }
    if (!/^\d+$/.test(value)) {
      console.log(`Invalid CSI value on ${issueKey}: ${value}`);
    }
  });
};

const arraysEqual = (a, b) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const setLoopGuard = async (issueKey) => {
  await api
    .asApp()
    .requestJira(`/rest/api/3/issue/${issueKey}/properties/${CONFIG.loopGuardProperty}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timestamp: Date.now() }),
    });
};

const getLoopGuard = async (issueKey) => {
  const response = await api
    .asApp()
    .requestJira(`/rest/api/3/issue/${issueKey}/properties/${CONFIG.loopGuardProperty}`);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.value?.timestamp ?? null;
};

const handleTravelRuleNotification = async (story) => {
  const value = story.fields?.[CONFIG.travelRuleFieldName];
  if (!value || String(value).toLowerCase() !== 'yes') {
    return;
  }

  const response = await api.asApp().requestJira(`/rest/api/3/issue/${story.key}/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject: CONFIG.notifySubject,
      textBody: CONFIG.notifyBody,
    }),
  });

  const status = response.ok ? 'sent' : `failed (${response.status})`;
  console.log(`Travel rule notification for ${story.key}: ${status}`);
  await api
    .asApp()
    .requestJira(`/rest/api/3/issue/${story.key}/properties/${CONFIG.notificationProperty}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status,
        timestamp: Date.now(),
      }),
    });

  if (!response.ok) {
    console.log(
      'Notify endpoint failed. If direct SMTP is required, wire the placeholder sendTravelRuleEmail function.'
    );
  }
};

export const sendTravelRuleEmailPlaceholder = async (storyKey) => {
  console.log(`Placeholder email sender invoked for ${storyKey}.`);
  await storage.set(`travel-rule-email:${storyKey}`, {
    timestamp: Date.now(),
    status: 'placeholder',
  });
};

export const provision = async () => {
  const existingFieldId = await storage.get('impacted-field-id');
  if (existingFieldId) {
    return {
      statusCode: 200,
      body: `Impacted Application/s already provisioned: ${existingFieldId}`,
    };
  }

  const response = await api.asApp().requestJira('/rest/api/3/field', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: CONFIG.impactedFieldName,
      description: CONFIG.impactedFieldDescription,
      type: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect',
      searcherKey:
        'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      statusCode: response.status,
      body: `Failed to create field: ${text}`,
    };
  }

  const data = await response.json();
  if (data?.id) {
    await storage.set('impacted-field-id', data.id);
  }

  return {
    statusCode: 200,
    body: `Created field ${data?.id ?? 'unknown'}. Configure options in Jira settings.`,
  };
};

export default { run, provision };
