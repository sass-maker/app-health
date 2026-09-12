// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AppHealth",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "AppHealth", targets: ["AppHealth"]),
        .executable(name: "AppHealthCanary", targets: ["AppHealthCanary"]),
    ],
    targets: [
        .target(name: "AppHealth"),
        .executableTarget(name: "AppHealthCanary", dependencies: ["AppHealth"]),
        .testTarget(name: "AppHealthTests", dependencies: ["AppHealth"]),
    ],
    swiftLanguageModes: [.v6]
)
