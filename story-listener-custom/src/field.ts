import { CustomFieldEdit, CustomFieldView, CustomFieldResolver, Form, Text, TextField } from '@forge/ui';

export const resolver: CustomFieldResolver = (value) => value;

const parseValue = (value: unknown): string[] => {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === 'string') {
    return value.split(';').map((item) => item.trim()).filter(Boolean);
  }
  return [String(value)];
};

export const view = CustomFieldView(({ value }) => {
  const items = parseValue(value);
  if (items.length === 0) {
    return <Text>-</Text>;
  }
  return <Text>{items.join('; ')}</Text>;
});

export const edit = CustomFieldEdit(({ value, onSubmit }) => {
  const items = parseValue(value);
  return (
    <Form onSubmit={({ impactedApplications }) => onSubmit(impactedApplications ?? '')}>
      <TextField
        name="impactedApplications"
        label="Impacted Applications"
        description="Enter values separated by semicolons."
        defaultValue={items.join('; ')}
      />
    </Form>
  );
});
