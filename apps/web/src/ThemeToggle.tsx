import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from './components/ui/button.js';
export function ThemeToggle(): JSX.Element {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light');
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('app-health-theme', next ? 'dark' : 'light');
    } catch {
      /* Theme remains usable without storage. */
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11 text-muted-foreground"
      aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
      onClick={toggle}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
