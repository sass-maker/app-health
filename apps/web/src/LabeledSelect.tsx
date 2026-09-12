import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.js';

interface SelectOption {
  value: string;
  label: string;
}

export function LabeledSelect({
  label,
  value,
  options,
  triggerClassName,
  onValueChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  triggerClassName?: string;
  onValueChange: (value: string) => void;
}): JSX.Element {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label} className={`bg-background ${triggerClassName ?? ''}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
