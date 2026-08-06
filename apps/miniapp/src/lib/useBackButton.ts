import { useEffect } from "react";
import { useNavigate } from "react-router";

import { backButton } from "../telegram";

/** Shows the native Telegram back button while a sub-screen is mounted. */
export const useBackButton = (fallback = "/"): void => {
  const navigate = useNavigate();
  useEffect(
    () =>
      backButton.show(() => {
        if (window.history.length > 1) navigate(-1);
        else navigate(fallback);
      }),
    [navigate, fallback],
  );
};
