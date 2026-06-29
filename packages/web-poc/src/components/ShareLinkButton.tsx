import { ActionIcon, CopyButton, Tooltip } from "@mantine/core";

/** Minimal monochrome (theme-aware) glyphs — the app has no icon library. */
const LinkGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);
const CheckGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/**
 * Copy a deep link to this observation/problem so it can be shared. The link is
 * `…/?<kind>=<id>`; the app reads that param on load and opens the item (see the
 * deep-link effect in `App.tsx`).
 */
export function ShareLinkButton({ kind, id }: { kind: "observation" | "problem"; id: string }) {
  const url = `${window.location.origin}${window.location.pathname}?${kind}=${id}`;
  return (
    <CopyButton value={url}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Link copied" : "Copy share link"} withArrow>
          <ActionIcon
            variant="default"
            size="md"
            aria-label="Copy share link"
            color={copied ? "teal" : undefined}
            onClick={copy}
          >
            {copied ? <CheckGlyph /> : <LinkGlyph />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}
