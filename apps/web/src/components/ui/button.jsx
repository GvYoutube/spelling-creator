import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // border-0 is explicit (only the outline variant sets its own border) —
  // without it every other variant shows the browser's default 2px outset
  // button border while Tailwind preflight is off (native <button>s aren't
  // reset). Subtle on most backgrounds, but glaring as a white ridge on
  // AppHeader's colored surface. See the memory on this.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border-0 text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        // text-foreground is explicit on outline/ghost (every other variant
        // sets its own text-*) — without it, native <button> elements don't
        // inherit color from ancestors at all while Tailwind preflight is
        // off (browsers default form-element text to the UA "buttontext"
        // system color — black — regardless of our dark-mode tokens). Found
        // as a black (invisible) dialog close icon and ghost button label in
        // dark mode. See the memory on this.
        outline:
          "border bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        // bg-transparent is explicit too (every other variant sets its own
        // bg-*) — without it these show the browser's default gray button
        // chrome while preflight is off.
        ghost:
          "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// forwardRef so Button can be an asChild target of Radix components (Dialog,
// Popover, Tooltip triggers, etc.) — React 18 requires it explicitly (React
// 19 accepts ref as a plain prop, but this project is still on 18).
const Button = forwardRef(function Button(
  {
    className,
    variant = "default",
    size = "default",
    asChild = false,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { Button, buttonVariants };
