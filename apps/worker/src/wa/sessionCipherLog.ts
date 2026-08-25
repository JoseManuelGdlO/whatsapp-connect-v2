const PREFIX = 'Closing session';

export function installSessionCipherLogFilter(): () => void {
  const original = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith(PREFIX)) return;
    original(...args);
  };
  return () => {
    console.log = original;
  };
}
