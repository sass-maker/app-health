import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversionEditor } from '../src/ConversionEditor.js';

async function select(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function submit() {
  fireEvent.submit(screen.getByRole('form'));
}

describe('conversion definition editor', () => {
  it.each([
    ['text', 'pro', 'pro'],
    ['number', '0', 0],
    ['true / false', 'false', false],
  ] as const)(
    'creates an event goal with a %s property condition',
    async (type, entered, expected) => {
      const save = vi.fn().mockResolvedValue(undefined);
      render(<ConversionEditor busy={false} onSave={save} />);
      fill('Conversion name', 'Qualified signup');
      await select('Step 1 type', 'product event');
      fill('Step 1 target', 'signup.completed');
      fill('Step 1 property', 'plan');
      await select('Step 1 value type', type);
      fill('Step 1 equals', entered);
      submit();
      await waitFor(() =>
        expect(save).toHaveBeenCalledWith({
          kind: 'goal',
          name: 'Qualified signup',
          step: { type: 'event', target: 'signup.completed', property: 'plan', equals: expected },
        }),
      );
      await waitFor(() => expect(screen.getByLabelText('Conversion name')).toHaveValue(''));
    },
  );
  it('creates an ordered funnel with a deliberate window and bounds added steps', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<ConversionEditor busy={false} onSave={save} />);
    fill('Conversion name', 'Pricing to signup');
    fill('Step 1 target', '/pricing/*');
    await select('Conversion type', 'ordered funnel');
    expect(screen.getByLabelText('Step 2 target')).toHaveValue('signup.completed');
    fill('Conversion window hours', '2');
    fireEvent.click(screen.getByRole('button', { name: 'add step' }));
    fill('Step 3 target', '/account');
    fireEvent.click(screen.getAllByRole('button', { name: 'remove step' })[2]);
    submit();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        kind: 'funnel',
        name: 'Pricing to signup',
        steps: [
          { type: 'page', target: '/pricing/*' },
          { type: 'event', target: 'signup.completed' },
        ],
        window_ms: 7200000,
      }),
    );
    for (let index = 2; index < 8; index++)
      fireEvent.click(screen.getByRole('button', { name: 'add step' }));
    expect(screen.getByRole('button', { name: 'add step' })).toBeDisabled();
    await select('Conversion type', 'goal');
    expect(screen.queryByLabelText('Step 2 target')).toBeNull();
    expect(screen.getByLabelText('Step 1 target')).toHaveValue('/pricing/*');
  });
  it('rejects missing numeric values, malformed boolean values and invalid definitions without sending them', async () => {
    const save = vi.fn();
    render(<ConversionEditor busy={false} onSave={save} />);
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name and valid steps');
    fill('Conversion name', 'Validation');
    await select('Step 1 type', 'product event');
    fill('Step 1 target', 'signup');
    fill('Step 1 property', 'count');
    await select('Step 1 value type', 'number');
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('zero must be entered explicitly');
    await select('Step 1 value type', 'true / false');
    fill('Step 1 equals', 'yes');
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('true or false');
    expect(save).not.toHaveBeenCalled();
    await select('Step 1 type', 'page visit');
    fill('Step 1 target', '/pricing');
    submit();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        kind: 'goal',
        name: 'Validation',
        step: { type: 'page', target: '/pricing' },
      }),
    );
  });
  it('preserves an unsaved form after a failed request and prevents another submit while saving', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    const view = render(<ConversionEditor busy={false} onSave={save} />);
    fill('Conversion name', 'Landing');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry without changing the form');
    expect(screen.getByLabelText('Conversion name')).toHaveValue('Landing');
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    view.rerender(<ConversionEditor busy onSave={save} />);
    expect(screen.getByRole('button', { name: 'saving…' })).toBeDisabled();
  });
  it('initializes an existing funnel from its original property types, segment and window', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversionEditor
        busy={false}
        onSave={save}
        initial={{
          kind: 'funnel',
          name: 'Activation',
          steps: [
            { type: 'event', target: 'signup', property: 'seats', equals: 2 },
            { type: 'event', target: 'activated', property: 'paid', equals: true },
          ],
          segment: { country: 'US' },
          window_ms: 1800000,
        }}
      />,
    );
    expect(screen.getByLabelText('Step 1 equals')).toHaveValue('2');
    expect(screen.getByRole('combobox', { name: 'Step 1 value type' })).toHaveTextContent('number');
    expect(screen.getByRole('combobox', { name: 'Step 2 value type' })).toHaveTextContent(
      'true / false',
    );
    expect(screen.getByLabelText('Conversion window hours')).toHaveValue(0.5);
    fill('Conversion name', 'Paid activation');
    submit();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        kind: 'funnel',
        name: 'Paid activation',
        steps: [
          { type: 'event', target: 'signup', property: 'seats', equals: 2 },
          { type: 'event', target: 'activated', property: 'paid', equals: true },
        ],
        segment: { country: 'US' },
        window_ms: 1800000,
      }),
    );
    expect(screen.getByLabelText('Conversion name')).toHaveValue('Paid activation');
  });
});
