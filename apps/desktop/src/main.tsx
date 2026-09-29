import { mount } from "./app";
import { tauriPlatform } from "./platform/tauri";
import "./styles.css";

mount(tauriPlatform(), document.getElementById("root")!);
