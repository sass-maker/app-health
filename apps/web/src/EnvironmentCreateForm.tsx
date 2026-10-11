import type { FormEvent, ReactElement } from 'react';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';

interface Props {
  name: string;
  pending: boolean;
  onName: (name: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
}

export function EnvironmentCreateForm(props: Props): ReactElement {
  const { name, pending, onName, onSubmit } = props;
  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(event) => void onSubmit(event)}
    >
      <label className="grid flex-1 gap-2 text-sm font-medium">
        add environment
        <Input
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="staging"
          aria-label="New environment name"
          required
        />
      </label>
      <Button type="submit" variant="outline" disabled={pending || !name.trim()}>
        {pending ? 'adding…' : 'add environment'}
      </Button>
    </form>
  );
}
