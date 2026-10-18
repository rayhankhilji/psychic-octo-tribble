/**
 * The marks of the services a founder connects, drawn as inline SVG so they
 * stay sharp at any size and follow day and night. Each follows its owner's
 * brand guidelines: the official shapes and colours, never stretched or
 * recoloured, with clear space around them inside a tile.
 *
 * - Stripe: the white "S" on Stripe's blurple (#635BFF) square, the badge
 *   Stripe itself uses for its app icon. Same by day and night.
 * - GitHub: the Invertocat mark, in GitHub's near-black by day and white by
 *   night (GitHub allows only those two).
 * - PostHog: the full-colour logomark from posthog.com/brand. The hedgehog's
 *   head is near-black by day and white by night, as in PostHog's dark logo.
 * - Google Analytics: the three-part mark in Google's yellow and orange.
 * - Manual and paying customers: our own line icons (src/ui/icons.ts style),
 *   because they're TinyTown things, not companies.
 *
 * Colours that change at night are set in hosted.css (`.bm-*` classes), so
 * the SVG never needs re-rendering when the sky changes.
 */

export type BrandName = 'stripe' | 'github' | 'posthog' | 'ga4' | 'manual' | 'customers';

/** Official names, for alt text and labels. */
export const BRAND_NAMES: Record<BrandName, string> = {
  stripe: 'Stripe',
  github: 'GitHub',
  posthog: 'PostHog',
  ga4: 'Google Analytics',
  manual: 'A number you set',
  customers: 'Paying customers',
};

const STRIPE_S =
  'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z';

const OCTOCAT =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

/** PostHog's logomark (52 × 28): three bands of spines, each a gradient, and the head. */
const POSTHOG_PARTS: { d: string; grad: number }[] = [
  { d: 'M10.74 7.16 4.54.8A2.66 2.66 0 0 0 0 2.66V7.5l10.74 11.18z', grad: 6 },
  { d: 'M9.19 28h1.55v-9.32L0 7.5v10.73z', grad: 7 },
  { d: 'M0 25.41A2.6 2.6 0 0 0 2.58 28H9.2L0 18.23z', grad: 8 },
  { d: 'M10.74 2.66v4.5l11.22 11.52V7.63L15.3.8a2.66 2.66 0 0 0-4.56 1.86', grad: 3 },
  { d: 'M10.74 28h8.96l-8.96-9.32z', grad: 4 },
  { d: 'M10.74 7.16v11.52L19.7 28h2.26v-9.32z', grad: 5 },
  { d: 'M21.96 2.67v4.96l11.3 11.6h.02V7.75L26.63.85a2.8 2.8 0 0 0-2-.85 2.67 2.67 0 0 0-2.67 2.67', grad: 0 },
  { d: 'M21.96 7.63v11.05L31.03 28h2.25v-8.75z', grad: 1 },
  { d: 'M21.96 28h9.07l-9.07-9.32z', grad: 2 },
];
const POSTHOG_HEAD = 'M51.66 25.22A1.9 1.9 0 0 0 50 23.33l-.34-.04c-1-.13-1.94-.6-2.65-1.33L33.28 7.75V28H49a2.66 2.66 0 0 0 2.67-2.67zM39.2 23.54h-.09a1.78 1.78 0 1 1 .1 0';
/** [x1, x2, y, from, to] for each band's horizontal gradient. */
const POSTHOG_GRADS: [number, number, number, string, string, number][] = [
  [21.96, 33.28, 9.62, '#ffd849', '#fbae01', 0.96],
  [21.96, 33.28, 17.81, '#ffb700', '#f9aa01', 1],
  [21.96, 31.03, 23.34, '#ff9500', '#f8aa00', 1],
  [10.74, 21.96, 9.34, '#ff651e', '#e4400a', 1],
  [10.74, 19.7, 23.34, '#c42c00', '#d63600', 1],
  [10.74, 21.96, 17.58, '#ef3c00', '#d63601', 1],
  [0, 10.74, 9.34, '#3f80ff', '#084fe0', 1],
  [0, 10.74, 17.75, '#0255ff', '#0145d2', 1],
  [0, 9.19, 23.11, '#0041c6', '#0045d0', 1],
];

/** Google Analytics: the tall bar, the short bar and the dot. */
const GA_TALL =
  'M22.84 2.9982v17.9987c.0086 1.6473-1.3197 2.9897-2.967 2.9984a2.9808 2.9808 0 01-.3677-.0208c-1.528-.226-2.6477-1.5558-2.6105-3.1V3.1204c-.0369-1.5458 1.0856-2.8762 2.6157-3.1 1.6361-.1915 3.1178.9796 3.3093 2.6158.014.1201.0208.241.0202.3619z';
const GA_DOT = 'M4.1326 18.0548c-1.6417 0-2.9726 1.331-2.9726 2.9726C1.16 22.6691 2.4909 24 4.1326 24s2.9726-1.3309 2.9726-2.9726-1.331-2.9726-2.9726-2.9726z';
const GA_MID =
  'M12.0054 9.045c-.0171 0-.0342 0-.0513.0003-1.6495.0904-2.9293 1.474-2.891 3.1256v7.9846c0 2.167.9535 3.4825 2.3505 3.763 1.6118.3266 3.1832-.7152 3.5098-2.327.04-.1974.06-.3983.0593-.5998v-8.9585c.003-1.6474-1.33-2.9852-2.9773-2.9882z';

/** Gradient ids must be unique per document, or a hidden first copy can blank the others. */
let gradSeq = 0;

const svg = (viewBox: string, body: string, cls: string) =>
  `<svg class="bm ${cls}" viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;

/** Just the mark, sized by CSS (`.bm` is 1em square unless a class says otherwise). */
export function brandMark(name: BrandName): string {
  switch (name) {
    case 'stripe':
      // The badge: blurple square, white S with Stripe's own inset.
      return svg('0 0 32 32', `<rect width="32" height="32" rx="7.5" fill="#635bff"/><g transform="translate(6.88 7) scale(.75)"><path fill="#fff" d="${STRIPE_S}"/></g>`, 'bm-stripe');
    case 'github':
      return svg('0 0 24 24', `<path class="bm-ink" fill="currentColor" d="${OCTOCAT}"/>`, 'bm-github');
    case 'posthog': {
      const id = `ph${++gradSeq}`;
      const defs = POSTHOG_GRADS.map(
        ([x1, x2, y, a, b, at], i) =>
          `<linearGradient id="${id}-${i}" x1="${x1}" x2="${x2}" y1="${y}" y2="${y}" gradientUnits="userSpaceOnUse"><stop stop-color="${a}"/><stop offset="${at}" stop-color="${b}"/></linearGradient>`,
      ).join('');
      const parts = POSTHOG_PARTS.map((p) => `<path fill="url(#${id}-${p.grad})" d="${p.d}"/>`).join('');
      return svg('0 0 52 28', `<defs>${defs}</defs>${parts}<path class="bm-ph-head" fill="#111" d="${POSTHOG_HEAD}"/>`, 'bm-posthog');
    }
    case 'ga4':
      return svg('0 0 24 24', `<path fill="#f9ab00" d="${GA_TALL}"/><path fill="#e37400" d="${GA_MID}"/><path fill="#e37400" d="${GA_DOT}"/>`, 'bm-ga4');
    case 'manual':
      // A tally card: the number you type, with a pencil. Our line style.
      return `<svg class="bm bm-line" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2.8" y="4.2" width="11" height="11.6" rx="2"/><path d="M5.6 8.2h5.4M5.6 11.4h3.4"/><path d="m12.6 14.6 4.6-4.6a1.2 1.2 0 0 0-1.7-1.7l-4.6 4.6-.5 2.2Z" fill="var(--surface-solid, #fff)"/></svg>`;
    case 'customers':
      // Two residents and a receipt line: the people who pay you, living in the city.
      return `<svg class="bm bm-line" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="7.5" cy="7.2" r="2.6"/><path d="M2.8 15.8c.5-2.4 2.4-3.8 4.7-3.8s4.2 1.4 4.7 3.8"/><circle cx="14" cy="6.6" r="2.1"/><path d="M13.8 10.8c1.9 0 3.4 1.2 3.8 3.2"/></svg>`;
  }
}

/**
 * The mark in its tile: a square with clear space all round (a quarter of
 * the tile, the rule most brand books ask for). Stripe's badge is its own
 * tile, so it fills the square edge to edge instead.
 */
export function brandTile(name: BrandName, size: 'sm' | 'md' | 'lg' = 'md'): string {
  return `<span class="brand-tile bt-${name} bt-${size}" role="img" aria-label="${BRAND_NAMES[name]}">${brandMark(name)}</span>`;
}
