/** Single source for the phone layout breakpoint used by media queries and JS checks. */
export const PHONE_MAX_QUERY = "(max-width: 800px)";

/**
 * Portrait tablets (801-960px) cannot fit the full control row either: it wrapped into a
 * two-row bar that covered a quarter of the picture. They use the compact row as well,
 * which keeps the player controls one line on every portrait screen.
 */
export const COMPACT_CONTROLS_MAX_QUERY = "(max-width: 960px)";
