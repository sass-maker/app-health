/** Poll only while the dashboard is visible; refresh promptly on returning to it. */
export function pollWhileVisible(refresh: () => void, delay: number): () => void {
  let timer: number | undefined;
  const start = () => {
    if (document.visibilityState !== 'hidden') timer = window.setInterval(refresh, delay);
  };
  const visibility = () => {
    window.clearInterval(timer);
    if (document.visibilityState !== 'hidden') refresh();
    start();
  };
  start();
  document.addEventListener('visibilitychange', visibility);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', visibility);
  };
}
