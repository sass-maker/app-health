import { useState } from 'react';
import { Check, Copy, WandSparkles } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { createAgentSetupPrompt, type AgentSetupCapability } from './agent-setup-prompt.js';

export function AgentSetupPrompt(props: {
  project: { name: string; appId: string; environmentId: string; environment: string };
  capabilities: AgentSetupCapability[];
  publicKey?: string;
  analyticsSnippet?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const CopyIcon = copied ? Check : Copy;
  const prompt = createAgentSetupPrompt(props);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-base">
          <WandSparkles className="size-4 text-primary" /> Give an agent the setup task
        </CardTitle>
        <p className="text-sm leading-6 text-muted-foreground">
          Copy a project-scoped prompt for an authenticated coding agent. It includes the selected
          environment and safe integration boundaries.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 pt-5">
        <textarea
          aria-label="Agent setup prompt"
          readOnly
          value={prompt}
          className="min-h-56 w-full resize-y rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" onClick={() => void copy()}>
            <CopyIcon />
            {copied ? 'Copied' : 'Copy prompt'}
          </Button>
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {copied
              ? 'Prompt copied to clipboard.'
              : 'The prompt remains selectable if clipboard access is unavailable.'}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
