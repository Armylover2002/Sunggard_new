import { useEffect } from 'react';

/**
 * Locks page scroll while `active` is true — for modals, drawers, sheets.
 *
 * Setting `body.style.overflow = 'hidden'` alone does nothing here: the app
 * runs Lenis smooth-scroll (see LenisScroll.jsx), which drives the scroll
 * position on `<html>`, not `<body>`. A lock that only touches body is a
 * no-op against it, so the background keeps scrolling behind the modal.
 * Locking `<html>` too empties Lenis's scrollable range, and pinning body to
 * `position: fixed` at the negative scroll offset blocks native scroll and
 * keeps the page from jumping to the top while locked.
 */
export default function useBodyScrollLock(active) {
    useEffect(() => {
        if (!active) return undefined;

        const scrollY = window.scrollY;
        const { overflow: prevBodyOverflow, position: prevBodyPosition, top: prevBodyTop, width: prevBodyWidth } =
            document.body.style;
        const prevHtmlOverflow = document.documentElement.style.overflow;

        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.width = '100%';
        document.documentElement.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = prevBodyOverflow;
            document.body.style.position = prevBodyPosition;
            document.body.style.top = prevBodyTop;
            document.body.style.width = prevBodyWidth;
            document.documentElement.style.overflow = prevHtmlOverflow;
            window.scrollTo(0, scrollY);
        };
    }, [active]);
}
