import {
  forwardRef,
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
} from "react";

export const DetailsMenu = forwardRef<
  HTMLDetailsElement,
  ComponentPropsWithoutRef<"details">
>(function DetailsMenu(props, forwardedRef) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const dismiss = (event: Event) => {
      const menu = ref.current;
      if (
        menu?.open &&
        event.target instanceof Node &&
        !menu.contains(event.target) &&
        !(event.type === "focusin" && event.target.contains(menu))
      ) {
        menu.open = false;
      }
    };
    // Safari can blur the summary without focusing a clicked menu button.
    // Dismiss by the actual pointer/focus destination, not a null relatedTarget.
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss, true);
    };
  }, []);
  return (
    <details
      {...props}
      ref={(element) => {
        ref.current = element;
        if (typeof forwardedRef === "function") forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      }}
    />
  );
});
