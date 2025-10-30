export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} Tag${days === 1 ? '' : 'e'}`);
  }
  if (remainingHours > 0) {
    parts.push(`${remainingHours} Stunde${remainingHours === 1 ? '' : 'n'}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} Minute${minutes === 1 ? '' : 'n'}`);
  }
  if (parts.length === 0 && seconds > 0) {
    parts.push(`${seconds} Sekunde${seconds === 1 ? '' : 'n'}`);
  }

  return parts.join(' ');
}
