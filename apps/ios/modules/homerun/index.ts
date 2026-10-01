import { requireNativeModule } from "expo";
import type { HomerunNative } from "../../src/native";

/** The Swift module (`ios/Bridge/HomerunModule.swift`); its shape is `HomerunNative`. */
export const Homerun = requireNativeModule<HomerunNative>("Homerun");
