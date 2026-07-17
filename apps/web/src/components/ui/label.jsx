import { forwardRef } from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// forwardRef so this can be an asChild/Slot target under React 18 — see the
// note in dialog.jsx.
const Label = forwardRef(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export { Label };
