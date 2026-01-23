import api, { storage } from '@forge/api';
import { CONFIG } from './config';

type JiraIssue = {
  id: string;
  key: string;
  fields: Record<string, any>;
};

type ChangeItem = {
  field?: string;
  fieldId?: string;
  fromString?: string | null;
  toString?: string | null;
  from?: string | null;
  to?: string | null;
};

type JiraEvent = {
  issue?: {
    id?: string;
    key?: string;
  };
  changelog?: {
    items?: ChangeItem[];
  };
};

const impactedFieldIdCacheKey = 'impacted-field-id';

export const run = async (event: JiraEvent) => {
  if (!event.issue?.id && !event.issue?.key) {
    console.log('No issue data on event payload.');
    return;
  }

  const issueKeyOrId = event.issue.key ?? event.issue.id ?? '';
  const impactedFieldId = await resolveImpactedFieldId();

  const story = await fetchIssue(issueKeyOrId, [
    'issuetype',
    'parent',
    impactedFieldId,
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
    story.fields?.[impactedFieldId]
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
      impactedFieldId,
    });
  }

  const impactedFieldChanged = hasFieldChanged(
    event.changelog?.items ?? [],
    impactedFieldId,
    CONFIG.impactedFieldName,
    CONFIG.impactedFieldLegacyName
  );

  if (impactedFieldChanged && currentEpicKey) {
    await syncEpicImpactedApplications({
      story,
      epicKey: currentEpicKey,
      storyImpactedValues: storyImpactedUnique,
      changelogItems: event.changelog?.items ?? [],
      impactedFieldId,
    });
  }

  if (storyImpactedUnique.length === 0 && currentEpicKey) {
    await cascadeEpicValuesToStory(currentEpicKey, story, impactedFieldId);
  }

  await handleTravelRuleNotification(story);
};

const resolveImpactedFieldId = async () => {
  const cached = await storage.get(impactedFieldIdCacheKey);
  if (cached) {
    return String(cached);
  }

  const response = await api.asApp().requestJira('/rest/api/3/field');
  if (!response.ok) {
    console.log(`Failed to fetch fields: ${response.status}`);
    return CONFIG.impactedFieldDefaultId;
  }

  const fields = (await response.json()) as Array<{ id: string; name: string }>;
  const match = fields.find(
    (field) => field.name === CONFIG.impactedFieldName
  );
  const fallback = fields.find(
    (field) => field.name === CONFIG.impactedFieldLegacyName
  );
  const fieldId = match?.id ?? fallback?.id ?? CONFIG.impactedFieldDefaultId;
  await storage.set(impactedFieldIdCacheKey, fieldId);
  return fieldId;
};

const fetchIssue = async (issueKeyOrId: string, fields: string[]) => {
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
  return (await response.json()) as JiraIssue;
};

const updateIssueField = async (
  issueKey: string,
  fieldId: string,
  value: any
) => {
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

const getEpicKeyFromIssue = (issue: JiraIssue): string | null => {
  const parentKey = issue.fields?.parent?.key;
  if (parentKey) {
    return parentKey;
  }
  return null;
};

const getEpicChange = (items: ChangeItem[]) => {
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

const hasFieldChanged = (
  items: ChangeItem[],
  fieldId: string,
  fieldName: string,
  legacyFieldName: string
) =>
  items.some(
    (item) =>
      item.fieldId === fieldId ||
      item.field === fieldName ||
      item.field === legacyFieldName
  );

const handleEpicLinkChange = async ({
  story,
  storyImpactedValues,
  oldEpicKey,
  newEpicKey,
  impactedFieldId,
}: {
  story: JiraIssue;
  storyImpactedValues: string[];
  oldEpicKey?: string | null;
  newEpicKey?: string | null;
  impactedFieldId: string;
}) => {
  if (newEpicKey) {
    console.log(`Story ${story.key} moved to epic ${newEpicKey}.`);
    await addValuesToEpic(newEpicKey, storyImpactedValues, impactedFieldId);
  }

  if (oldEpicKey && oldEpicKey !== newEpicKey) {
    console.log(`Story ${story.key} removed from epic ${oldEpicKey}.`);
    await removeValuesFromEpicIfUnused(
      oldEpicKey,
      story,
      storyImpactedValues,
      impactedFieldId
    );
  }
};

const syncEpicImpactedApplications = async ({
  story,
  epicKey,
  storyImpactedValues,
  changelogItems,
  impactedFieldId,
}: {
  story: JiraIssue;
  epicKey: string;
  storyImpactedValues: string[];
  changelogItems: ChangeItem[];
  impactedFieldId: string;
}) => {
  const epicValues = await getEpicImpactedValues(epicKey, impactedFieldId);
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

  const filteredRemoved = await filterRemovalsStillUsed(
    epicKey,
    story,
    removed,
    impactedFieldId
  );
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
  await updateIssueField(epicKey, impactedFieldId, afterRemovals);
};

const addValuesToEpic = async (
  epicKey: string,
  values: string[],
  impactedFieldId: string
) => {
  const epicValues = await getEpicImpactedValues(epicKey, impactedFieldId);
  const combined = determineUniqueValues([
    ...removeWhitespaceInArrayElements(epicValues),
    ...values,
  ]);
  if (arraysEqual(combined, epicValues)) {
    return;
  }
  console.log(`Adding ${values.length} impacted applications to epic ${epicKey}.`);
  await updateIssueField(epicKey, impactedFieldId, combined);
};

const removeValuesFromEpicIfUnused = async (
  epicKey: string,
  story: JiraIssue,
  values: string[],
  impactedFieldId: string
) => {
  const epicValues = await getEpicImpactedValues(epicKey, impactedFieldId);
  const removals = await filterRemovalsStillUsed(
    epicKey,
    story,
    values,
    impactedFieldId
  );
  const newValues = epicValues.filter((value) => !removals.includes(value));
  if (arraysEqual(newValues, epicValues)) {
    return;
  }
  console.log(`Removing ${removals.length} impacted applications from epic ${epicKey}.`);
  await updateIssueField(epicKey, impactedFieldId, newValues);
};

const filterRemovalsStillUsed = async (
  epicKey: string,
  story: JiraIssue,
  removals: string[],
  impactedFieldId: string
) => {
  if (removals.length === 0) {
    return [];
  }
  const stories = await fetchStoriesUnderEpic(epicKey, impactedFieldId);
  const otherStories = stories.filter((issue) => issue.key !== story.key);
  const valuesStillUsed = new Set<string>();
  for (const issue of otherStories) {
    const values = normalizeFieldValues(issue.fields?.[impactedFieldId]);
    removeWhitespaceInArrayElements(values).forEach((value) =>
      valuesStillUsed.add(value)
    );
  }
  return removals.filter((value) => !valuesStillUsed.has(value));
};

const cascadeEpicValuesToStory = async (
  epicKey: string,
  story: JiraIssue,
  impactedFieldId: string
) => {
  const epicValues = await getEpicImpactedValues(epicKey, impactedFieldId);
  const filtered = epicValues.filter(
    (value) => value !== CONFIG.sentinelValue
  );
  if (filtered.length === 0) {
    return;
  }
  console.log(`Cascading epic values to story ${story.key}.`);
  await updateIssueField(story.key, impactedFieldId, filtered);
};

const getEpicImpactedValues = async (
  epicKey: string,
  impactedFieldId: string
) => {
  const epic = await fetchIssue(epicKey, [impactedFieldId]);
  if (!epic) {
    return [];
  }
  return determineUniqueValues(
    removeWhitespaceInArrayElements(
      normalizeFieldValues(epic.fields?.[impactedFieldId])
    )
  );
};

const fetchStoriesUnderEpic = async (epicKey: string, impactedFieldId: string) => {
  const stories: JiraIssue[] = [];
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
        fields: [impactedFieldId],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(`Failed to search stories for epic ${epicKey}: ${text}`);
      break;
    }

    const data = (await response.json()) as {
      issues: JiraIssue[];
      total: number;
    };
    stories.push(...(data.issues ?? []));
    total = data.total ?? stories.length;
    startAt += CONFIG.jqlPageSize;
  } while (stories.length < total);

  return stories;
};

const diffFromChangelog = (items: ChangeItem[]) => {
  const impactedItem = items.find(
    (item) =>
      item.field === CONFIG.impactedFieldName ||
      item.field === CONFIG.impactedFieldLegacyName
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

const normalizeFieldValues = (rawValue: any): string[] => {
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

const removeWhitespaceInArrayElements = (values: string[]) =>
  values.map((value) => value.trim()).filter(Boolean);

const determineUniqueValues = (values: string[]) => {
  const unique = new Map<string, string>();
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

const logInvalidCsiValues = (issueKey: string, values: string[]) => {
  values.forEach((value) => {
    if (value === CONFIG.sentinelValue) {
      return;
    }
    if (!/^\d+$/.test(value)) {
      console.log(`Invalid CSI value on ${issueKey}: ${value}`);
    }
  });
};

const arraysEqual = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const setLoopGuard = async (issueKey: string) => {
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

const getLoopGuard = async (issueKey: string) => {
  const response = await api
    .asApp()
    .requestJira(`/rest/api/3/issue/${issueKey}/properties/${CONFIG.loopGuardProperty}`);
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { value?: { timestamp?: number } };
  return data.value?.timestamp ?? null;
};

const handleTravelRuleNotification = async (story: JiraIssue) => {
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
      'Notify endpoint failed. If direct SMTP is required, wire a placeholder notifier.'
    );
  }
};

export const sendTravelRuleEmailPlaceholder = async (storyKey: string) => {
  console.log(`Placeholder email sender invoked for ${storyKey}.`);
  await storage.set(`travel-rule-email:${storyKey}`, {
    timestamp: Date.now(),
    status: 'placeholder',
  });
};

export default { run };
