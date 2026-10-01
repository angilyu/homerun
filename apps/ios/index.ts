// The polyfills must run before anything imports @noble or calls crypto.randomUUID.
import "./src/polyfills";
import { registerRootComponent } from "expo";
import { App } from "./src/ui/App";

registerRootComponent(App);
