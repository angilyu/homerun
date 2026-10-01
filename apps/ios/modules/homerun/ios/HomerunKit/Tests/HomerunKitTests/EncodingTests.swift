import XCTest
@testable import HomerunKit

final class EncodingTests: XCTestCase {
  func testBase64url() throws {
    let v = try Vectors.load("encoding")
    for c in v["base64url"]!.array! {
      let s = c["b64url"]!.string!
      if c["hex"] == .null {
        XCTAssertThrowsError(try Bytes.fromB64url(s), "should refuse \(s)")
      } else {
        let bytes = try hex(c["hex"])
        XCTAssertEqual(Bytes.b64url(bytes), s)
        XCTAssertEqual(try Bytes.fromB64url(s), bytes)
      }
    }
  }

  func testFramed() throws {
    let v = try Vectors.load("encoding")
    for c in v["framed"]!.array! {
      let parts = c["parts"]!.array!.map { FramedPart.string($0.string!) }
      XCTAssertEqual(Bytes.hex(try Bytes.framed(parts)), c["hex"]!.string!)
    }
  }

  func testJSONRoundTrip() throws {
    let j = try JSON.parse(#"{"a":[1,2.5,"x\n\"y",true,null],"b":{"c":-3}}"#)
    XCTAssertEqual(try JSON.parse(j.serialized), j)
    XCTAssertEqual(JSON.object([("k", .string("é\u{1}"))]).serialized, "{\"k\":\"é\\u0001\"}")
    XCTAssertThrowsError(try JSON.parse(Data([0xff, 0xfe])))
  }
}
