import { useState } from 'react';
import { Button } from './components/ui/button.js';

export function GoogleSignIn(): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(() =>
    new URLSearchParams(window.location.search).has('error') ||
    new URLSearchParams(window.location.search).get('signin') === 'failed'
      ? 'Sign-in did not complete. Please try again.'
      : '',
  );
  async function signIn(): Promise<void> {
    setPending(true);
    setError('');
    try {
      const returnUrl = new URL(window.location.href);
      returnUrl.pathname = '/app';
      const callbackURL = `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
      returnUrl.searchParams.set('signin', 'failed');
      const errorCallbackURL = `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
      const response = await fetch('/v1/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          callbackURL,
          errorCallbackURL,
        }),
      });
      if (!response.ok) throw new Error('Google sign-in could not start. Please try again.');
      const data = (await response.json()) as { url?: string };
      const url = new URL(data.url ?? '');
      if (url.origin !== 'https://accounts.google.com')
        throw new Error('Unexpected sign-in destination.');
      window.location.assign(url.href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
      setPending(false);
    }
  }
  return (
    <div className="space-y-3">
      <Button className="h-11 w-full" disabled={pending} onClick={() => void signIn()}>
        {pending ? 'Connecting to Google…' : 'Continue with Google'}
      </Button>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
