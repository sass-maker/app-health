import { useState, type FormEvent } from 'react';
import { AnalysisDefinition, type AnalysisStep } from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { LabeledSelect } from './LabeledSelect.js';

type StepDraft = {
  type: 'page' | 'event';
  target: string;
  property: string;
  equals: string;
  valueType: string;
};
type ConversionDefinition = Exclude<AnalysisDefinition, { kind: 'segment' }>;
const freshStep = (): StepDraft => ({
  type: 'page',
  target: '/',
  property: '',
  equals: '',
  valueType: 'text',
});
function draftStep(step: AnalysisStep): StepDraft {
  return {
    type: step.type,
    target: step.target,
    property: step.property ?? '',
    equals: step.equals === undefined ? '' : String(step.equals),
    valueType:
      step.equals === undefined || typeof step.equals === 'string' ? 'text' : typeof step.equals,
  };
}
function parseStep(step: StepDraft): AnalysisStep {
  const value =
    step.valueType === 'number'
      ? Number(step.equals)
      : step.valueType === 'boolean'
        ? step.equals === 'true'
        : step.equals;
  return {
    type: step.type,
    target: step.target,
    ...(step.type === 'event' && step.property ? { property: step.property, equals: value } : {}),
  };
}

function conditionError(steps: StepDraft[]) {
  if (
    steps.some(
      (step) =>
        step.type === 'event' &&
        step.property &&
        step.valueType === 'number' &&
        !step.equals.trim(),
    )
  )
    return 'Enter a numeric condition value; zero must be entered explicitly.';
  if (
    steps.some(
      (step) =>
        step.type === 'event' &&
        step.property &&
        step.valueType === 'boolean' &&
        !['true', 'false'].includes(step.equals),
    )
  )
    return 'Boolean conditions must be true or false.';
  return '';
}

function StepFields({
  step,
  index,
  onChange,
  onRemove,
}: {
  step: StepDraft;
  index: number;
  onChange: (value: StepDraft) => void;
  onRemove?: () => void;
}) {
  const update = (value: Partial<StepDraft>) => onChange({ ...step, ...value });
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-xs text-muted-foreground">step {index + 1}</legend>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <LabeledSelect
          label={`Step ${index + 1} type`}
          value={step.type}
          onValueChange={(value) => update({ type: value as StepDraft['type'] })}
          options={[
            { value: 'page', label: 'page visit' },
            { value: 'event', label: 'product event' },
          ]}
        />
        <label className="min-w-0 flex-1 space-y-1 text-xs">
          {step.type === 'page' ? 'page or /path/* prefix' : 'event name'}
          <Input
            aria-label={`Step ${index + 1} target`}
            value={step.target}
            onChange={(event) => update({ target: event.target.value })}
            required
            maxLength={256}
            className="mt-1"
          />
        </label>
        {onRemove ? (
          <Button type="button" variant="ghost" onClick={onRemove}>
            remove step
          </Button>
        ) : null}
      </div>
      {step.type === 'event' ? (
        <div className="grid items-end gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-xs">
            optional property
            <Input
              aria-label={`Step ${index + 1} property`}
              value={step.property}
              onChange={(event) => update({ property: event.target.value })}
              maxLength={40}
              className="mt-1"
            />
          </label>
          <LabeledSelect
            label={`Step ${index + 1} value type`}
            value={step.valueType}
            onValueChange={(valueType) => update({ valueType })}
            options={[
              { value: 'text', label: 'text' },
              { value: 'number', label: 'number' },
              { value: 'boolean', label: 'true / false' },
            ]}
          />
          <label className="space-y-1 text-xs">
            equals
            <Input
              aria-label={`Step ${index + 1} equals`}
              value={step.equals}
              onChange={(event) => update({ equals: event.target.value })}
              maxLength={200}
              className="mt-1"
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}

export function ConversionEditor({
  onSave,
  busy,
  initial,
}: {
  onSave: (definition: AnalysisDefinition) => Promise<void>;
  busy: boolean;
  initial?: ConversionDefinition;
}) {
  const [kind, setKind] = useState<'goal' | 'funnel'>(initial?.kind ?? 'goal');
  const [name, setName] = useState(initial?.name ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    initial
      ? (initial.kind === 'goal' ? [initial.step] : initial.steps).map(draftStep)
      : [freshStep()],
  );
  const [hours, setHours] = useState(
    String(initial?.kind === 'funnel' ? initial.window_ms / 3600000 : 24),
  );
  const [error, setError] = useState('');
  const changeKind = (value: string) => {
    const next = value as 'goal' | 'funnel';
    setKind(next);
    setSteps((current) =>
      next === 'goal'
        ? current.slice(0, 1)
        : [...current.slice(0, 1), { ...freshStep(), type: 'event', target: 'signup.completed' }],
    );
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const invalidCondition = conditionError(steps);
    if (invalidCondition) {
      setError(invalidCondition);
      return;
    }
    const parsed = AnalysisDefinition.safeParse(
      kind === 'goal'
        ? { kind, name, step: parseStep(steps[0]) }
        : {
            kind,
            name,
            steps: steps.map(parseStep),
            window_ms: Number(hours) * 3600000,
            ...(initial?.kind === 'funnel' && initial.segment ? { segment: initial.segment } : {}),
          },
    );
    if (!parsed.success) {
      setError(
        'Enter a name and valid steps. Use event names, page paths, and a conversion window between one second and seven days.',
      );
      return;
    }
    try {
      await onSave(parsed.data);
      if (!initial) setName('');
    } catch {
      setError('Could not save this definition. Retry without changing the form.');
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-4 border-t pt-4"
      aria-label={initial ? 'Edit conversion definition' : 'Create conversion definition'}
    >
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <LabeledSelect
          label="Conversion type"
          value={kind}
          onValueChange={changeKind}
          options={[
            { value: 'goal', label: 'goal' },
            { value: 'funnel', label: 'ordered funnel' },
          ]}
        />
        <label className="space-y-1 text-xs">
          name
          <Input
            aria-label="Conversion name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            className="mt-1"
            placeholder="Pricing to paid signup"
          />
        </label>
      </div>
      {steps.map((step, index) => (
        <StepFields
          key={index}
          step={step}
          index={index}
          onChange={(value) =>
            setSteps((current) =>
              current.map((item, position) => (position === index ? value : item)),
            )
          }
          onRemove={
            kind === 'funnel' && steps.length > 2
              ? () => setSteps((current) => current.filter((_, position) => position !== index))
              : undefined
          }
        />
      ))}
      {kind === 'funnel' ? (
        <div className="flex flex-wrap items-end gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={steps.length >= 8}
            onClick={() => setSteps((current) => [...current, freshStep()])}
          >
            add step
          </Button>
          <label className="space-y-1 text-xs">
            conversion window, hours
            <Input
              aria-label="Conversion window hours"
              type="number"
              step="any"
              min={1 / 3600}
              max="168"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              className="mt-1 w-32"
            />
          </label>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? 'saving…' : `${initial ? 'save' : 'create'} ${kind}`}
      </Button>
    </form>
  );
}
