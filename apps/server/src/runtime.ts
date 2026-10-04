import { Layer, ManagedRuntime } from "effect";
import { db } from "./db";
import { Database } from "./services";

/** Where HTTP handlers, bot updates, the sweeper and boot hand their actions to Effect. */
export const runtime = ManagedRuntime.make(Layer.succeed(Database, db));
