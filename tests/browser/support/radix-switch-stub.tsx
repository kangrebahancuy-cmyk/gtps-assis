/**
 * Stand-in for @radix-ui/react-switch (not installed here). Same contract the app relies on: a button with
 * role="switch", aria-checked, data-state, and onCheckedChange. The real Radix behaviour is not tested.
 */
import { forwardRef, useState, type ButtonHTMLAttributes, type HTMLAttributes } from "react";

type RootProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { checked?: boolean; defaultChecked?: boolean; onCheckedChange?: (checked: boolean) => void };

export const Root = forwardRef<HTMLButtonElement, RootProps>(function Root({ checked, defaultChecked, onCheckedChange, children, onClick, ...rest }, ref) {
  const [inner, setInner] = useState(defaultChecked ?? false);
  const value = checked ?? inner;
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={value}
      data-state={value ? "checked" : "unchecked"}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        setInner(!value);
        onCheckedChange?.(!value);
      }}
    >
      {children}
    </button>
  );
});

export const Thumb = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function Thumb(props, ref) {
  return <span ref={ref} {...props} />;
});
