import { Button } from "./ui/button.jsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import { cn } from "../lib/utils.js";

// Small icon-button + tooltip, used throughout the editor's block/section
// controls (move up/down/delete, etc.) — wrapped in a <span> so the tooltip
// still shows while the button is disabled (a plain disabled <button>
// doesn't fire pointer events at all).
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
            disabled={disabled}
            className={cn(
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
