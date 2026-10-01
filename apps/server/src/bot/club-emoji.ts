import { customEmoji } from "gramio";

const CLUB_EMOJI_IDS = [
  "5228679588283975985",
  "5231260537211356552",
  "5231302881293925719",
  "5229069502594975656",
  "5231227203970170000",
  "5231130885033591418",
  "5230978344975106344",
];

export const clubEmoji = () =>
  customEmoji("🏁", CLUB_EMOJI_IDS[Math.floor(Math.random() * CLUB_EMOJI_IDS.length)]!);
