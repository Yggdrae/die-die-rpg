import { type ReactNode, useEffect, useState } from 'react';

/** The product mark, shown on the sign-in card and in the top bar. */
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        d20
      </span>
      <span className="brand-name">RPG Companion</span>
    </span>
  );
}

export interface ShellArea {
  /** The element ID of the area's panel; never a hash route (`#/<area>/<id>` stays the features'). */
  readonly id: string;
  readonly label: string;
}

export interface ShellAreaGroup {
  readonly label: string;
  readonly areas: readonly ShellArea[];
}

/** The area panel nearest the top of the viewport, for the side navigation's current marker. */
function useCurrentArea(ids: readonly string[]): string | undefined {
  const [current, setCurrent] = useState<string>();
  const key = ids.join(' ');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        const order = key.split(' ');
        const first = order.find((id) => visible.has(id));
        if (first !== undefined) setCurrent(first);
      },
      { rootMargin: '-72px 0px -55% 0px' },
    );
    for (const id of key.split(' ')) {
      const element = document.getElementById(id);
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);
  return current;
}

/**
 * The dashboard's area navigation. Every area stays rendered (feature routes scroll their own
 * panel into view); the navigation only scrolls, so it never changes the location hash.
 */
export function SideNav(props: { readonly groups: readonly ShellAreaGroup[] }) {
  const ids = props.groups.flatMap((group) => group.areas.map((area) => area.id));
  const current = useCurrentArea(ids);
  return (
    <aside className="sidenav">
      <nav aria-label="Campaign areas">
        {props.groups
          .filter((group) => group.areas.length > 0)
          .map((group) => (
            <div key={group.label}>
              <p className="sidenav-title">{group.label}</p>
              <ul>
                {group.areas.map((area) => (
                  <li key={area.id}>
                    <a
                      href={`#${area.id}`}
                      aria-current={current === area.id ? 'location' : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        document.getElementById(area.id)?.scrollIntoView({ block: 'start' });
                      }}
                    >
                      {area.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </nav>
    </aside>
  );
}

/** One dashboard area: a card the side navigation can scroll to. */
export function Panel(props: { readonly id: string; readonly children: ReactNode }) {
  return (
    <div id={props.id} className="panel">
      {props.children}
    </div>
  );
}
