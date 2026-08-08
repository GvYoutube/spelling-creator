import { Button } from "./ui/button.jsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import { cn } from "../lib/utils.js";

// Small icon-button + tooltip, used throughout the editor's block/section
// controls (move up/down/delete, etc.) — wrapped in a <span> so the tooltip
// still shows while the button is disabled (a plain disabled <button>
// doesn't fire pointer events at all).
//
// `tooltip` doubles as the accessible name. A tooltip alone labels these
// buttons for nobody but a mouse user: touch devices have no hover, so on a
// phone every block control was an unlabelled icon, and assistive tech got
// nothing either (the lucide glyph carries no text). The aria-label is
// overridable for the rare caller wanting a longer spoken name than the
// tooltip's text.
//
// Sizing: 40px on touch, shrinking to the original 32px only on a wide screen
// *with a fine pointer*. 32px is under both Apple's 44pt and Material's 48dp
// minimum targets, and these sit in rows of three to five buttons with only 4px
// between them — comfortably mis-tappable on a phone.
//
// Gated on `pointer-fine` as well as `sm` because width alone doesn't imply a
// mouse: a tablet is 640px+ and still finger-driven, so `sm:size-8` on its own
// handed every tablet the 32px targets this exists to avoid. The two variants
// are stacked (shrink only when both hold) rather than written as a competing
// `pointer-coarse:size-10` override, so there's no reliance on which media
// query Tailwind happens to emit last.
export default function IconActionButton({
  tooltip,
  disabled,
  destructive,
  className,
  ...props
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={tooltip}
            disabled={disabled}
            className={cn(
              "size-10 sm:pointer-fine:size-8",
              destructive &&
                "text-destructive hover:bg-destructive/10 hover:text-destructive",
              className,
            )}
            {...props}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
