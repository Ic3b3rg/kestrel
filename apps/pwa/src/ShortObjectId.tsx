interface ShortObjectIdProps {
  label: string;
  value: string;
}

export function ShortObjectId({ label, value }: ShortObjectIdProps) {
  return (
    <code title={value} aria-label={`${label} object ID ${value}`}>
      {value.slice(0, 12)}
    </code>
  );
}
