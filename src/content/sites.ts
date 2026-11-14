/**
 * Built-in rules for sites the general heuristics read badly. Lector works everywhere
 * without them; a rule only says what a site's markup means where that can't be guessed,
 * such as which parts of a page are its interface rather than its text.
 *
 * Keep rules to stable hooks the site itself relies on: custom element names, slots, ids,
 * data and aria attributes. Generated class names change with every deploy; where a site
 * has nothing else, match the readable component name inside one (`[class*="-Dek"]`),
 * never the hash.
 */

export type SiteRule = {
  name: string;
  hosts: RegExp;
  /** Only on pages whose path matches. */
  paths?: RegExp;
  /** Elements whose text is never read (CSS selectors, matched inside shadow roots too). */
  skip?: string[];
  /** Blocks never read, by their whole text, for labels with no element to point at. */
  skipText?: RegExp[];
  /**
   * Elements read even where Lector's general filters would drop them: text the site hides
   * from screen readers (aria-hidden) but shows on screen, or short link-only text.
   */
  keep?: string[];
  /**
   * The text itself: when the page has these, nothing outside them is read. If none are
   * found (the site changed), the rule is ignored and the page is read as usual.
   */
  only?: string[];
};

const RULES: SiteRule[] = [
  {
    name: 'reddit',
    hosts: /(^|\.)reddit\.com$/,
    skip: [
      // ads, in the feed, between comments and in the side rail
      'shreddit-ad-post',
      'shreddit-comments-page-ad',
      'ad-event-tracker',
      'reddit-pdp-right-rail-post',
      // a post's subreddit, author and time; its votes, comment count and share buttons
      '[slot="credit-bar"]',
      '[slot="authorName"]',
      'rpl-action-bar',
      '[data-testid="action-row"]',
      'shreddit-post-flair',
      // a comment's author, flair and badges; its votes and reply buttons
      '[slot="commentMeta"]',
      'shreddit-comment-action-row',
      // "12 more replies", "View more comments"
      'faceplate-tracker[noun="more_replies"]',
      'faceplate-partial[slot="children"] > [slot="loading"]',
      'shreddit-comment-tree-ad',
      // "View Post in" Français, Deutsch, …
      '[id$="_translations"]',
      // a subreddit's banner: name, visitor counts
      '.masthead',
      // site chrome around the thread
      'reddit-header-large',
      'shreddit-app > [slot="header"]',
      '#right-sidebar-container',
      'community-highlight-carousel',
    ],
  },
  {
    name: 'wsj',
    hosts: /(^|\.)wsj\.com$/,
    skip: [
      // the market ticker along the top
      '[aria-label="Market Data"]',
      // Subscribe / Sign In, and the paywall box over an article
      '[id^="cx-"]',
      '[class*="-LoginButtonsWrapper"]',
      // ads
      '[data-testid^="ad-container"]',
      // "EXCLUSIVE", "opinion" flags; dates under headlines
      '[data-testid="content-tag"]',
      '[data-testid="timestamp-text"]',
      // stock chips inside the text: "Nvidia’s NVDA -2.01% bets" reads "Nvidia’s bets"
      'a[href*="mod=article_chiclet"]:not([data-type="company"])',
      // the Polymarket odds box
      'prediction-market',
      // Buy Side: shopping recommendations mixed into the news
      'a[href*="/buyside/"]',
    ],
    skipText: [/^explore wsj buy side$/i, /^reviews and recommendations, independent of the wall street journal/i],
    // the summary under a headline: a second link to the story, hidden from screen readers
    keep: ['a[aria-hidden="true"]:has([data-testid="flexcard-text"])'],
  },
  {
    name: 'wsj article',
    hosts: /(^|\.)wsj\.com$/,
    paths: /^\/(articles|opinion|lifestyle|finance|business|tech|world|us-news|politics|economy|real-estate|personal-finance|health|arts-culture|style|sports)\/.+/,
    // the headline, the line under it, and the body; not the bylines, related stories and
    // video rails around them
    only: ['h1', 'h2[class*="Dek"]', 'section p[data-type="paragraph"]', 'section h2', 'section h3', 'section blockquote'],
  },
];

export type SiteConfig = { skip: string; skipText: RegExp[]; keep: string; only: string; names: string[] };

/** The rules that apply to this page, merged. */
export function siteConfig(url: { hostname: string; pathname: string } = location): SiteConfig {
  const rules = RULES.filter((r) => r.hosts.test(url.hostname) && (!r.paths || r.paths.test(url.pathname)));
  return {
    skip: rules.flatMap((r) => r.skip ?? []).join(', '),
    skipText: rules.flatMap((r) => r.skipText ?? []),
    keep: rules.flatMap((r) => r.keep ?? []).join(', '),
    only: rules.flatMap((r) => r.only ?? []).join(', '),
    names: rules.map((r) => r.name),
  };
}
