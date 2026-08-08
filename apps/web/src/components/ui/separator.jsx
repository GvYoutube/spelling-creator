"use client";

import { forwardRef } from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// forwardRef so this can be an asChild/Slot target — see the
// note in dialog.jsx.
const Separator = forwardRef(function Separator(
  { className, orientation = "horizontal", decorative = true, ...props },
  ref,
) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        // bg-input, not bg-border — --border is tuned to read as a crisp
        // outer edge against a colorful blurred backdrop (see dialog.jsx),
        // which makes it nearly invisible used as an internal divider on a
        // popover/card's own near-white (or, in dark mode, near-black)
        // surface. --input's darker/lighter-from-center rgba actually
        // contrasts against the surface it's drawn on in both themes.
        "shrink-0 bg-input data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
});

export { Separator };
