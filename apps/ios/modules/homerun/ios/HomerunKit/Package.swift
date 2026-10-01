// swift-tools-version:5.9
import PackageDescription

// HomerunKit: the iPhone's native protocol code (§9.7, §9.8). Compiled into the app (through the
// local Expo module's podspec) and into the Notification Service Extension from these sources, and
// tested here with `swift test` against the same JSON vectors as the TypeScript implementation.
let package = Package(
  name: "HomerunKit",
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: [.library(name: "HomerunKit", targets: ["HomerunKit"])],
  targets: [
    .target(name: "HomerunKit", path: "Sources/HomerunKit"),
    .testTarget(name: "HomerunKitTests", dependencies: ["HomerunKit"], path: "Tests/HomerunKitTests"),
  ]
)
