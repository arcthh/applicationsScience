export const CONFIG = {
  template: '1_dev',
  storyIssueType: 'Story',
  impactedFieldName: 'Impacted Applications',
  impactedFieldLegacyName: 'Impacted Application/s',
  impactedFieldDefaultId: 'customfield_10602',
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
