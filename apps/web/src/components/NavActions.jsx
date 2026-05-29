// Right-hand AppBar cluster shared by every page: a link to the lesson hub and
// an account control that reflects the Supabase auth state (sign in / sign out).
// Rendered with `color="inherit"` so it sits naturally inside the coloured AppBar.

import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import CollectionsBookmarkIcon from "@mui/icons-material/CollectionsBookmark";
import AccountCircleIcon from "@mui/icons-material/AccountCircle";
import { useAuth } from "../lib/auth.jsx";

const inheritBorder = { borderColor: "rgba(255,255,255,0.6)" };

export default function NavActions({ current }) {
  const { enabled, user, signOut } = useAuth();
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState(null);
  const menuOpen = Boolean(anchorEl);

  const handleSignOut = async () => {
    setAnchorEl(null);
    await signOut();
  };

  return (
    <>
      {current !== "hub" && (
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
      )}

      {!enabled ? null : user ? (
        <>
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
        current !== "login" && (
          <Button
            color="inherit"
            variant="outlined"
            onClick={() => navigate("/login")}
            startIcon={<AccountCircleIcon />}
            sx={inheritBorder}
          >
            Sign in
          </Button>
        )
      )}
    </>
  );
}
