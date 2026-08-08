import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { Toggle as TogglePrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

const toggleVariants = cva(
  // border-0 is explicit (only the outline variant sets its own border) —
  // without it the default variant shows the browser's native 2px outset
  // button border while Tailwind preflight is off. See the memory on this
  // (same issue, same fix, as buttonVariants in button.jsx).
  "inline-flex items-center justify-center gap-2 rounded-md border-0 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none hover:bg-muted hover:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // bg-transparent/text-foreground are explicit on the unpressed state
      // (data-[state=on] sets its own bg-accent/text-accent-foreground) —
      // native <button>s don't reset UA chrome or inherit color while
      // Tailwind preflight is off. See the memory on this.
      variant: {
        default: "bg-transparent text-foreground",
        outline:
          "border border-input bg-transparent text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 min-w-9 px-2",
        sm: "h-8 min-w-8 px-1.5",
        lg: "h-10 min-w-10 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// forwardRef so Toggle can be an asChild/Anchor target of Radix components.
// See the note in dialog.jsx on why these wrappers outlived React 18.
const Toggle = forwardRef(function Toggle(
  { className, variant, size, ...props },
  ref,
) {
  return (
    <TogglePrimitive.Root
      ref={ref}
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { Toggle, toggleVariants };
