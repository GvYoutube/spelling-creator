import { useState } from "react";
import { StarIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = { sm: "size-4", default: "size-5" };

// A single star, drawn as a muted background star with a --focus-colored
// foreground star clipped to `fill` (0–1) on top — the two-layer trick that
// lets a read-only rating show a fractional average (e.g. 4.3 stars) without
// SVG path slicing.
function Star({ fill, sizeClass }) {
  return (
    <span className={cn("relative inline-block shrink-0", sizeClass)}>
      <StarIcon
        className={cn("absolute inset-0", sizeClass, "text-muted-foreground")}
      />
      <span
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${fill * 100}%` }}
      >
        <StarIcon className={cn(sizeClass, "fill-focus text-focus")} />
      </span>
    </span>
  );
}

/**
 * A 1–max star rating — interactive (click to set) or read-only (supports a
 * fractional `value` for showing an average). API deliberately mirrors MUI's
 * Rating (value/onChange/readOnly/size) so swapping either call site over is
 * a near-direct prop translation.
 */
export function StarRating({
  value,
  onChange,
  readOnly = false,
  disabled = false,
  max = 5,
  size = "default",
  className,
  "aria-label": ariaLabel = "rating",
}) {
  const [hover, setHover] = useState(null);
  const interactive = !readOnly && !disabled;
  const display = interactive ? (hover ?? value ?? 0) : (value ?? 0);
  const sizeClass = SIZES[size] || SIZES.default;

  if (!interactive) {
    return (
      <div
        role="img"
        aria-label={`${ariaLabel}: ${display} out of ${max}`}
        className={cn("inline-flex items-center gap-0.5", className)}
      >
        {Array.from({ length: max }, (_, i) => (
          <Star
            key={i}
            fill={Math.max(0, Math.min(1, display - i))}
            sizeClass={sizeClass}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-0.5", className)}
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: max }, (_, i) => {
        const starValue = i + 1;
        return (
          <button
            key={starValue}
            type="button"
            role="radio"
            aria-checked={value === starValue}
            aria-label={`${starValue} star${starValue === 1 ? "" : "s"}`}
            onClick={() => onChange?.(starValue)}
            onMouseEnter={() => setHover(starValue)}
            className="cursor-pointer rounded-sm border-0 bg-transparent p-0.5 text-muted-foreground transition-colors hover:text-focus"
          >
            <Star fill={starValue <= display ? 1 : 0} sizeClass={sizeClass} />
          </button>
        );
      })}
    </div>
  );
}
