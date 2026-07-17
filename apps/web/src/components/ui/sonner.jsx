import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner } from "sonner";
import { useColorScheme } from "@/lib/colorScheme";

// The CLI-generated version of this file reads next-themes' useTheme() —
// this app has its own dark-mode mechanism (data-theme on <html>, driven by
// ColorSchemeProvider), so it reads that instead. See the note in
// AppHeader.jsx for the app's dark-mode wiring in general.
const Toaster = ({ ...props }) => {
  const { resolved } = useColorScheme();

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        // The approved design mockup's glass surface — same recipe as
        // dialog.jsx/popover.jsx, denser --popover background since a toast
        // is small and text-dense.
        classNames: {
          toast:
            "rounded-panel! border! bg-popover! text-popover-foreground! shadow-[var(--shadow-panel),0_0_0_1px_var(--glass-border-outer)]! backdrop-blur-(--glass-blur)! backdrop-saturate-[1.4]!",
          description: "text-muted-foreground!",
          actionButton:
            "bg-primary! text-primary-foreground! hover:bg-primary/90!",
          cancelButton:
            "bg-transparent! text-muted-foreground! hover:bg-accent!",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
