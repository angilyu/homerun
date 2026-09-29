import { mount } from "../../src/app";
import { bridgePlatform } from "../../src/platform/bridge";
import "../../src/styles.css";

// The production views and state layer; only the platform differs (plan §9).
mount(bridgePlatform(`ws://${location.host}/bridge`), document.getElementById("root")!);
