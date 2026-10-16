import { useEffect, useState, type ReactElement } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@saas-maker/ui/components/button';
export function ThemeToggle(): ReactElement {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    setDark(document.documentElement.dataset.theme !== 'light');
  }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    document.documentElement.dataset.mode = document.documentElement.dataset.theme;
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
