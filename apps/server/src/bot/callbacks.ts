import { CallbackData } from "gramio";

export const offerCallback = new CallbackData("offer").number("id");
export const joinCallback = new CallbackData("join").number("id");
