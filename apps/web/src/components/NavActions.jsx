// Right-hand AppBar cluster shared by every page: a link to the lesson hub and
// an account control that reflects the Supabase auth state (sign in / sign out).
// Signed-in users also get a notification bell. Rendered with `color="inherit"`
// so it sits naturally inside the coloured AppBar.

import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import CollectionsBookmarkIcon from "@mui/icons-material/CollectionsBookmark";
import AccountCircleIcon from "@mui/icons-material/AccountCircle";
import { useAuth } from "../lib/auth.jsx";
import NotificationBell from "./NotificationBell.jsx";

const inheritBorder = { borderColor: "rgba(255,255,255,0.6)" };

export default function NavActions({ current }) {
  const { enabled, user, signOut } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  // On narrow screens the AppBar can't fit full text buttons, so the hub and
  // sign-in links collapse to icon-only buttons (the account control is already
  // an icon).
  const compact = useMediaQuery(theme.breakpoints.down("md"));
  const [anchorEl, setAnchorEl] = useState(null);
  const menuOpen = Boolean(anchorEl);

  const handleSignOut = async () => {
    setAnchorEl(null);
    await signOut();
  };

  return (
    <>
      {current !== "hub" &&
        (compact ? (
          <Tooltip title="Lesson hub">
            <IconButton
              color="inherit"
              component={RouterLink}
              to="/hub"
              aria-label="lesson hub"
            >
              <CollectionsBookmarkIcon />
            </IconButton>
          </Tooltip>
        ) : (
          <Button
            color="inherit"
            variant="outlined"
            component={RouterLink}
            to="/hub"
            startIcon={<CollectionsBookmarkIcon />}
            sx={inheritBorder}
          >
            Lesson hub
          </Button>
        ))}

      {!enabled ? null : user ? (
        <>
          <NotificationBell />
          <Tooltip title={user.email || "Account"}>
            <IconButton
              color="inherit"
              onClick={(e) => setAnchorEl(e.currentTarget)}
              aria-label="account menu"
            >
              <AccountCircleIcon />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={anchorEl}
            open={menuOpen}
            onClose={() => setAnchorEl(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <MenuItem disabled>
              <ListItemText
                primary="Signed in"
                secondary={user.email}
                secondaryTypographyProps={{ sx: { wordBreak: "break-all" } }}
              />
            </MenuItem>
            <Divider />
            <MenuItem onClick={handleSignOut}>Sign out</MenuItem>
          </Menu>
        </>
      ) : (
        <>
          <Tooltip title="Account">
            <IconButton
              color="inherit"
              onClick={(e) => setAnchorEl(e.currentTarget)}
              aria-label="account menu"
            >
              <AccountCircleIcon />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={anchorEl}
            open={menuOpen}
            onClose={() => setAnchorEl(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <MenuItem disabled>
              <ListItemText
                primary="Signed out"
                secondary=""
                secondaryTypographyProps={{ sx: { wordBreak: "break-all" } }}
              />
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                setAnchorEl(null);
                navigate("/login");
              }}
            >
              Sign in
            </MenuItem>
          </Menu>
        </>
      )}
    </>
  );
}
