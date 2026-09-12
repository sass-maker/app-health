import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AgentSetupPrompt } from '../src/AgentSetupPrompt.js';

const project = {
  name: 'Storefront',
  appId: 'app-1',
  environmentId: 'env-1',
  environment: 'production',
};

it('renders an executable scoped prompt without private credential instructions', () => {
  render(<AgentSetupPrompt project={project} capabilities={['analytics', 'logs', 'endpoints']} />);
  const prompt = screen.getByLabelText('Agent setup prompt') as HTMLTextAreaElement;
  expect(prompt.value).toContain('Storefront');
  expect(prompt.value).toContain('app-1');
  expect(prompt.value).toContain('https://health.sassmaker.com');
  expect(prompt.value).toContain('HTTP 202');
  expect(prompt.value).toContain('Never expose private server keys');
  expect(prompt.value).toContain('print cookies/tokens');
});

it('provides accessible clipboard feedback', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<AgentSetupPrompt project={project} capabilities={['analytics']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Prompt copied');
  expect(writeText).toHaveBeenCalledOnce();
});

it('includes the revealed public key and exact script without creating another key', () => {
  render(
    <AgentSetupPrompt
      project={project}
      capabilities={['analytics']}
      publicKey="ahk_pub_test"
      analyticsSnippet='<script data-project="app-1" data-identity="persistent"></script>'
    />,
  );
  const prompt = screen.getByLabelText('Agent setup prompt') as HTMLTextAreaElement;
  expect(prompt.value).toContain('ahk_pub_test');
  expect(prompt.value).toContain('reuse the supplied public key');
  expect(prompt.value).toContain('data-identity="persistent"');
  expect(prompt.value).not.toContain('Endpoint health must');
});

it('keeps the complete prompt selectable when clipboard access fails', async () => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  render(<AgentSetupPrompt project={project} capabilities={['logs']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  expect(await screen.findByRole('status')).toHaveTextContent('selectable');
  expect(screen.getByLabelText('Agent setup prompt')).toHaveProperty('readOnly', true);
});
