import Foundation
import XCTest
@testable import HomerunKit

/// The shared JSON vectors in `packages/protocol/vectors`, found by walking up from this file.
enum Vectors {
  static let dir: URL = {
    var u = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while u.path != "/" {
      let v = u.appendingPathComponent("packages/protocol/vectors")
      if FileManager.default.fileExists(atPath: v.path) { return v }
      u = u.deletingLastPathComponent()
    }
    fatalError("packages/protocol/vectors not found")
  }()

  static func load(_ name: String) throws -> JSON {
    try JSON.parse(Data(contentsOf: dir.appendingPathComponent("\(name).json")))
  }
}

func hex(_ j: JSON?) throws -> Data { try Bytes.fromHex(j?.string ?? "") }
