import { useEffect, useState } from 'react';

/**
 * Feature 20 D-10: the app's hash routes, `#/<area>/<id>`. Each owning feature declares its area and listens for it;
 * search builds links to them without knowing the feature. The one place to replace if real routing arrives.
 */

export interface RouteTarget {
  readonly id: string;
  /** Increments per navigation, so following the same link twice selects again. */
  readonly seq: number;
}

const EVENT = 'hashchange';

export function routeHref(area: string, id: string): string {
  return `#/${area}/${encodeURIComponent(id)}`;
}

/** The ID a hash names for `area`, if it names one. */
export function routeId(hash: string, area: string): string | undefined {
  const prefix = `#/${area}/`;
  if (!hash.startsWith(prefix)) return undefined;
  const id = decodeURIComponent(hash.slice(prefix.length));
  return id === '' ? undefined : id;
}

/** Follows a route; re-announces it when it is already the current one. */
export function followRoute(href: string): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash === href) window.dispatchEvent(new Event(EVENT));
  else window.location.hash = href;
}

/** The current target of `area`, updated on every navigation. */
export function useRouteTarget(area: string): RouteTarget | undefined {
  const [target, setTarget] = useState<RouteTarget>();
  useEffect(() => {
    let seq = 0;
    const read = () => {
      const id = routeId(window.location.hash, area);
      if (id === undefined) return;
      seq += 1;
      setTarget({ id, seq });
    };
    read();
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, [area]);
  return target;
}
