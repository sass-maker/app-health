// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AppHealth",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "AppHealth", targets: ["AppHealth"]),
    ],
    targets: [
        .target(
            name: "AppHealth",
            path: "packages/swift/Sources/AppHealth"
        ),
        .testTarget(
            name: "AppHealthTests",
            dependencies: ["AppHealth"],
            path: "packages/swift/Tests/AppHealthTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
