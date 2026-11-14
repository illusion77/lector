const svg = (body: string, view = '0 0 24 24') =>
  `<svg viewBox="${view}" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = {
  play: svg('<path d="M8.2 5.2v13.6c0 .95 1.04 1.5 1.83.98l10.2-6.8a1.18 1.18 0 0 0 0-1.96L10.03 4.22c-.79-.52-1.83.03-1.83.98Z" fill="currentColor"/>'),
  pause: svg('<rect x="6.2" y="4.8" width="4.2" height="14.4" rx="1.4" fill="currentColor"/><rect x="13.6" y="4.8" width="4.2" height="14.4" rx="1.4" fill="currentColor"/>'),
  prev: svg(
    '<rect x="4.6" y="5.4" width="2.4" height="13.2" rx="1.2" fill="currentColor"/><path d="M19.2 6.15v11.7c0 .86-.95 1.37-1.66.9l-8.65-5.85a1.08 1.08 0 0 1 0-1.8l8.65-5.85c.71-.47 1.66.04 1.66.9Z" fill="currentColor"/>',
  ),
  next: svg(
    '<rect x="17" y="5.4" width="2.4" height="13.2" rx="1.2" fill="currentColor"/><path d="M4.8 6.15v11.7c0 .86.95 1.37 1.66.9l8.65-5.85a1.08 1.08 0 0 0 0-1.8L6.46 5.25c-.71-.47-1.66.04-1.66.9Z" fill="currentColor"/>',
  ),
  settings: svg(
    '<path d="M4 7.5h8.6M17.4 7.5H20M4 16.5h2.6M11.4 16.5H20" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/><circle cx="15" cy="7.5" r="2.4" stroke="currentColor" stroke-width="1.9" fill="none"/><circle cx="9" cy="16.5" r="2.4" stroke="currentColor" stroke-width="1.9" fill="none"/>',
  ),
  minus: svg('<path d="M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'),
  plus: svg('<path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'),
  check: svg('<path d="M3 8.6 6.4 12 13 4.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>', '0 0 16 16'),
};
